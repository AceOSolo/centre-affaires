import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import { createDatabase, withClientScope, withTenant, type Transaction } from '../../db/index.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { todayIsoDate } from '../../lib/dates.ts'
import { archiveContractDocument } from '../contrats/documents.ts'
import { cancelOpeningRequest, requestOpening } from '../courrier/queries.ts'
import { cancelRequestForAccounts } from '../reservations/compte-queries.ts'
import type { ClientAccount } from './comptes.ts'
import { buildAccountHistory } from './historique-compte.ts'
import { findAccountHistoryStart, loadAccountHistory } from './historique-compte-queries.ts'

/**
 * Historique du compte (R24), contre la base et sous le rôle applicatif :
 * chaque demande et chaque document des entreprises du compte, et d'elles
 * seules. Une annulation ne retire rien : la demande reste, avec sa date et
 * la personne qui l'a annulée.
 */
const ownerUrl = process.env.TEST_OWNER_DATABASE_URL ?? process.env.DATABASE_URL
const appUrl = process.env.TEST_DATABASE_URL

const raison = !appUrl
  ? 'TEST_DATABASE_URL non défini'
  : !ownerUrl
    ? 'TEST_OWNER_DATABASE_URL non défini'
    : false

describe('historique du compte', { skip: raison }, () => {
  // Les requêtes des modules ouvrent leur propre connexion, par APP_DATABASE_URL.
  if (appUrl) process.env.APP_DATABASE_URL = appUrl

  const owner = createDatabase(ownerUrl ?? '', { onnotice: () => {} })
  const app = createDatabase(appUrl ?? '')

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
    withTenant(DEFAULT_TENANT_ID, run, app.db)

  /** Identité du centre avant le test, rendue à la fin : d'autres tests la lisent. */
  let identite: Record<string, unknown> | undefined

  /** Réservation déposée depuis l'espace client, dans `jours` jours. */
  const reserverDepuisLEspace = async (accounts: ClientAccount[], jours: number): Promise<string> => {
    const [account] = accounts
    const [row] = await withClientScope(
      DEFAULT_TENANT_ID,
      [account.clientId],
      (tx) =>
        tx.execute(sql`
          insert into bookings (resource_id, client_id, kind, channel, status, title, starts_at, ends_at,
                                booked_by_member_id)
          values (${SALLE}, ${account.clientId}, 'booking', 'client', 'pending', 'Réunion d’équipe',
                  now() + make_interval(days => ${jours}),
                  now() + make_interval(days => ${jours}, hours => 2), ${account.memberId})
          returning id`),
      app.db,
    )
    return row.id as string
  }

  const pli = async (clientId: string, { ouvert = false } = {}): Promise<string> => {
    const [row] = await asTenant((tx) =>
      tx.execute(sql`
        insert into mail_items (client_id, sender, status, opened_at, opened_by)
        values (${clientId}, 'URSSAF', ${ouvert ? 'opened' : 'received'},
                ${ouvert ? sql`now()` : null}, ${ouvert ? CAMILLE : null})
        returning id`),
    )
    return row.id as string
  }

  const facturer = async (clientId: string, emettre: boolean): Promise<string> => {
    const [row] = await asTenant(async (tx) => {
      const [invoice] = await tx.execute(sql`
        insert into invoices (client_id, period_start, period_end)
        values (${clientId}, '2026-09-01', '2026-09-30') returning id`)
      await tx.execute(sql`
        insert into invoice_lines (invoice_id, kind, description, unit_price_cents, vat_rate_bp)
        values (${invoice.id as string}, 'other', 'Domiciliation', 10000, 2000)`)
      if (emettre) await tx.execute(sql`select issue_invoice(${invoice.id as string}::uuid)`)
      return [invoice]
    })
    return row.id as string
  }

  const contracter = async (clientId: string, reference: string): Promise<string> =>
    asTenant(async (tx) => {
      const [contrat] = await tx.execute(sql`
        insert into contracts (client_id, reference, contract_type, starts_on, amount_cents)
        values (${clientId}, ${reference}, 'domiciliation', '2026-01-01', 3000) returning id`)
      const id = contrat.id as string
      await tx.execute(sql`update contracts set status = 'active' where id = ${id}`)
      await archiveContractDocument(tx, { contractId: id, amendmentId: null, generatedBy: null })
      return id
    })

  before(async () => {
    await migrate(owner.db, { migrationsFolder: './src/db/migrations' })
    const [row] = await owner.client`
      select legal_name, address_line1, postal_code, city, siren, vat_number, bank_iban
        from tenants where id = ${DEFAULT_TENANT_ID}`
    identite = row
  })

  beforeEach(async () => {
    await owner.client`truncate table bookings, contracts, clients, resources, services, offers cascade`
    await owner.client`truncate table staff_members cascade`
    await owner.client`
      update tenants set legal_name = 'Centre de démonstration SAS', address_line1 = '1 rue de l''Exemple',
        postal_code = '38070', city = 'Saint-Quentin-Fallavier', siren = '123456789',
        vat_number = 'FR32123456789', bank_iban = 'FR7630006000011234567890189'
      where id = ${DEFAULT_TENANT_ID}`
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
    if (identite) {
      await owner.client`
        update tenants set legal_name = ${identite.legal_name as string | null},
          address_line1 = ${identite.address_line1 as string | null},
          postal_code = ${identite.postal_code as string | null}, city = ${identite.city as string | null},
          siren = ${identite.siren as string | null}, vat_number = ${identite.vat_number as string | null},
          bank_iban = ${identite.bank_iban as string | null}
        where id = ${DEFAULT_TENANT_ID}`
    }
    const global = globalThis as { database?: { client: { end: () => Promise<void> } } }
    await Promise.all([owner.client.end(), app.client.end(), global.database?.client.end()])
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
    const [row] = await asTenant((tx) =>
      tx.execute(sql`
        insert into bookings (resource_id, client_id, kind, channel, status, title, starts_at, ends_at)
        values (${SALLE}, ${DURAND}, 'booking', 'staff', 'confirmed', 'Formation',
                now() + interval '3 days', now() + interval '3 days 2 hours')
        returning id`),
    )
    await asTenant((tx) =>
      tx.execute(sql`
        update bookings set status = 'cancelled', cancelled_at = now(),
               cancellation_reason = 'Salle en travaux', cancelled_by_staff_id = ${CAMILLE}
         where id = ${row.id as string}`),
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
    const [scan] = await withClientScope(
      DEFAULT_TENANT_ID,
      [DURAND],
      (tx) =>
        tx.execute(sql`
          insert into mail_requests (mail_item_id, client_id, kind, requested_by_member_id)
          values (${ouvert}, ${DURAND}, 'scan', ${JEANNE}) returning id`),
      app.db,
    )
    await asTenant((tx) =>
      tx.execute(sql`
        update mail_requests set status = 'refused', refused_by_staff_id = ${CAMILLE},
               refusal_reason = 'Contenu déjà numérisé'
         where id = ${scan.id as string}`),
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
    await asTenant((tx) => tx.execute(sql`update mail_items set deleted_at = now() where id = ${ferme}`))
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
    assert.deepEqual(sources.invoices, [])
    assert.deepEqual(sources.inspections, [])
    const entries = buildAccountHistory(sources, { timeZone: TZ, today: todayIsoDate(TZ) })
    assert.ok(entries.every((entry) => entry.clientId === DURAND))
  })

  it('reprend les états des lieux clos de l’entreprise, validation comprise, jamais un brouillon', async () => {
    await owner.client`truncate table inspection_templates cascade`
    const [reservationDurand, reservationPetit] = await asTenant(async (tx) => {
      const rows = await tx.execute(sql`
        insert into bookings (resource_id, client_id, kind, channel, status, title, starts_at, ends_at) values
          (${SALLE}, ${DURAND}, 'booking', 'staff', 'confirmed', 'Atelier', now() - interval '3 days',
           now() - interval '3 days' + interval '2 hours'),
          (${SALLE}, ${PETIT}, 'booking', 'staff', 'confirmed', 'Atelier', now() - interval '2 days',
           now() - interval '2 days' + interval '2 hours')
        returning id, client_id`)
      const byClient = new Map(rows.map((row) => [row.client_id as string, row.id as string]))
      return [byClient.get(DURAND) as string, byClient.get(PETIT) as string]
    })
    const version = await asTenant(async (tx) => {
      const [modele] = await tx.execute(sql`
        insert into inspection_templates (resource_type, name) values ('salle', 'Salle') returning id`)
      const [row] = await tx.execute(sql`
        insert into inspection_template_versions (template_id, version, name, fields, created_by)
        values (${modele.id as string}, 1, 'Salle',
                '[{"id":"murs","label":"Murs","type":"condition","required":true}]'::jsonb, ${CAMILLE})
        returning id`)
      return row.id as string
    })
    const etat = async (clientId: string, bookingId: string, clore: boolean): Promise<string> => {
      const [row] = await asTenant((tx) =>
        tx.execute(sql`
          insert into inspections (kind, resource_id, client_id, booking_id, template_version_id, created_by,
                                   performed_at)
          values ('entry', ${SALLE}, ${clientId}, ${bookingId}, ${version}, ${CAMILLE}, now() - interval '1 day')
          returning id`),
      )
      const id = row.id as string
      if (clore) {
        await asTenant((tx) =>
          tx.execute(sql`
            update inspections set status = 'closed', closed_by = ${CAMILLE}, values = '{"murs":"bon"}'::jsonb
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
