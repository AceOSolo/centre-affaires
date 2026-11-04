import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'

import { DB_UNIQUE_VIOLATION, dbErrorCode } from '../../db/errors.ts'
import { withTenant, type Transaction } from '../../db/index.ts'
import { ouvrirBasesDeTest, raisonDeSaut, type TestDatabases } from '../../db/test-support.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { addMonthsToIsoMonth, monthRangeUtc, todayIsoDate } from '../../lib/dates.ts'
import { runForTenant } from '../../lib/tenant.ts'
import { uuidv7 } from '../../lib/uuid.ts'
import type { ClientAccount } from '../clients/comptes.ts'
import { toutVider } from '../clients/test-support.ts'
import { completeForwardRequest, recordScanRequestDone, requestForward, requestScan } from '../courrier/demandes-queries.ts'
import type { StoredScan } from '../courrier/queries.ts'
import { toDolibarrConsumption } from './consommations.ts'
import { consumptionCounts, listConsumptionsForCrm, markConsumptionSent, syncConsumptions } from './consommations-queries.ts'

/**
 * Le registre des consommations en base (ADR 066), sous l'identité
 * applicative :
 *
 * - chaque nature est prise une fois, et seulement prête : réservation
 *   terminée, sans devis vivant ; courrier d'un mois clos ; pages au-delà de
 *   celles comprises ; réexpédition aux frais relevés ;
 * - rien d'antérieur à la date de départ, rien en double au second passage ;
 * - une source annulée ou modifiée annule sa consommation, qu'une nouvelle
 *   remplace ; l'accusé de réception est rejouable ;
 * - le centre est filtré partout ; la base refuse qu'un instantané se
 *   réécrive ou se supprime (`CA018`).
 */
