import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import { PG_CHECK_VIOLATION, pgErrorCode } from '../../db/errors.ts'
import { createDatabase, withTenant } from '../../db/index.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'

/**
 * Conservation des coordonnées des demandeurs de la page publique (B4,
 * ADR 005, ADR 020).
 *
 * Au terme de la durée du centre, `anonymize_expired_public_requests()` efface
 * le nom, l'adresse et le téléphone du demandeur. La réservation reste : on
 * anonymise, on ne supprime pas (décision 6). Appelée sous `app_centre`, comme
 * le fera la tâche de maintenance.
 */
const ownerUrl = process.env.TEST_OWNER_DATABASE_URL ?? process.env.DATABASE_URL
const appUrl = process.env.TEST_DATABASE_URL

const raison = !appUrl
  ? 'TEST_DATABASE_URL non défini'
  : !ownerUrl
    ? 'TEST_OWNER_DATABASE_URL non défini'
    : false

describe('conservation des demandes publiques', { skip: raison }, () => {
  const owner = createDatabase(ownerUrl ?? '', { onnotice: () => {} })
  const app = createDatabase(appUrl ?? '')

  const SALLE = '01a00000-0000-7000-8000-000000100b01'
  const CLIENT = '01a00000-0000-7000-8000-000000100c01'
  const AUTRE_CENTRE = '01999f00-0000-7000-8000-0000000000f3'
  const SALLE_AILLEURS = '01a00000-0000-7000-8000-000000100b02'

  const asTenant = <T>(run: Parameters<typeof withTenant<T>>[1], tenant = DEFAULT_TENANT_ID) =>
    withTenant(tenant, run, app.db)

  /**
   * Une demande dont le créneau s'est terminé il y a `moisEcoules` mois
   * (négatif : à venir). Chaque demande a son heure, pour ne pas se chevaucher.
   */
  let heure = 0
  const demande = async (
    titre: string,
    moisEcoules: number,
    {
      clientId = null as string | null,
      annuleeIlYaMois = null as number | null,
      channel = 'public',
      tenant = DEFAULT_TENANT_ID,
      resourceId = SALLE,
    } = {},
  ) => {
    heure += 1
    await asTenant(
      (tx) =>
        tx.execute(sql`
          insert into bookings (
            resource_id, client_id, channel, status, title, notes,
            requester_name, requester_email, requester_phone,
            starts_at, ends_at, cancelled_at
          ) values (
            ${resourceId}, ${clientId}, ${channel},
            ${annuleeIlYaMois === null ? 'pending' : 'cancelled'},
            ${titre}, 'Merci de me rappeler — Camille',
            'Camille Rousseau', 'camille@exemple.fr', '06 12 34 56 78',
            now() - make_interval(months => ${moisEcoules}, hours => ${heure + 1}),
            now() - make_interval(months => ${moisEcoules}, hours => ${heure}),
            ${annuleeIlYaMois === null ? null : sql`now() - make_interval(months => ${annuleeIlYaMois})`}
          )`),
      tenant,
    )
  }

  const anonymiser = async (tenant = DEFAULT_TENANT_ID): Promise<number> => {
    const [row] = await asTenant(
      (tx) => tx.execute(sql`select anonymize_expired_public_requests() as n`),
      tenant,
    )
    return Number(row.n)
  }

  const lire = async (titre: string) => {
    const [row] = await owner.client`
      select title, notes, status, requester_name, requester_email, requester_phone,
             requester_anonymized_at, channel
      from bookings where title = ${titre}`
    return row
  }

  before(async () => {
    await migrate(owner.db, { migrationsFolder: './src/db/migrations' })
  })

  beforeEach(async () => {
    await owner.client`truncate table bookings, contracts, rate_plan_items, rate_plans, clients, resources cascade`
    await owner.client`delete from tenants where id <> ${DEFAULT_TENANT_ID}`
    await owner.client`update tenants set public_request_retention_months = 12`
    heure = 0
    await asTenant(async (tx) => {
      await tx.execute(sql`insert into resources (id, resource_type, code, name) values (${SALLE}, 'salle', 'SAL-1', 'Salle')`)
      await tx.execute(sql`insert into clients (id, name) values (${CLIENT}, 'Acme SAS')`)
    })
  })

  after(async () => {
    await owner.client`update tenants set public_request_retention_months = 12`
    await Promise.all([owner.client.end(), app.client.end()])
  })

  it('efface le demandeur d’une demande échue, la réservation reste', async () => {
    await demande('Séminaire 2024', 24)
    assert.equal(await anonymiser(), 1)

    const [row] = await owner.client`select * from bookings`
    assert.equal(row.requester_name, null)
    assert.equal(row.requester_email, null)
    assert.equal(row.requester_phone, null)
    // Jamais rattachée à un client : l'objet et les notes, saisis par le
    // visiteur, partent avec ses coordonnées.
    assert.equal(row.title, 'Demande publique anonymisée')
    assert.equal(row.notes, null)
    assert.ok(row.requester_anonymized_at)
    // La ligne et ce qui n'est pas personnel restent.
    assert.equal(row.status, 'pending')
    assert.equal(row.channel, 'public')
  })

  it('garde l’objet d’une demande rattachée à un client', async () => {
    await demande('Formation Acme', 24, { clientId: CLIENT, channel: 'client' })
    assert.equal(await anonymiser(), 1)
    const row = await lire('Formation Acme')
    assert.equal(row.requester_email, null)
    assert.equal(row.notes, 'Merci de me rappeler — Camille')
    assert.ok(row.requester_anonymized_at)
  })

  it('ne touche ni une demande récente ni une demande à venir', async () => {
    await demande('Récente', 2)
    await demande('À venir', -1)
    assert.equal(await anonymiser(), 0)
    assert.equal((await lire('Récente')).requester_email, 'camille@exemple.fr')
    assert.equal((await lire('À venir')).requester_email, 'camille@exemple.fr')
  })

  it('compte depuis l’annulation quand elle précède le créneau', async () => {
    // Refusée il y a deux ans pour un créneau qui n'a jamais eu lieu.
    await demande('Refusée', -1, { annuleeIlYaMois: 24 })
    await demande('Annulée récemment', 24, { annuleeIlYaMois: 1 })
    assert.equal(await anonymiser(), 2)
  })

  it('suit la durée fixée par le centre', async () => {
    await demande('Il y a trois mois', 3)
    assert.equal(await anonymiser(), 0)
    await owner.client`update tenants set public_request_retention_months = 2`
    assert.equal(await anonymiser(), 1)
  })

  it('refuse une durée hors bornes', async () => {
    const code = await (async () => {
      try {
        await owner.client`update tenants set public_request_retention_months = 0`
      } catch (error) {
        return pgErrorCode(error)
      }
    })()
    assert.equal(code, PG_CHECK_VIOLATION)
  })

  it('ne repasse pas deux fois sur la même demande', async () => {
    await demande('Séminaire 2024', 24)
    assert.equal(await anonymiser(), 1)
    assert.equal(await anonymiser(), 0)
  })

  it('laisse les réservations de l’équipe, qui n’ont pas de demandeur', async () => {
    await asTenant((tx) =>
      tx.execute(sql`
        insert into bookings (resource_id, channel, title, notes, starts_at, ends_at)
        values (${SALLE}, 'staff', 'Comité', 'Ordre du jour', '2023-01-10T08:00:00Z', '2023-01-10T09:00:00Z')`),
    )
    assert.equal(await anonymiser(), 0)
    assert.equal((await lire('Comité')).notes, 'Ordre du jour')
  })

  it('ne touche que le centre courant', async () => {
    await owner.client`
      insert into tenants (id, name, slug) values (${AUTRE_CENTRE}, 'Autre centre', 'autre-centre-rgpd')`
    await asTenant(
      (tx) =>
        tx.execute(sql`
          insert into resources (id, resource_type, code, name) values (${SALLE_AILLEURS}, 'salle', 'X', 'X')`),
      AUTRE_CENTRE,
    )
    await demande('Ailleurs', 24, { tenant: AUTRE_CENTRE, resourceId: SALLE_AILLEURS })
    assert.equal(await anonymiser(), 0)
    assert.equal((await lire('Ailleurs')).requester_email, 'camille@exemple.fr')
    assert.equal(await anonymiser(AUTRE_CENTRE), 1)
  })

  it('ne fait rien hors contexte de centre', async () => {
    await demande('Séminaire 2024', 24)
    const [row] = await app.db.execute(sql`select anonymize_expired_public_requests() as n`)
    assert.equal(Number(row.n), 0)
  })
})
