import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'

import { dbErrorCode } from '../../../../db/errors.ts'
import { withTenant } from '../../../../db/index.ts'
import { ouvrirBasesDeTest, raisonDeSaut, viderTables, type TestDatabases } from '../../../../db/test-support.ts'
import { DEFAULT_TENANT_ID } from '../../../../db/tenants.ts'
import { uuidv7 } from '../../../../lib/uuid.ts'
import type { ClientAccount } from '../../../../modules/clients/comptes.ts'
import { toutVider } from '../../../../modules/clients/test-support.ts'
import { invoicesFlowEnabled, listReceivedInvoicesForAccounts } from '../../../../modules/crm/factures-queries.ts'
import { saveCrmFlows } from '../../../../modules/crm/queries.ts'
import { receiveFacture } from './recevoir.ts'

/**
 * Les factures émises par Dolibarr, reçues pour l'espace client (ADR 081),
 * route telle que Next l'appelle, contre la base de test :
 *
 * - sans jeton valide, la route n'existe pas (404) ; le flux naît coupé (403) ;
 * - ouvert, une facture se crée, se rejoue sans rien changer, se met à jour,
 *   se retire de l'espace client et y revient ; le tiers doit être reçu avant ;
 * - chaque entreprise ne voit que ses factures, jamais une facture retirée ;
 * - la base refuse de supprimer une facture reçue ou de changer ce qui la
 *   désigne (`CA027`) ; le journal ne porte ni numéro ni montant.
 */
