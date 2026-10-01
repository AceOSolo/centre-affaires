import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { eq, sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import { PG_INSUFFICIENT_PRIVILEGE, pgErrorCode } from '../../db/errors.ts'
import { createDatabase, withTenant } from '../../db/index.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { contracts } from '../contrats/schema.ts'
import {
  cancelOpeningRequest,
  findScanForAccounts,
  listMail,
  listMailForAccounts,
  logScanView,
  requestOpening,
} from '../courrier/queries.ts'
import { mailItems, mailScans, mailScanViews } from '../courrier/schema.ts'
import { cancelRequestForAccounts, listBookingsForAccounts } from '../reservations/compte-queries.ts'
import { bookings } from '../reservations/schema.ts'
import { inClientSpace, type ClientAccount } from './comptes.ts'
import { clientContacts, clientMembers, clients } from './schema.ts'

/**
 * Isolation des entreprises dans l'espace client (R28, ADR 019), éprouvée
 * avec le code de l'espace lui-même.
 *
 * `src/db/portee-client.db.test.ts` prouve les politiques en SQL. Ici, on
 * prouve que l'espace client s'en sert : ses requêtes passent par
 * `inClientSpace`, et une requête qui oublierait son filtre — ou filtrerait
 * sur la mauvaise entreprise — ne rendrait toujours que les lignes de
 * l'entreprise du compte connecté.
 *
 * Sous le rôle applicatif, soumis à la RLS : sous le propriétaire, tout
 * passerait sans rien prouver.
 */
const ownerUrl = process.env.TEST_OWNER_DATABASE_URL ?? process.env.DATABASE_URL
const appUrl = process.env.TEST_DATABASE_URL

const raison = !appUrl
  ? 'TEST_DATABASE_URL non défini'
  : !ownerUrl
    ? 'TEST_OWNER_DATABASE_URL non défini'
    : false

describe('espace client : une entreprise ne voit pas une autre', { skip: raison }, () => {
  // Les requêtes de l'espace ouvrent leur propre connexion, par APP_DATABASE_URL.
  if (appUrl) process.env.APP_DATABASE_URL = appUrl

  const owner = createDatabase(ownerUrl ?? '', { onnotice: () => {} })
  const app = createDatabase(appUrl ?? '')

  const DURAND = '01a00000-0000-7000-8000-0000000ec001'
  const PETIT = '01a00000-0000-7000-8000-0000000ec002'
  const JEANNE = '01a00000-0000-7000-8000-0000000ec101'
  const PAUL = '01a00000-0000-7000-8000-0000000ec102'
  const SALLE = '01a00000-0000-7000-8000-0000000ec201'

  /** Jeanne, connectée, gère l'atelier Durand et lui seul. */
  const durand: ClientAccount[] = [{ memberId: JEANNE, clientId: DURAND, clientName: 'Atelier Durand' }]

  const asTenant = <T>(run: Parameters<typeof withTenant<T>>[1]) =>
    withTenant(DEFAULT_TENANT_ID, run, app.db)

  /** Identifiants des lignes de chaque entreprise, posées par `peupler`. */
  const ids: Record<string, { mail: string; scan: string; booking: string }> = {}

  const peupler = async (clientId: string, memberId: string, index: number) => {
    await asTenant(async (tx) => {
      await tx.execute(sql`
        insert into client_members (id, client_id, email, auth_user_id)
        values (${memberId}, ${clientId}, ${`gerant${index}@exemple.fr`}, ${`u-${index}`})`)
      await tx.execute(sql`
        insert into client_contacts (client_id, full_name, is_primary)
        values (${clientId}, ${`Contact ${index}`}, true)`)
      await tx.execute(sql`
        insert into contracts (client_id, contract_type, starts_on, amount_cents)
        values (${clientId}, 'domiciliation', '2026-01-01', 9000)`)
      const [booking] = await tx.execute(sql`
        insert into bookings (resource_id, client_id, kind, channel, status, title, starts_at, ends_at)
        values (${SALLE}, ${clientId}, 'booking', 'client', 'pending', ${`Réunion ${index}`},
                now() + make_interval(days => ${index + 2}),
                now() + make_interval(days => ${index + 2}, hours => 1))
        returning id`)
      const [item] = await tx.execute(sql`
        insert into mail_items (client_id, sender) values (${clientId}, ${`Expéditeur ${index}`})
        returning id`)
      const [scan] = await tx.execute(sql`
        insert into mail_scans (mail_item_id, side, storage_key, content_type, byte_size)
        values (${item.id as string}, 'envelope', ${`courrier/${clientId}.pdf`}, 'application/pdf', 100)
        returning id`)
      await tx.execute(sql`
        insert into mail_scan_views (mail_scan_id, viewer, client_member_id, auth_user_id)
        values (${scan.id as string}, 'client', ${memberId}, ${`u-${index}`})`)
      ids[clientId] = {
        mail: item.id as string,
        scan: scan.id as string,
        booking: booking.id as string,
      }
    })
  }

  const errorCode = async (run: () => Promise<unknown>) => {
    try {
      await run()
    } catch (error) {
      return pgErrorCode(error)
    }
    return undefined
  }

  before(async () => {
    await migrate(owner.db, { migrationsFolder: './src/db/migrations' })
  })

  beforeEach(async () => {
    await owner.client`truncate table bookings, contracts, rate_plan_items, rate_plans, clients, resources cascade`
    await owner.client`truncate table document_sequences`
    await asTenant(async (tx) => {
      await tx.execute(sql`
        insert into clients (id, name, status) values
          (${DURAND}, 'Atelier Durand', 'active'), (${PETIT}, 'Boulangerie Petit', 'active')`)
      await tx.execute(sql`
        insert into resources (id, resource_type, code, name) values (${SALLE}, 'salle', 'S-EC', 'Salle Europe')`)
    })
    await peupler(DURAND, JEANNE, 1)
    await peupler(PETIT, PAUL, 2)
  })

  after(async () => {
    const global = globalThis as { database?: { client: { end: () => Promise<void> } } }
    await Promise.all([owner.client.end(), app.client.end(), global.database?.client.end()])
  })

  it('une requête de l’espace sans aucun filtre ne rend que l’entreprise du compte', async () => {
    // Le filtre `where client_id in (…)` est oublié partout : la portée tient seule.
    const vu = await inClientSpace(durand, async (tx) => ({
      clients: await tx.select({ clientId: clients.id }).from(clients),
      membres: await tx.select({ clientId: clientMembers.clientId }).from(clientMembers),
      contacts: await tx.select({ clientId: clientContacts.clientId }).from(clientContacts),
      contrats: await tx.select({ clientId: contracts.clientId }).from(contracts),
      reservations: await tx.select({ clientId: bookings.clientId }).from(bookings),
      plis: await tx.select({ clientId: mailItems.clientId }).from(mailItems),
      numerisations: await tx.select({ id: mailScans.id }).from(mailScans),
      consultations: await tx.select({ id: mailScanViews.id }).from(mailScanViews),
    }))

    for (const table of ['clients', 'membres', 'contacts', 'contrats', 'reservations', 'plis'] as const) {
      assert.deepEqual(
        vu[table].map((row) => row.clientId),
        [DURAND],
        table,
      )
    }
    assert.deepEqual(
      vu.numerisations.map((row) => row.id),
      [ids[DURAND].scan],
    )
    assert.equal(vu.consultations.length, 1)
  })

  it('un filtre qui désigne l’autre entreprise ne rend rien', async () => {
    // Le cas d'un identifiant venu de l'URL, accepté sans vérifier à qui il est.
    const vu = await inClientSpace(durand, async (tx) => ({
      plis: await tx.select().from(mailItems).where(eq(mailItems.clientId, PETIT)),
      numerisation: await tx
        .select()
        .from(mailScans)
        .innerJoin(mailItems, eq(mailItems.id, mailScans.mailItemId))
        .where(eq(mailScans.id, ids[PETIT].scan)),
      reservation: await tx.select().from(bookings).where(eq(bookings.id, ids[PETIT].booking)),
    }))
    assert.deepEqual(vu, { plis: [], numerisation: [], reservation: [] })
  })

  it('une écriture de l’espace sans filtre n’atteint pas l’autre entreprise', async () => {
    const touches = await inClientSpace(durand, (tx) =>
      tx
        .update(mailItems)
        .set({ note: 'vu' })
        .returning({ clientId: mailItems.clientId }),
    )
    assert.deepEqual(
      touches.map((row) => row.clientId),
      [DURAND],
    )
    const [petit] = await asTenant((tx) =>
      tx.select({ note: mailItems.note }).from(mailItems).where(eq(mailItems.clientId, PETIT)),
    )
    assert.equal(petit.note, null)
  })

  it('les lectures du portail ne rendent que l’entreprise du compte', async () => {
    assert.deepEqual(
      (await listMailForAccounts(durand)).map((row) => row.clientId),
      [DURAND],
    )
    assert.deepEqual(
      (await listBookingsForAccounts(durand)).map((row) => row.id),
      [ids[DURAND].booking],
    )
    assert.ok(await findScanForAccounts(ids[DURAND].scan, durand))
    assert.equal(await findScanForAccounts(ids[PETIT].scan, durand), undefined)
  })

  it('les écritures du portail n’atteignent pas l’autre entreprise', async () => {
    assert.equal(await requestOpening(ids[PETIT].mail, durand), false)
    assert.equal(await cancelOpeningRequest(ids[PETIT].mail, durand), false)
    assert.equal(await cancelRequestForAccounts(ids[PETIT].booking, durand), false)

    const [pli] = await asTenant((tx) =>
      tx.select({ status: mailItems.status }).from(mailItems).where(eq(mailItems.id, ids[PETIT].mail)),
    )
    assert.equal(pli.status, 'received')
    const [reservation] = await asTenant((tx) =>
      tx.select({ status: bookings.status }).from(bookings).where(eq(bookings.id, ids[PETIT].booking)),
    )
    assert.equal(reservation.status, 'pending')

    // Les siennes passent, sous la même portée.
    assert.equal(await requestOpening(ids[DURAND].mail, durand), true)
    assert.equal(await cancelRequestForAccounts(ids[DURAND].booking, durand), true)
  })

  it('le journal d’accès refuse la consultation d’un pli d’une autre entreprise', async () => {
    // Même si la route avait laissé passer la numérisation de Petit, sa
    // consultation ne s'inscrirait pas au nom de Durand : et sans journal, pas
    // de fichier servi (`servir.ts`).
    const code = await errorCode(() =>
      logScanView({
        viewer: 'client',
        mailScanId: ids[PETIT].scan,
        clientMemberId: JEANNE,
        authUserId: 'u-1',
        clientId: DURAND,
      }),
    )
    assert.equal(code, PG_INSUFFICIENT_PRIVILEGE)

    await logScanView({
      viewer: 'client',
      mailScanId: ids[DURAND].scan,
      clientMemberId: JEANNE,
      authUserId: 'u-1',
      clientId: DURAND,
    })
    const vues = await asTenant((tx) =>
      tx.select().from(mailScanViews).where(eq(mailScanViews.mailScanId, ids[DURAND].scan)),
    )
    assert.equal(vues.length, 2)
  })

  it('un compte sans entreprise ne voit rien', async () => {
    const vu = await inClientSpace([], (tx) => tx.select().from(mailItems))
    assert.deepEqual(vu, [])
    assert.deepEqual(await listMailForAccounts([]), [])
  })

  it('le back-office, sans portée, voit toujours toutes les entreprises', async () => {
    assert.deepEqual(
      (await listMail()).map((row) => row.clientId).sort(),
      [DURAND, PETIT].sort(),
    )
  })
})
