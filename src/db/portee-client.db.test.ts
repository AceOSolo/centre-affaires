import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import { pgErrorCode } from './errors.ts'
import { createDatabase, withClientScope, withTenant } from './index.ts'
import { DEFAULT_TENANT_ID } from './tenants.ts'

/**
 * Isolation des clients entre eux, en base (R28, ADR 019).
 *
 * Sous `withClientScope()`, une requête **sans aucun filtre** ne doit rendre
 * que les lignes des entreprises de la portée : c'est ce qui protège l'espace
 * client d'un `where` oublié. Sans portée — le back-office — rien ne change.
 *
 * Éprouvé sous `app_centre` : sous le propriétaire, qui contourne la RLS, tout
 * passerait sans rien prouver.
 */
const ownerUrl = process.env.TEST_OWNER_DATABASE_URL ?? process.env.DATABASE_URL
const appUrl = process.env.TEST_DATABASE_URL

const raison = !appUrl
  ? 'TEST_DATABASE_URL non défini'
  : !ownerUrl
    ? 'TEST_OWNER_DATABASE_URL non défini'
    : false

/** Ligne refusée par une politique (`new row violates row-level security policy`). */
const PG_RLS_VIOLATION = '42501'

describe('portée client', { skip: raison }, () => {
  const owner = createDatabase(ownerUrl ?? '', { onnotice: () => {} })
  // Une seule connexion : la portée d'une transaction doit être retombée quand
  // la suivante réutilise la même session.
  const app = createDatabase(appUrl ?? '', { max: 1 })

  const DURAND = '01a00000-0000-7000-8000-0000000e0c01'
  const PETIT = '01a00000-0000-7000-8000-0000000e0c02'
  const SALLE = '01a00000-0000-7000-8000-0000000e0b01'
  const BUREAU = '01a00000-0000-7000-8000-0000000e0b02'
  const ACCUEIL = '01a00000-0000-7000-8000-0000000e0d01'
  const AUTRE_CENTRE = '01999f00-0000-7000-8000-0000000000f5'

  /** Tables qui relèvent d'un client, et comment retrouver ce client. */
  const TABLES = {
    clients: sql`select id as client_id from clients`,
    client_members: sql`select client_id from client_members`,
    client_contacts: sql`select client_id from client_contacts`,
    contracts: sql`select client_id from contracts`,
    bookings: sql`select client_id from bookings`,
    mail_items: sql`select client_id from mail_items`,
    mail_scans: sql`select mail_item_id from mail_scans`,
    mail_scan_views: sql`select mail_scan_id from mail_scan_views`,
  }

  const asTenant = <T>(run: Parameters<typeof withTenant<T>>[1]) =>
    withTenant(DEFAULT_TENANT_ID, run, app.db)

  const asClients = <T>(clientIds: string[], run: Parameters<typeof withClientScope<T>>[2]) =>
    withClientScope(DEFAULT_TENANT_ID, clientIds, run, app.db)

  const errorCode = async (run: () => Promise<unknown>) => {
    try {
      await run()
    } catch (error) {
      return pgErrorCode(error)
    }
    return undefined
  }

  /** Nombre de lignes de chaque table, lues sans aucun `where`. */
  const compter = (run: typeof asTenant) =>
    run(async (tx) => {
      const counts: Record<string, number> = {}
      for (const [table, query] of Object.entries(TABLES)) {
        counts[table] = (await tx.execute(query)).length
      }
      return counts
    })

  /** Tout ce qu'une entreprise possède : accès, contact, contrat, réservation, courrier. */
  const peupler = async (clientId: string, index: number) => {
    await asTenant(async (tx) => {
      const [member] = await tx.execute(sql`
        insert into client_members (client_id, email, auth_user_id)
        values (${clientId}, ${`gerant${index}@exemple.fr`}, ${`u-${index}`}) returning id`)
      await tx.execute(sql`
        insert into client_contacts (client_id, full_name, is_primary)
        values (${clientId}, ${`Contact ${index}`}, true)`)
      await tx.execute(sql`
        insert into contracts (client_id, reference, contract_type, starts_on, amount_cents)
        values (${clientId}, ${`DOM-${index}`}, 'domiciliation', '2026-01-01', 9000)`)
      await tx.execute(sql`
        insert into bookings (resource_id, client_id, channel, starts_at, ends_at, title)
        values (${SALLE}, ${clientId}, 'client',
                ${`2026-10-0${index}T08:00:00Z`}, ${`2026-10-0${index}T09:00:00Z`}, 'Réunion')`)
      const [item] = await tx.execute(sql`
        insert into mail_items (client_id, sender) values (${clientId}, 'URSSAF') returning id`)
      const [scan] = await tx.execute(sql`
        insert into mail_scans (mail_item_id, side, storage_key, content_type, byte_size)
        values (${item.id as string}, 'envelope', ${`courrier/${clientId}.pdf`}, 'application/pdf', 100)
        returning id`)
      await tx.execute(sql`
        insert into mail_scan_views (mail_scan_id, viewer, client_member_id, auth_user_id)
        values (${scan.id as string}, 'client', ${member.id as string}, ${`u-${index}`})`)
    })
  }

  before(async () => {
    await migrate(owner.db, { migrationsFolder: './src/db/migrations' })
  })

  beforeEach(async () => {
    await owner.client`truncate table bookings, contracts, rate_plan_items, rate_plans, clients, resources cascade`
    await owner.client`truncate table staff_members cascade`
    await owner.client`delete from tenants where id <> ${DEFAULT_TENANT_ID}`
    await asTenant(async (tx) => {
      await tx.execute(sql`
        insert into clients (id, name) values (${DURAND}, 'Atelier Durand'), (${PETIT}, 'Boulangerie Petit')`)
      await tx.execute(sql`
        insert into resources (id, resource_type, code, name) values
          (${SALLE}, 'salle', 'SAL-1', 'Salle'), (${BUREAU}, 'bureau', 'BUR-1', 'Bureau')`)
      await tx.execute(sql`
        insert into staff_members (id, email) values (${ACCUEIL}, 'accueil@centre.fr')`)
    })
    await peupler(DURAND, 1)
    await peupler(PETIT, 2)
    // Une ligne sans client : l'entretien de la salle, posé par l'accueil.
    await asTenant((tx) =>
      tx.execute(sql`
        insert into bookings (resource_id, kind, channel, starts_at, ends_at, title)
        values (${SALLE}, 'unavailability', 'staff', '2026-10-05T08:00:00Z', '2026-10-05T12:00:00Z', 'Entretien')`),
    )
  })

  after(async () => {
    await Promise.all([owner.client.end(), app.client.end()])
  })

  it('interroge la base avec un rôle soumis aux politiques', async () => {
    const [role] = await app.client`
      select (select rolbypassrls from pg_roles where rolname = current_user) as bypass`
    assert.equal(role.bypass, false)
  })

  it('sans portée client, le back-office voit toutes les entreprises', async () => {
    assert.deepEqual(await compter(asTenant), {
      clients: 2,
      client_members: 2,
      client_contacts: 2,
      contracts: 2,
      bookings: 3,
      mail_items: 2,
      mail_scans: 2,
      mail_scan_views: 2,
    })
  })

  it('sous portée client, une requête sans where ne voit que son client', async () => {
    const vu = await asClients([DURAND], async (tx) => {
      const lignes: Record<string, unknown[]> = {}
      for (const [table, query] of Object.entries(TABLES)) {
        lignes[table] = await tx.execute(query)
      }
      // Le courrier n'a pas de `client_id` propre : on remonte au pli.
      const [scan] = await tx.execute(sql`
        select item.client_id from mail_scans scan join mail_items item on item.id = scan.mail_item_id`)
      const [vue] = await tx.execute(sql`
        select item.client_id from mail_scan_views vue
          join mail_scans scan on scan.id = vue.mail_scan_id
          join mail_items item on item.id = scan.mail_item_id`)
      return { lignes, scan, vue }
    })

    for (const table of ['clients', 'client_members', 'client_contacts', 'contracts', 'bookings', 'mail_items']) {
      assert.deepEqual(
        vu.lignes[table].map((row) => (row as { client_id: string }).client_id),
        [DURAND],
        table,
      )
    }
    assert.equal(vu.lignes.mail_scans.length, 1)
    assert.equal(vu.lignes.mail_scan_views.length, 1)
    assert.equal(vu.scan.client_id, DURAND)
    assert.equal(vu.vue.client_id, DURAND)
  })

  it('une portée de plusieurs entreprises les voit toutes', async () => {
    const counts = await compter((run) => asClients([DURAND, PETIT], run))
    assert.equal(counts.clients, 2)
    assert.equal(counts.mail_scans, 2)
    // L'entretien de la salle n'appartient à aucune entreprise.
    assert.equal(counts.bookings, 2)
  })

  it('une portée vide ne voit aucune ligne de client', async () => {
    const counts = await compter((run) => asClients([], run))
    assert.deepEqual(Object.values(counts), [0, 0, 0, 0, 0, 0, 0, 0])
  })

  it('laisse lisibles les tables qui ne relèvent d’aucun client', async () => {
    const [row] = await asClients([DURAND], (tx) =>
      tx.execute(sql`select (select count(*) from resources)::int as resources,
                            (select count(*) from tenants)::int as tenants`),
    )
    assert.equal(row.resources, 2)
    assert.equal(row.tenants, 1)
  })

  it('ne franchit pas le centre : la portée d’un autre centre ne voit rien', async () => {
    await owner.client`
      insert into tenants (id, name, slug) values (${AUTRE_CENTRE}, 'Autre centre', 'autre-centre-portee')`
    const counts = await withClientScope(AUTRE_CENTRE, [DURAND], async (tx) => {
      const [row] = await tx.execute(sql`select count(*)::int as n from clients`)
      return row.n
    }, app.db)
    assert.equal(counts, 0)
  })

  it('refuse d’écrire pour une autre entreprise, ou pour aucune', async () => {
    for (const clientId of [PETIT, null]) {
      const code = await errorCode(() =>
        asClients([DURAND], (tx) =>
          tx.execute(sql`
            insert into bookings (resource_id, client_id, channel, starts_at, ends_at, title)
            values (${BUREAU}, ${clientId}, 'client', '2026-11-02T08:00:00Z', '2026-11-02T09:00:00Z', 'Intrus')`),
        ),
      )
      assert.equal(code, PG_RLS_VIOLATION)
    }
    // Ni déplacer une de ses lignes chez le voisin.
    const code = await errorCode(() =>
      asClients([DURAND], (tx) => tx.execute(sql`update mail_items set client_id = ${PETIT}`)),
    )
    assert.equal(code, PG_RLS_VIOLATION)
  })

  it('n’atteint pas les lignes d’une autre entreprise, même sans where', async () => {
    const touchees = await asClients([DURAND], (tx) =>
      tx.execute(sql`update mail_items set note = 'vu' returning client_id`),
    )
    assert.deepEqual(
      touchees.map((row) => row.client_id),
      [DURAND],
    )
    const [petit] = await asTenant((tx) =>
      tx.execute(sql`select note from mail_items where client_id = ${PETIT}`),
    )
    assert.equal(petit.note, null)
  })

  it('laisse écrire pour sa propre entreprise', async () => {
    await asClients([DURAND], async (tx) => {
      const [member] = await tx.execute(sql`select id from client_members`)
      // Depuis l'espace, une réservation porte la personne qui la fait (ADR 036).
      await tx.execute(sql`
        insert into bookings (resource_id, client_id, channel, starts_at, ends_at, title, booked_by_member_id)
        values (${BUREAU}, ${DURAND}, 'client', '2026-11-02T08:00:00Z', '2026-11-02T09:00:00Z', 'Rendez-vous',
                ${member.id as string})`)
      const [scan] = await tx.execute(sql`select id from mail_scans`)
      await tx.execute(sql`
        insert into mail_scan_views (mail_scan_id, viewer, client_member_id, auth_user_id)
        values (${scan.id as string}, 'client', ${member.id as string}, 'u-1')`)
    })
  })

  it('la portée retombe à la fin de la transaction', async () => {
    await asClients([DURAND], (tx) => tx.execute(sql`select 1`))
    // Même connexion (pool d'une seule) : le back-office revoit tout.
    assert.equal((await compter(asTenant)).clients, 2)
    const [row] = await app.client`select current_client_ids() as ids`
    assert.equal(row.ids, null)
  })

  it('donne les créneaux occupés de tous, sans dire par qui', async () => {
    const creneaux = await asClients([DURAND], (tx) =>
      tx.execute(sql`
        select * from booking_busy_ranges('2026-10-01T00:00:00Z', '2026-10-31T00:00:00Z')`),
    )
    assert.equal(creneaux.length, 3)
    assert.deepEqual(Object.keys(creneaux[0]).sort(), ['ends_at', 'resource_id', 'starts_at'])

    const bureau = await asClients([DURAND], (tx) =>
      tx.execute(sql`
        select * from booking_busy_ranges('2026-10-01T00:00:00Z', '2026-10-31T00:00:00Z', array[${BUREAU}::uuid])`),
    )
    assert.equal(bureau.length, 0)
  })

  it('ne compte pas les créneaux annulés ni ceux d’un autre centre', async () => {
    await asTenant((tx) =>
      tx.execute(sql`update bookings set status = 'cancelled', cancelled_at = now() where title = 'Entretien'`),
    )
    await owner.client`
      insert into tenants (id, name, slug) values (${AUTRE_CENTRE}, 'Autre centre', 'autre-centre-portee')`
    const ailleurs = await withTenant(AUTRE_CENTRE, (tx) =>
      tx.execute(sql`select * from booking_busy_ranges('2026-10-01T00:00:00Z', '2026-10-31T00:00:00Z')`),
    app.db)
    assert.equal(ailleurs.length, 0)
    const ici = await asClients([PETIT], (tx) =>
      tx.execute(sql`select * from booking_busy_ranges('2026-10-01T00:00:00Z', '2026-10-31T00:00:00Z')`),
    )
    assert.equal(ici.length, 2)
  })

  it('refuse une portée mal formée avant d’atteindre la base', async () => {
    await assert.rejects(
      withClientScope(DEFAULT_TENANT_ID, ['x}', DURAND], async () => undefined, app.db),
      /Portée client invalide/,
    )
  })
})