describe('API Dolibarr : factures émises', { skip: raisonDeSaut }, () => {
  const JETON = 'jeton+du/serveur=lot8'
  const saved = process.env.DOLIBARR_API_TOKEN
  const DURAND = '01a00000-0000-7000-8000-00000081c001'
  const PETIT = '01a00000-0000-7000-8000-00000081c002'
  let bases: TestDatabases
  let direction: string

  const durand: ClientAccount[] = [{ memberId: uuidv7(), clientId: DURAND, clientName: 'Atelier Durand' }]
  const petit: ClientAccount[] = [{ memberId: uuidv7(), clientId: PETIT, clientName: 'Studio Petit' }]

  const brut = async <T>(requete: string, params: unknown[] = []) =>
    ((await bases.owner.client.query(requete, params)) as unknown as [T[]])[0]

  const appel = (body: unknown, jeton: string | null = JETON) =>
    new Request('http://127.0.0.1:3100/api/dolibarr/factures', {
      method: 'POST',
      headers: {
        ...(jeton === null ? {} : { authorization: `Bearer ${jeton}` }),
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })

  const facture = {
    dolibarrId: '1834',
    tiersDolibarrId: '412',
    numero: 'FA2611-0042',
    statut: 'a_payer',
    date: '2026-11-30',
    echeance: '2026-12-30',
    montantHtCentimes: 12000,
    montantTtcCentimes: 14400,
    pdf: 'https://crm.exemple.fr/document.php?hashp=abc123',
  }

  const envoyer = async (body: unknown) => {
    const { response, changed } = await receiveFacture(appel(body))
    return { status: response.status, changed, body: (await response.json()) as Record<string, unknown> }
  }

  const relier = (clientId: string, dolibarrId: string) =>
    bases.owner.client.query(
      `insert into crm_links (id, tenant_id, connector, entity, local_id, external_id) values (uuid(), ?, 'dolibarr', 'client', ?, ?)`,
      [DEFAULT_TENANT_ID, clientId, dolibarrId],
    )

  before(async () => {
    bases = await ouvrirBasesDeTest()
    ;(globalThis as { database?: unknown }).database = bases.app
  })

  beforeEach(async () => {
    process.env.DOLIBARR_API_TOKEN = JETON
    await toutVider(bases.owner)
    direction = uuidv7()
    await bases.owner.client.query(
      `insert into staff_members (id, tenant_id, email, role) values (?, ?, 'direction@exemple.fr', 'super_admin')`,
      [direction, DEFAULT_TENANT_ID],
    )
    await bases.owner.client.query(
      `insert into clients (id, tenant_id, name, status) values (?, ?, 'Atelier Durand', 'active'), (?, ?, 'Studio Petit', 'active')`,
      [DURAND, DEFAULT_TENANT_ID, PETIT, DEFAULT_TENANT_ID],
    )
  })

  afterEach(() => {
    process.env.DOLIBARR_API_TOKEN = saved
  })

  after(async () => {
    await viderTables(bases.owner, 'crm_exchanges', 'crm_connections', 'staff_members')
    await toutVider(bases.owner)
    delete (globalThis as { database?: unknown }).database
    await bases?.fermer()
  })

  it('n’existe pas sans jeton valide, et naît coupée', async () => {
    assert.equal((await receiveFacture(appel(facture, null))).response.status, 404)
    assert.equal((await receiveFacture(appel(facture, 'faux'))).response.status, 404)
    assert.deepEqual(await brut('select id from crm_exchanges'), [])
    assert.equal(await invoicesFlowEnabled(), false)

    const coupe = await envoyer(facture)
    assert.equal(coupe.status, 403)
    assert.match(String(coupe.body.erreur), /Flux « Factures » désactivé.*Connexion au CRM/)
    assert.deepEqual(await brut('select id from crm_invoices'), [])
    assert.deepEqual(
      (await brut<{ flow: string; status_code: number }>('select flow, status_code from crm_exchanges')).map((ligne) => [
        ligne.flow,
        ligne.status_code,
      ]),
      [['invoices', 403]],
    )
  })

  it('ouverte : crée, rejoue, met à jour, retire, rend visible ; le tiers d’abord', async () => {
    await saveCrmFlows(['quotes', 'products', 'invoices'], direction)
    assert.equal(await invoicesFlowEnabled(), true)

    const sansTiers = await envoyer(facture)
    assert.equal(sansTiers.status, 409)
    assert.match(String(sansTiers.body.erreur), /Tiers 412 inconnu du site/)

    await relier(DURAND, '412')
    const creee = await envoyer(facture)
    assert.deepEqual([creee.status, creee.body.resultat, creee.changed], [200, 'cree', true])
    const [vue] = await listReceivedInvoicesForAccounts(durand)
    assert.deepEqual(
      {
        id: vue!.id,
        clientName: vue!.clientName,
        number: vue!.number,
        kind: vue!.kind,
        status: vue!.status,
        issuedOn: vue!.issuedOn,
        dueOn: vue!.dueOn,
        totalExclTaxCents: vue!.totalExclTaxCents,
        totalInclTaxCents: vue!.totalInclTaxCents,
        amountDueCents: vue!.amountDueCents,
        currency: vue!.currency,
        pdfUrl: vue!.pdfUrl,
      },
      {
        id: creee.body.factureId,
        clientName: 'Atelier Durand',
        number: 'FA2611-0042',
        kind: 'invoice',
        status: 'unpaid',
        issuedOn: '2026-11-30',
        dueOn: '2026-12-30',
        totalExclTaxCents: 12000,
        totalInclTaxCents: 14400,
        amountDueCents: null,
        currency: 'EUR',
        pdfUrl: 'https://crm.exemple.fr/document.php?hashp=abc123',
      },
    )

    const rejouee = await envoyer(facture)
    assert.deepEqual([rejouee.body.resultat, rejouee.changed, rejouee.body.factureId], ['inchange', false, creee.body.factureId])

    const payee = await envoyer({ ...facture, statut: 'payee' })
    assert.deepEqual([payee.body.resultat, payee.changed], ['modifie', true])
    assert.equal((await listReceivedInvoicesForAccounts(durand))[0]!.status, 'paid')

    const brouillon = await envoyer({ dolibarrId: '1834', statut: 'brouillon' })
    assert.equal(brouillon.body.resultat, 'retire')
    assert.deepEqual(await listReceivedInvoicesForAccounts(durand), [])
    assert.equal((await envoyer({ dolibarrId: '1834', supprime: true })).body.resultat, 'inchange')

    const revalidee = await envoyer({ ...facture, resteAPayerCentimes: 4400 })
    assert.equal(revalidee.body.resultat, 'modifie')
    assert.match(String(revalidee.body.message), /de nouveau visible/)
    assert.equal((await listReceivedInvoicesForAccounts(durand))[0]!.amountDueCents, 4400)

    assert.equal((await envoyer({ dolibarrId: '9999', supprime: true })).body.resultat, 'ignore')
    assert.equal((await envoyer({ ...facture, date: 'hier' })).status, 400)

    // Une seule ligne pour la facture, quel que soit le nombre d'envois.
    assert.deepEqual(await brut('select external_id from crm_invoices'), [{ external_id: '1834' }])
    // Le journal dit l'identifiant Dolibarr, jamais le numéro ni le montant.
    const journal = await brut<{ message: string | null }>(`select message from crm_exchanges where flow = 'invoices'`)
    assert.ok(journal.length >= 8)
    assert.ok(journal.every((ligne) => !ligne.message?.includes('FA2611') && !ligne.message?.includes('144')))
  })

  it('chaque entreprise ne voit que ses factures, les plus récentes d’abord', async () => {
    await saveCrmFlows(['invoices'], direction)
    await relier(DURAND, '412')
    await relier(PETIT, '413')
    await envoyer(facture)
    await envoyer({ ...facture, dolibarrId: '1835', numero: 'FA2612-0001', date: '2026-12-31', echeance: null })
    await envoyer({ ...facture, dolibarrId: '1836', tiersDolibarrId: '413', numero: 'FA2611-0050' })
    await envoyer({ ...facture, dolibarrId: '1837', type: 'avoir', numero: 'AV2611-0001', montantHtCentimes: -1000, montantTtcCentimes: -1200 })

    assert.deepEqual(
      (await listReceivedInvoicesForAccounts(durand)).map((ligne) => [ligne.number, ligne.kind, ligne.totalInclTaxCents]),
      [
        ['FA2612-0001', 'invoice', 14400],
        ['FA2611-0042', 'invoice', 14400],
        ['AV2611-0001', 'credit_note', 1200],
      ],
    )
    assert.deepEqual(
      (await listReceivedInvoicesForAccounts(petit)).map((ligne) => ligne.number),
      ['FA2611-0050'],
    )
    // Un compte à deux entreprises les voit toutes deux.
    assert.equal((await listReceivedInvoicesForAccounts([...durand, ...petit])).length, 4)
  })

  it('la base tient la facture reçue : pas de suppression, identité figée, née visible (CA027)', async () => {
    await saveCrmFlows(['invoices'], direction)
    await relier(DURAND, '412')
    const { body } = await envoyer(facture)
    const id = String(body.factureId)
    const code = async (requete: ReturnType<typeof sql>) => {
      try {
        await withTenant(DEFAULT_TENANT_ID, (tx) => tx.execute(requete), bases.app.db)
      } catch (error) {
        return dbErrorCode(error)
      }
      return undefined
    }
    assert.equal(await code(sql`delete from crm_invoices where id = ${id}`), 'CA027')
    assert.equal(await code(sql`update crm_invoices set external_id = '9999' where id = ${id}`), 'CA027')
    assert.equal(
      await code(sql`
        insert into crm_invoices (id, connector, external_id, client_id, number, status, issued_on,
                                  total_excl_tax_cents, total_incl_tax_cents, removed_at)
        values (${uuidv7()}, 'dolibarr', '2000', ${DURAND}, 'FA-X', 'unpaid', '2026-11-30', 100, 120, current_timestamp(3))`),
      'CA027',
    )
    // Ce que le CRM fait évoluer, lui, change.
    assert.equal(await code(sql`update crm_invoices set status = 'paid' where id = ${id}`), undefined)
    // Les contrôles de structure : une facture payée ne doit plus rien.
    assert.equal(await code(sql`update crm_invoices set amount_due_cents = 100 where id = ${id}`), '23514')
  })
})