describe('consommations facturables, en base', { skip: raisonDeSaut }, () => {
  const PARIS = 'Europe/Paris'
  const AUTRE = '01999f00-0000-7000-8000-0000000000e7'
  const ACCUEIL = '01a00000-0000-7000-8000-00000010ad01'
  const DURAND = '01a00000-0000-7000-8000-00000010c001'
  const JEANNE = '01a00000-0000-7000-8000-00000010c011'
  const SALLE = '01a00000-0000-7000-8000-00000010a001'
  const CAMION = '01a00000-0000-7000-8000-00000010a002'
  const LYON_CLIENT = '01a00000-0000-7000-8000-00000010c101'
  const LYON_SALLE = '01a00000-0000-7000-8000-00000010a101'

  let bases: TestDatabases
  let pagesComprises: number

  const durand: ClientAccount[] = [{ memberId: JEANNE, clientId: DURAND, clientName: 'Atelier Durand' }]
  const asTenant = <T>(run: (tx: Transaction) => Promise<T>, tenant = DEFAULT_TENANT_ID) =>
    withTenant(tenant, run, bases.app.db)
  const brut = async <T>(requete: string, params: unknown[] = []) =>
    ((await bases.owner.client.query(requete, params)) as unknown as [T[]])[0]

  // Le mois dernier (M1) est clos ; celui d'avant (M2) précède la date de départ.
  const M1 = addMonthsToIsoMonth(todayIsoDate(PARIS).slice(0, 7), -1)
  const M2 = addMonthsToIsoMonth(todayIsoDate(PARIS).slice(0, 7), -2)

  /** Le mois suivant : le courrier de ce mois-ci y est clos. */
  const moisProchain = () =>
    new Date(monthRangeUtc(addMonthsToIsoMonth(todayIsoDate(PARIS).slice(0, 7), 1), PARIS).startsAt.getTime() + 86_400_000)

  const reservation = async (overrides: {
    debut: string
    fin: string
    client?: string | null
    ressource?: string
    statut?: 'confirmed' | 'pending'
    devis?: boolean
  }) => {
    const id = uuidv7()
    await asTenant((tx) =>
      tx.execute(sql`
        insert into bookings (id, resource_id, client_id, channel, status, starts_at, ends_at, title,
                              quote_unit, quote_quantity, quote_unit_price_cents, quote_vat_rate_bp, quote_currency, quoted_at)
        values (${id}, ${overrides.ressource ?? SALLE}, ${overrides.client === undefined ? DURAND : overrides.client}, 'staff',
                ${overrides.statut ?? 'confirmed'}, ${overrides.debut}, ${overrides.fin}, 'Réunion',
                ${overrides.devis === false ? null : 'half_day'}, ${overrides.devis === false ? null : 1},
                ${overrides.devis === false ? null : 9000}, ${overrides.devis === false ? null : 2000},
                ${overrides.devis === false ? null : 'EUR'}, ${overrides.devis === false ? null : sql`current_timestamp(3)`})`),
    )
    return id
  }

  const pliOuvert = async (ouvertLe: string) => {
    const id = uuidv7()
    await asTenant((tx) =>
      tx.execute(sql`
        insert into mail_items (id, client_id, kind, received_at, status, opened_at, opened_by)
        values (${id}, ${DURAND}, 'lettre', ${ouvertLe}, 'opened', ${ouvertLe}, ${ACCUEIL})`),
    )
    return id
  }

  const contenu = async (pli: string, pages: number) => {
    const id = uuidv7()
    await asTenant((tx) =>
      tx.execute(sql`
        insert into mail_scans (id, mail_item_id, side, storage_key, content_type, byte_size, page_count)
        values (${id}, ${pli}, 'content', ${`courrier/test/${id}.pdf`}, 'application/pdf', 5, ${pages})`),
    )
    return id
  }

  const depose = (nom: string): StoredScan[] => [
    {
      side: 'content',
      key: `courrier/test/conso-${nom}.pdf`,
      scan: { bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]), contentType: 'application/pdf' },
      encryptionKeyVersion: 1,
    },
  ]

  /** Une numérisation ou une réexpédition faite maintenant, sur un pli ouvert le 15 du mois dernier. */
  const demandeFaite = async (kind: 'scan' | 'forward', postageCents: number | null = null) => {
    const item = await pliOuvert(`${M1}-15 08:00:00`)
    const outcome =
      kind === 'scan'
        ? await requestScan(item, durand, null)
        : await requestForward(
            item,
            durand,
            { recipient: 'Jeanne Durand', line1: '12 rue des Lilas', line2: null, postalCode: '38000', city: 'Grenoble', country: 'FR' },
            null,
          )
    assert.ok(outcome.ok)
    if (kind === 'scan') await recordScanRequestDone(outcome.requestId, ACCUEIL, depose(outcome.requestId))
    else await completeForwardRequest(outcome.requestId, ACCUEIL, { trackingNumber: null, postageCents })
    return { item, request: outcome.requestId }
  }

  const registre = () =>
    brut<{ id: string; nature: string; source_id: string; status: string; quantity: number; crm_id: string | null; cancellation_reason: string | null; tenant_id: string }>(
      'select id, nature, source_id, status, quantity, crm_id, cancellation_reason, tenant_id from crm_consumptions order by created_at, id',
    )

  const depart = (jour: string | null, tenant = DEFAULT_TENANT_ID) =>
    bases.owner.client.query(
      `insert into crm_connections (id, tenant_id, connector, enabled_flows, consumptions_from)
       values (uuid(), ?, 'dolibarr', json_array('quotes', 'products', 'consumptions'), ?)
       on duplicate key update consumptions_from = values(consumptions_from)`,
      [tenant, jour],
    )

  before(async () => {
    bases = await ouvrirBasesDeTest()
    ;(globalThis as { database?: unknown }).database = bases.app
    const [[tenant]] = (await bases.owner.client.query('select mail_opening_included_pages as pages from tenants where id = ?', [
      DEFAULT_TENANT_ID,
    ])) as unknown as [[{ pages: number }]]
    pagesComprises = tenant.pages
  })

  beforeEach(async () => {
    await toutVider(bases.owner)
    await bases.owner.client.query('delete from tenants where id = ?', [AUTRE])
    await bases.owner.client.query(
      `insert into tenants (id, name, slug) values (?, 'Centre de Lyon', 'centre-de-lyon-conso')`,
      [AUTRE],
    )
    await bases.owner.client.query('update tenants set mail_opening_included_pages = 5 where id = ?', [DEFAULT_TENANT_ID])
    await asTenant(async (tx) => {
      await tx.execute(sql`insert into staff_members (id, email, role) values (${ACCUEIL}, 'accueil@centre.exemple.fr', 'admin')`)
      await tx.execute(sql`insert into clients (id, name, siret, status) values (${DURAND}, 'Atelier Durand', '12345678900012', 'active')`)
      await tx.execute(sql`
        insert into client_members (id, client_id, email, full_name, auth_user_id)
        values (${JEANNE}, ${DURAND}, 'jeanne@durand.exemple.fr', 'Jeanne Durand', 'u-jeanne')`)
      await tx.execute(sql`
        insert into resources (id, resource_type, code, name) values
          (${SALLE}, 'salle', 'SAL-MB', 'Salle Mont Blanc'),
          (${CAMION}, 'vehicule', 'CAM-1', 'Camion 12 m³')`)
    })
    await depart(`${M1}-01`)
  })

  after(async () => {
    await toutVider(bases.owner)
    await bases.owner.client.query('delete from tenants where id = ?', [AUTRE])
    await bases.owner.client.query('update tenants set mail_opening_included_pages = ? where id = ?', [
      pagesComprises,
      DEFAULT_TENANT_ID,
    ])
    delete (globalThis as { database?: unknown }).database
    await bases?.fermer()
  })

  it('prend chaque nature une fois, prête, et rien en double au second passage', async () => {
    const salle = await reservation({ debut: `${M1}-10 07:00:00`, fin: `${M1}-10 11:00:00` })
    const camion = await reservation({ debut: `${M1}-11 06:00:00`, fin: `${M1}-11 16:00:00`, ressource: CAMION, devis: false })
    // Pas des consommations : passée par un devis, sans client, en attente, à venir.
    const parDevis = await reservation({ debut: `${M1}-12 07:00:00`, fin: `${M1}-12 11:00:00` })
    await asTenant((tx) =>
      tx.execute(sql`
        insert into proposals (id, number, product, channel, client_id, booking_id, answers)
        values (${uuidv7()}, 'DV-TEST-0001', 'espace', 'staff', ${DURAND}, ${parDevis}, json_object())`),
    )
    await reservation({ debut: `${M1}-13 07:00:00`, fin: `${M1}-13 11:00:00`, client: null })
    await reservation({ debut: `${M1}-14 07:00:00`, fin: `${M1}-14 11:00:00`, statut: 'pending' })
    // À venir même au passage du mois prochain.
    const bientot = new Date(Date.now() + 60 * 86_400_000)
    const enSql = (date: Date) => date.toISOString().slice(0, 19).replace('T', ' ')
    await reservation({ debut: enSql(bientot), fin: enSql(new Date(bientot.getTime() + 3_600_000)) })

    const ouvert = await pliOuvert(`${M1}-20 09:00:00`)
    const scanDePages = await contenu(ouvert, 8)
    const peuDePages = await contenu(await pliOuvert(`${M1}-21 09:00:00`), 4)
    const numerisation = await demandeFaite('scan')
    const reexpedition = await demandeFaite('forward', 450)
    const sansFrais = await demandeFaite('forward', null)

    const passage = await syncConsumptions(moisProchain())
    assert.equal(passage.started, true)
    assert.equal(passage.from, `${M1}-01`)
    assert.equal(passage.waitingPostage, 1)

    const lignes = await registre()
    const par = (nature: string) => lignes.filter((ligne) => ligne.nature === nature)
    assert.deepEqual(par('booking').map((l) => l.source_id).sort(), [salle, camion].sort())
    // Les cinq plis ouverts : deux d'ici, trois sous les demandes.
    assert.equal(par('mail_opening').length, 5)
    assert.deepEqual(par('mail_pages').map((l) => [l.source_id, l.quantity]), [[scanDePages, 3]])
    assert.ok(!lignes.some((l) => l.source_id === peuDePages))
    assert.deepEqual(par('mail_scan').map((l) => l.source_id), [numerisation.request])
    assert.deepEqual(par('mail_forward').map((l) => l.source_id), [reexpedition.request])
    assert.ok(!lignes.some((l) => l.source_id === sansFrais.request))
    assert.ok(lignes.every((l) => l.status === 'ready' && l.tenant_id === DEFAULT_TENANT_ID))

    // Rejoué : rien de plus.
    const second = await syncConsumptions(moisProchain())
    assert.equal(second.created, 0)
    assert.equal(second.cancelled, 0)
    assert.equal((await registre()).length, lignes.length)

    // Les frais relevés après coup : la réexpédition entre au passage suivant.
    await bases.owner.client.query('update mail_requests set postage_cents = 0, postage_currency = ? where id = ?', [
      'EUR',
      sansFrais.request,
    ])
    assert.equal((await syncConsumptions(moisProchain())).created, 1)
  })

  it('ne prend pas le courrier du mois en cours, ni rien d’antérieur à la date de départ', async () => {
    await demandeFaite('scan')
    await reservation({ debut: `${M2}-20 07:00:00`, fin: `${M2}-20 11:00:00` })
    await pliOuvert(`${M2}-25 09:00:00`)
    // Maintenant : le mois de la numérisation n'est pas clos ; M2 précède le départ.
    await syncConsumptions(new Date())
    assert.deepEqual(
      (await registre()).map((l) => l.nature),
      ['mail_opening'],
      'seul le pli ouvert le mois dernier, sous la demande, est d’un mois clos',
    )

    // Sans date de départ, rien n'est pris.
    await toutVider(bases.owner)
    await asTenant((tx) => tx.execute(sql`insert into clients (id, name, status) values (${DURAND}, 'Atelier Durand', 'active')`))
    await asTenant((tx) => tx.execute(sql`insert into staff_members (id, email, role) values (${ACCUEIL}, 'accueil@centre.exemple.fr', 'admin')`))
    await depart(null)
    await pliOuvert(`${M1}-20 09:00:00`)
    const passage = await syncConsumptions(moisProchain())
    assert.equal(passage.started, false)
    assert.deepEqual(await registre(), [])
  })

  it('annule ce dont la source est annulée ou modifiée, et le remplace ; la référence du CRM reste', async () => {
    const annulee = await reservation({ debut: `${M1}-10 07:00:00`, fin: `${M1}-10 11:00:00` })
    const deplacee = await reservation({ debut: `${M1}-17 07:00:00`, fin: `${M1}-17 11:00:00` })
    const pli = await pliOuvert(`${M1}-20 09:00:00`)
    await syncConsumptions(moisProchain())
    const [premiere] = (await registre()).filter((l) => l.source_id === annulee)
    assert.deepEqual(await markConsumptionSent(premiere!.id, { id: '1834', ref: 'FA2610-0001' }), { result: 'ok' })

    await bases.owner.client.query(
      `update bookings set status = 'cancelled', cancelled_at = current_timestamp(3), cancellation_reason = 'Client absent' where id = ?`,
      [annulee],
    )
    await bases.owner.client.query('update bookings set ends_at = ? where id = ?', [`${M1}-17 13:00:00`, deplacee])
    await bases.owner.client.query(`update mail_items set deleted_at = current_timestamp(3) where id = ?`, [pli])
    const passage = await syncConsumptions(moisProchain())
    assert.equal(passage.cancelled, 3)
    assert.equal(passage.created, 1)

    const lignes = await registre()
    const de = (source: string) => lignes.filter((l) => l.source_id === source).map((l) => [l.status, l.cancellation_reason, l.crm_id])
    assert.deepEqual(de(annulee), [['cancelled', 'Réservation annulée.', '1834']])
    assert.deepEqual(de(deplacee), [
      ['cancelled', 'Modifiée sur le site : remplacée par une nouvelle consommation.', null],
      ['ready', null, null],
    ])
    assert.deepEqual(de(pli), [['cancelled', 'Pli retiré (enregistré par erreur).', null]])

    // Dolibarr lit les annulées depuis son dernier passage, avec ce qu'il en avait repris.
    const annulees = await listConsumptionsForCrm('dolibarr', { status: 'cancelled', limit: 100 })
    const reprise = annulees.find((c) => c.crmId === '1834')
    assert.ok(reprise)
    const json = toDolibarrConsumption(reprise, PARIS)
    assert.equal(json.statut, 'cancelled')
    assert.equal(json.dolibarrRef, 'FA2610-0001')
    assert.ok(json.transmisLe && json.annuleLe)
  })

  it('accuse réception une fois, rejouable, et refuse une annulée ou un autre identifiant', async () => {
    await reservation({ debut: `${M1}-10 07:00:00`, fin: `${M1}-10 11:00:00` })
    await reservation({ debut: `${M1}-11 07:00:00`, fin: `${M1}-11 11:00:00` })
    await syncConsumptions(moisProchain())
    const [a, b] = await registre()

    assert.deepEqual(await markConsumptionSent(a!.id, { id: '900', ref: null }), { result: 'ok' })
    assert.deepEqual(await markConsumptionSent(a!.id, { id: '900', ref: null }), { result: 'ok' })
    const autre = await markConsumptionSent(a!.id, { id: '901', ref: null })
    assert.equal(autre.result, 'refuse')
    assert.match((autre as { message: string }).message, /900/)
    assert.deepEqual(await markConsumptionSent(uuidv7(), { id: '902', ref: null }), { result: 'introuvable' })

    await bases.owner.client.query(
      `update bookings set status = 'cancelled', cancelled_at = current_timestamp(3) where id = ?`,
      [b!.source_id],
    )
    await syncConsumptions(moisProchain())
    const annulee = await markConsumptionSent(b!.id, { id: '903', ref: null })
    assert.equal(annulee.result, 'refuse')
    assert.match((annulee as { message: string }).message, /ne pas la facturer/)

    assert.deepEqual((await listConsumptionsForCrm('dolibarr', { status: 'ready', limit: 100 })).map((c) => c.id), [])
    assert.deepEqual((await listConsumptionsForCrm('dolibarr', { status: 'sent', limit: 100 })).map((c) => c.id), [a!.id])
    assert.deepEqual(await consumptionCounts(), { ready: 0, sent: 1, cancelled: 1 })
  })

  it('donne au CRM son identifiant du tiers, quand le tiers en vient', async () => {
    await reservation({ debut: `${M1}-10 07:00:00`, fin: `${M1}-10 11:00:00` })
    await bases.owner.client.query(
      `insert into crm_links (id, tenant_id, connector, entity, local_id, external_id) values (uuid(), ?, 'dolibarr', 'client', ?, '412')`,
      [DEFAULT_TENANT_ID, DURAND],
    )
    await syncConsumptions(moisProchain())
    const [ligne] = await listConsumptionsForCrm('dolibarr', { status: 'ready', limit: 10 })
    const json = toDolibarrConsumption(ligne!, PARIS)
    assert.deepEqual(json.tiers, { clientId: DURAND, dolibarrId: '412', nom: 'Atelier Durand', siret: '12345678900012' })
    assert.equal(json.reservation?.produitSite, 'salles')
    assert.equal(json.prix?.montantHtCentimes, 9000)
  })

  it('sert chaque centre pour lui seul', async () => {
    await reservation({ debut: `${M1}-10 07:00:00`, fin: `${M1}-10 11:00:00` })
    await asTenant(async (tx) => {
      await tx.execute(sql`insert into clients (id, tenant_id, name, status) values (${LYON_CLIENT}, ${AUTRE}, 'Lyon Conseil', 'active')`)
      await tx.execute(
        sql`insert into resources (id, tenant_id, resource_type, code, name) values (${LYON_SALLE}, ${AUTRE}, 'salle', 'LY-1', 'Salle Bellecour')`,
      )
      await tx.execute(sql`
        insert into bookings (tenant_id, resource_id, client_id, channel, starts_at, ends_at, title)
        values (${AUTRE}, ${LYON_SALLE}, ${LYON_CLIENT}, 'staff', ${`${M1}-10 07:00:00`}, ${`${M1}-10 11:00:00`}, 'Réunion')`)
    }, AUTRE)
    await depart(`${M1}-01`, AUTRE)

    await syncConsumptions(moisProchain())
    assert.deepEqual((await registre()).map((l) => l.tenant_id), [DEFAULT_TENANT_ID])
    const lyon = await runForTenant(AUTRE, () => syncConsumptions(moisProchain()))
    assert.equal(lyon.created, 1)
    const [, deLyon] = await registre()
    assert.equal(deLyon!.tenant_id, AUTRE)

    // Ni lu, ni repris pour un autre centre.
    assert.equal((await listConsumptionsForCrm('dolibarr', { status: 'ready', limit: 10 })).length, 1)
    assert.deepEqual(await markConsumptionSent(deLyon!.id, { id: '1', ref: null }), { result: 'introuvable' })
    assert.deepEqual(await runForTenant(AUTRE, () => markConsumptionSent(deLyon!.id, { id: '1', ref: null })), { result: 'ok' })
  })

  it('la base refuse qu’un instantané se réécrive, se supprime, ou qu’une source en ait deux vivantes', async () => {
    await reservation({ debut: `${M1}-10 07:00:00`, fin: `${M1}-10 11:00:00` })
    await syncConsumptions(moisProchain())
    const [ligne] = await registre()
    const refus = async (requete: string, params: unknown[]) => {
      await assert.rejects(
        asTenant((tx) => tx.execute(sql.raw(requete.replace(/\?/g, () => `'${String(params.shift())}'`)))),
        (error: unknown) => dbErrorCode(error) === 'CA018',
      )
    }
    await refus('update crm_consumptions set description = ? where id = ?', ['Autre chose', ligne!.id])
    await refus(`update crm_consumptions set status = 'sent' where id = ?`, [ligne!.id])
    await refus(`update crm_consumptions set status = 'cancelled' where id = ?`, [ligne!.id])
    await refus('delete from crm_consumptions where id = ?', [ligne!.id])

    await assert.rejects(
      asTenant((tx) =>
        tx.execute(sql`
          insert into crm_consumptions (tenant_id, nature, source_id, client_id, occurred_at, quantity, description, details, fingerprint)
          select tenant_id, nature, source_id, client_id, occurred_at, quantity, description, details, fingerprint
            from crm_consumptions where id = ${ligne!.id}`),
      ),
      (error: unknown) => dbErrorCode(error) === DB_UNIQUE_VIOLATION,
    )
    await assert.rejects(
      asTenant((tx) =>
        tx.execute(sql`
          insert into crm_consumptions (tenant_id, nature, source_id, client_id, occurred_at, quantity, description, details, fingerprint, status, crm_id, sent_at)
          values (${DEFAULT_TENANT_ID}, 'booking', ${uuidv7()}, ${DURAND}, current_timestamp(3), 1, 'x', json_object(), repeat('a', 64), 'sent', '1', current_timestamp(3))`),
      ),
      (error: unknown) => dbErrorCode(error) === 'CA018',
    )
  })
})
