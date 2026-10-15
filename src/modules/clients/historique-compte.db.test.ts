import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'

import { withClientScope, withTenant, type Transaction } from '../../db/index.ts'
import { ouvrirBasesDeTest, raisonDeSaut, type TestDatabases } from '../../db/test-support.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { todayIsoDate } from '../../lib/dates.ts'
import { uuidv7 } from '../../lib/uuid.ts'
import { archiveContractDocument } from '../contrats/documents.ts'
import { cancelOpeningRequest, requestOpening } from '../courrier/queries.ts'
import { cancelRequestForAccounts } from '../reservations/compte-queries.ts'
import type { ClientAccount } from './comptes.ts'
import { buildAccountHistory } from './historique-compte.ts'
import { findAccountHistoryStart, loadAccountHistory } from './historique-compte-queries.ts'
import { toutVider } from './test-support.ts'

/**
 * Historique du compte (R24), contre la base et sous l'identité applicative :
 * chaque demande et chaque document des entreprises du compte, et d'elles
 * seules — la base ne filtre plus les lectures, chaque requête de
 * `loadAccountHistory` filtre sur les entreprises du compte. Une annulation ne
 * retire rien : la demande reste, avec sa date et la personne qui l'a annulée.
 */
describe('historique du compte', { skip: raisonDeSaut }, () => {
  let bases: TestDatabases

  const TZ = 'Europe/Paris'
  const DURAND = '01a00000-0000-7000-8000-0000000f2c01'
  const PETIT = '01a00000-0000-7000-8000-0000000f2c02'
  const JEANNE = '01a00000-0000-7000-8000-0000000f2d01'
  const PAUL = '01a00000-0000-7000-8000-0000000f2d02'
  const CAMILLE = '01a00000-0000-7000-8000-0000000f2e01'
  const SALLE = '01a00000-0000-7000-8000-0000000f2f01'

  const durand: ClientAccount[] = [{ memberId: JEANNE, clientId: DURAND, clientName: 'Atelier Durand' }]
  const petit: ClientAccount[] = [{ memberId: PAUL, clientId: PETIT, clientName: 'Boulangerie Petit' }]
  const year = () => Number(todayIsoDate(TZ).slice(0, 4))

  const asTenant = <T>(run: (tx: Transaction) => Promise<T>) =>
    withTenant(DEFAULT_TENANT_ID, run, bases.app.db)

  /** Identité du centre avant le test, rendue à la fin : d'autres tests la lisent. */
  let identite: Record<string, unknown> | undefined

  /** Réservation déposée depuis l'espace client, dans `jours` jours. */
  const reserverDepuisLEspace = async (accounts: ClientAccount[], jours: number): Promise<string> => {
    const [account] = accounts
    const id = uuidv7()
    await withClientScope(
      DEFAULT_TENANT_ID,
      [account.clientId],
      (tx) =>
        tx.execute(sql`
          insert into bookings (id, resource_id, client_id, kind, channel, status, title, starts_at, ends_at,
                                booked_by_member_id)
          values (${id}, ${SALLE}, ${account.clientId}, 'booking', 'client', 'pending', 'Réunion d’équipe',
                  date_add(now(3), interval ${jours} day),
                  date_add(date_add(now(3), interval ${jours} day), interval 2 hour), ${account.memberId})`),
      bases.app.db,
    )
    return id
  }

  const pli = async (clientId: string, { ouvert = false } = {}): Promise<string> => {
    const id = uuidv7()
    await asTenant((tx) =>
      tx.execute(sql`
        insert into mail_items (id, client_id, sender, status, opened_at, opened_by)
        values (${id}, ${clientId}, 'URSSAF', ${ouvert ? 'opened' : 'received'},
                ${ouvert ? sql`now(3)` : null}, ${ouvert ? CAMILLE : null})`),
    )
    return id
  }

  const facturer = async (clientId: string, emettre: boolean): Promise<string> => {
    const id = uuidv7()
    await asTenant(async (tx) => {
      await tx.execute(sql`
        insert into invoices (id, client_id, period_start, period_end)
        values (${id}, ${clientId}, '2026-09-01', '2026-09-30')`)
      await tx.execute(sql`
        insert into invoice_lines (invoice_id, kind, description, unit_price_cents, vat_rate_bp)
        values (${id}, 'other', 'Domiciliation', 10000, 2000)`)
      if (emettre) await tx.execute(sql`select issue_invoice(${id}, null)`)
    })
    return id
  }

  const contracter = async (clientId: string, reference: string): Promise<string> =>
    asTenant(async (tx) => {
      const id = uuidv7()
      await tx.execute(sql`
        insert into contracts (id, client_id, reference, contract_type, starts_on, amount_cents)
        values (${id}, ${clientId}, ${reference}, 'domiciliation', '2026-01-01', 3000)`)
      await tx.execute(sql`update contracts set status = 'active' where id = ${id}`)
      await archiveContractDocument(tx, { contractId: id, amendmentId: null, generatedBy: null })
      return id
    })

  before(async () => {
    bases = await ouvrirBasesDeTest()
    // Les requêtes des modules passent par la base du processus : celle des tests.
    ;(globalThis as { database?: unknown }).database = bases.app
    const [rows] = (await bases.owner.client.query(
      `select legal_name, address_line1, postal_code, city, siren, vat_number, bank_iban
         from tenants where id = ?`,
      [DEFAULT_TENANT_ID],
    )) as unknown as [Record<string, unknown>[]]
    identite = rows[0]
  })

  beforeEach(async () => {
    await toutVider(bases.owner)
    await bases.owner.client.query(
      `update tenants set legal_name = 'Centre de démonstration SAS', address_line1 = '1 rue de l''Exemple',
        postal_code = '38070', city = 'Saint-Quentin-Fallavier', siren = '123456789',
        vat_number = 'FR32123456789', bank_iban = 'FR7630006000011234567890189'
      where id = ?`,
      [DEFAULT_TENANT_ID],
    )
    await asTenant(async (tx) => {
      await tx.execute(sql`
        insert into resources (id, resource_type, code, name) values (${SALLE}, 'salle', 'S-HIS', 'Salle Europe')`)
      await tx.execute(sql`
        insert into clients (id, name, status, address_line1, postal_code, city) values
          (${DURAND}, 'Atelier Durand', 'active', '2 place du Marché', '38000', 'Grenoble'),
          (${PETIT}, 'Boulangerie Petit', 'active', '3 rue du Four', '38000', 'Grenoble')`)
      await tx.execute(sql`
        insert into client_members (id, client_id, email, full_name, auth_user_id) values
          (${JEANNE}, ${DURAND}, 'jeanne@durand.fr', 'Jeanne Durand', 'u-jeanne'),
          (${PAUL}, ${PETIT}, 'paul@petit.fr', 'Paul Petit', 'u-paul')`)
      await tx.execute(sql`insert into staff_members (id, email) values (${CAMILLE}, 'camille@centre.fr')`)
    })
  })

  after(async () => {
    await toutVider(bases.owner)
    if (identite) {
      await bases.owner.client.query(
        `update tenants set legal_name = ?, address_line1 = ?, postal_code = ?, city = ?,
                            siren = ?, vat_number = ?, bank_iban = ?
          where id = ?`,
        [
          identite.legal_name,
          identite.address_line1,
          identite.postal_code,
          identite.city,
          identite.siren,
          identite.vat_number,
          identite.bank_iban,
          DEFAULT_TENANT_ID,
        ],
      )
    }
    delete (globalThis as { database?: unknown }).database
    await bases.fermer()
  })

  it('garde une demande de réservation annulée par le client, avec son auteur', async () => {
    const id = await reserverDepuisLEspace(durand, 5)
    assert.equal(await cancelRequestForAccounts(id, durand), true)

    const { sources } = await loadAccountHistory(durand, { year: year(), timeZone: TZ })
    assert.equal(sources.bookings.length, 1)
    const [booking] = sources.bookings
    assert.equal(booking.id, id)
    assert.equal(booking.status, 'cancelled')
    assert.equal(booking.bookedByName, 'Jeanne Durand')
    assert.equal(booking.cancelledByMemberName, 'Jeanne Durand')
    assert.equal(booking.cancelledByStaff, false)
    assert.ok(booking.cancelledAt instanceof Date)
  })

  it('dit qu’une réservation a été annulée par le centre, et pourquoi', async () => {
    const id = uuidv7()
    await asTenant((tx) =>
      tx.execute(sql`
        insert into bookings (id, resource_id, client_id, kind, channel, status, title, starts_at, ends_at)
        values (${id}, ${SALLE}, ${DURAND}, 'booking', 'staff', 'confirmed', 'Formation',
                date_add(now(3), interval 3 day), date_add(date_add(now(3), interval 3 day), interval 2 hour))`),
    )
    await asTenant((tx) =>
      tx.execute(sql`
        update bookings set status = 'cancelled', cancelled_at = now(3),
               cancellation_reason = 'Salle en travaux', cancelled_by_staff_id = ${CAMILLE}
         where id = ${id}`),
    )
    const { sources } = await loadAccountHistory(durand, { year: year(), timeZone: TZ })
    const [booking] = sources.bookings
    assert.equal(booking.cancelledByStaff, true)
    assert.equal(booking.cancellationReason, 'Salle en travaux')
    assert.equal(booking.bookedByName, null)
    assert.equal(booking.channel, 'staff')
  })

  it('retrace chaque demande de courrier, annulée ou refusée comprise', async () => {
    const ferme = await pli(DURAND)
    assert.equal(await requestOpening(ferme, durand), true)
    assert.equal(await cancelOpeningRequest(ferme, durand), true)
    // Une nouvelle demande sur le même pli ne remplace pas la première.
    assert.equal(await requestOpening(ferme, durand), true)

    const ouvert = await pli(DURAND, { ouvert: true })
    const scan = uuidv7()
    await withClientScope(
      DEFAULT_TENANT_ID,
      [DURAND],
      (tx) =>
        tx.execute(sql`
          insert into mail_requests (id, mail_item_id, client_id, kind, requested_by_member_id)
          values (${scan}, ${ouvert}, ${DURAND}, 'scan', ${JEANNE})`),
      bases.app.db,
    )
    await asTenant((tx) =>
      tx.execute(sql`
        update mail_requests set status = 'refused', refused_by_staff_id = ${CAMILLE},
               refusal_reason = 'Contenu déjà numérisé'
         where id = ${scan}`),
    )

    const { sources } = await loadAccountHistory(durand, { year: year(), timeZone: TZ })
    const byStatus = Object.fromEntries(sources.mailRequests.map((request) => [request.status, request]))
    assert.equal(sources.mailRequests.length, 3)
    assert.equal(byStatus.cancelled?.cancelledByMemberName, 'Jeanne Durand')
    assert.ok(byStatus.cancelled?.cancelledAt instanceof Date)
    assert.equal(byStatus.requested?.kind, 'open_and_scan')
    assert.equal(byStatus.refused?.refusalReason, 'Contenu déjà numérisé')
    assert.equal(byStatus.refused?.sender, 'URSSAF')
    assert.equal(byStatus.refused?.mailItemRemoved, false)
  })

  it('cache l’expéditeur d’un pli retiré, sans retirer la demande', async () => {
    const ferme = await pli(DURAND)
    await requestOpening(ferme, durand)
    await asTenant((tx) => tx.execute(sql`update mail_items set deleted_at = now(3) where id = ${ferme}`))
    const { sources } = await loadAccountHistory(durand, { year: year(), timeZone: TZ })
    assert.equal(sources.mailRequests.length, 1)
    assert.equal(sources.mailRequests[0].status, 'refused')
    assert.equal(sources.mailRequests[0].sender, null)
    assert.equal(sources.mailRequests[0].mailItemRemoved, true)
  })

  it('reprend les documents de contrat et les factures émises, jamais un brouillon', async () => {
    const contrat = await contracter(DURAND, 'CT-H-1')
    const emise = await facturer(DURAND, true)
    await facturer(DURAND, false)
    const { sources } = await loadAccountHistory(durand, { year: year(), timeZone: TZ })
    assert.deepEqual(
      sources.contractDocuments.map((document) => [document.contractId, document.version]),
      [[contrat, 1]],
    )
    assert.deepEqual(
      sources.invoices.map((invoice) => invoice.id),
      [emise],
    )
    assert.ok(sources.invoices[0].issuedAt instanceof Date)
  })

  it('ne montre rien d’une autre entreprise', async () => {
    const deDurand = await reserverDepuisLEspace(durand, 5)
    await reserverDepuisLEspace(petit, 6)
    await requestOpening(await pli(PETIT), petit)
    await contracter(PETIT, 'CT-H-2')
    await facturer(PETIT, true)

    const { sources } = await loadAccountHistory(durand, { year: year(), timeZone: TZ })
    assert.deepEqual(
      sources.bookings.map((booking) => booking.id),
      [deDurand],
    )
    assert.deepEqual(sources.mailRequests, [])
    assert.deepEqual(sources.contractDocuments, [])
    assert.deepEqual(sources.offerRequests, [])
    assert.deepEqual(sources.invoices, [])
    assert.deepEqual(sources.inspections, [])
    const entries = buildAccountHistory(sources, { timeZone: TZ, today: todayIsoDate(TZ) })
    assert.ok(entries.every((entry) => entry.clientId === DURAND))
    // Ni son premier instant : Petit n'a rien à y faire.
    const premierDurand = await findAccountHistoryStart(durand)
    const premierPetit = await findAccountHistoryStart(petit)
    assert.ok(premierDurand && premierPetit && premierDurand.getTime() <= premierPetit.getTime())
  })

  it('reprend les états des lieux clos de l’entreprise, validation comprise, jamais un brouillon', async () => {
    const reservationDurand = uuidv7()
    const reservationPetit = uuidv7()
    await asTenant(async (tx) => {
      await tx.execute(sql`
        insert into bookings (id, resource_id, client_id, kind, channel, status, title, starts_at, ends_at) values
          (${reservationDurand}, ${SALLE}, ${DURAND}, 'booking', 'staff', 'confirmed', 'Atelier',
           date_sub(now(3), interval 72 hour), date_sub(now(3), interval 70 hour)),
          (${reservationPetit}, ${SALLE}, ${PETIT}, 'booking', 'staff', 'confirmed', 'Atelier',
           date_sub(now(3), interval 48 hour), date_sub(now(3), interval 46 hour))`)
    })
    const version = uuidv7()
    await asTenant(async (tx) => {
      const modele = uuidv7()
      await tx.execute(sql`
        insert into inspection_templates (id, resource_type, name) values (${modele}, 'salle', 'Salle')`)
      await tx.execute(sql`
        insert into inspection_template_versions (id, template_id, version, name, fields, created_by)
        values (${version}, ${modele}, 1, 'Salle',
                ${'[{"id":"murs","label":"Murs","type":"condition","required":true}]'}, ${CAMILLE})`)
    })
    const etat = async (clientId: string, bookingId: string, clore: boolean): Promise<string> => {
      const id = uuidv7()
      await asTenant((tx) =>
        tx.execute(sql`
          insert into inspections (id, kind, resource_id, client_id, booking_id, template_version_id, created_by,
                                   performed_at)
          values (${id}, 'entry', ${SALLE}, ${clientId}, ${bookingId}, ${version}, ${CAMILLE},
                  date_sub(now(3), interval 1 day))`),
      )
      if (clore) {
        // `values` est un mot réservé de MySQL : la colonne s'écrit entre apostrophes inverses.
        await asTenant((tx) =>
          tx.execute(sql`
            update inspections set status = 'closed', closed_by = ${CAMILLE}, \`values\` = ${'{"murs":"bon"}'}
             where id = ${id}`),
        )
      }
      return id
    }
    await etat(DURAND, reservationDurand, false)
    const clos = await etat(DURAND, reservationDurand, true)
    await etat(PETIT, reservationPetit, true)

    const avant = await loadAccountHistory(durand, { year: year(), timeZone: TZ, category: 'etats-des-lieux' })
    assert.deepEqual(
      avant.sources.inspections.map((row) => [row.id, row.signedAt]),
      [[clos, null]],
    )
    assert.equal(avant.sources.bookings.length, 0)
    assert.ok(avant.sources.inspections[0].closedAt instanceof Date)

    await asTenant((tx) =>
      tx.execute(sql`
        update inspections set signed_by_member_id = ${JEANNE}, client_remarks = 'Rayure sur la porte'
         where id = ${clos}`),
    )
    const { sources } = await loadAccountHistory(durand, { year: year(), timeZone: TZ })
    const [ligne] = sources.inspections
    assert.equal(sources.inspections.length, 1)
    assert.equal(ligne.signedByName, 'Jeanne Durand')
    assert.equal(ligne.hasRemarks, true)
    assert.ok(ligne.signedAt instanceof Date)
    const entries = buildAccountHistory(sources, { timeZone: TZ, today: todayIsoDate(TZ) })
    const entree = entries.find((entry) => entry.category === 'etats-des-lieux')
    assert.equal(entree?.outcome.label, 'Validé')
    assert.ok(entries.every((entry) => entry.clientId === DURAND))
  })

  it('se lit par année du centre et par rubrique', async () => {
    await reserverDepuisLEspace(durand, 5)
    await requestOpening(await pli(DURAND), durand)

    const courrier = await loadAccountHistory(durand, { year: year(), timeZone: TZ, category: 'courrier' })
    assert.equal(courrier.sources.bookings.length, 0)
    assert.equal(courrier.sources.mailRequests.length, 1)

    const anneePassee = await loadAccountHistory(durand, { year: year() - 1, timeZone: TZ })
    assert.equal(anneePassee.sources.bookings.length + anneePassee.sources.mailRequests.length, 0)
    assert.equal(anneePassee.truncated, false)

    const start = await findAccountHistoryStart(durand)
    assert.ok(start instanceof Date && start.getTime() <= Date.now())
    assert.equal(await findAccountHistoryStart(petit), null)
  })
})
