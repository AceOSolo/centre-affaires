import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { eq, inArray, sql } from 'drizzle-orm'

import { DB_INSUFFICIENT_PRIVILEGE, dbErrorCode } from '../../db/errors.ts'
import { withTenant } from '../../db/index.ts'
import { ouvrirBasesDeTest, raisonDeSaut, type TestDatabases } from '../../db/test-support.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { uuidv7 } from '../../lib/uuid.ts'
import {
  cancelOpeningRequest,
  findScanForAccounts,
  listMail,
  listMailForAccounts,
  logScanView,
  requestOpening,
} from '../courrier/queries.ts'
import { mailItems, mailScanViews } from '../courrier/schema.ts'
import { cancelRequestForAccounts, listBookingsForAccounts } from '../reservations/compte-queries.ts'
import { bookings } from '../reservations/schema.ts'
import { inClientSpace, type ClientAccount } from './comptes.ts'
import { findAccountHistoryStart, loadAccountHistory } from './historique-compte-queries.ts'
import { clientContacts, clientMembers, clients } from './schema.ts'
import { lire, toutVider } from './test-support.ts'

/**
 * Isolation des entreprises dans l'espace client (R28, ADR 019), éprouvée
 * avec le code de l'espace lui-même.
 *
 * MySQL n'a pas de Row Level Security : **la base ne filtre plus les
 * lectures** (ADR 042). Chaque requête exécutée sous `inClientSpace` filtre
 * donc elle-même sur les entreprises du compte, et ce fichier prouve, pour
 * chaque lecture du portail, que celle de l'entreprise voisine n'en sort pas.
 * Les écritures, elles, restent gardées par les triggers de portée
 * (`30-clients.sql` et ceux des autres modules) : un `update` sans filtre
 * échoue au lieu de toucher l'autre entreprise.
 */
describe('espace client : une entreprise ne voit pas une autre', { skip: raisonDeSaut }, () => {
  let bases: TestDatabases

  const DURAND = '01a00000-0000-7000-8000-0000000ec001'
  const PETIT = '01a00000-0000-7000-8000-0000000ec002'
  const JEANNE = '01a00000-0000-7000-8000-0000000ec101'
  const PAUL = '01a00000-0000-7000-8000-0000000ec102'
  const SALLE = '01a00000-0000-7000-8000-0000000ec201'
  /** Écriture sous portée client hors de ses entreprises (`30-clients.sql`). */
  const CLIENT_SCOPE_REFUSED = 'CA015'

  /** Jeanne, connectée, gère l'atelier Durand et lui seul. */
  const durand: ClientAccount[] = [{ memberId: JEANNE, clientId: DURAND, clientName: 'Atelier Durand' }]

  const asTenant = <T>(run: Parameters<typeof withTenant<T>>[1]) =>
    withTenant(DEFAULT_TENANT_ID, run, bases.app.db)

  /** Identifiants des lignes de chaque entreprise, posées par `peupler`. */
  const ids: Record<string, { mail: string; scan: string; booking: string }> = {}

  const peupler = async (clientId: string, memberId: string, index: number) => {
    const booking = uuidv7()
    const item = uuidv7()
    const scan = uuidv7()
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
      await tx.execute(sql`
        insert into bookings (id, resource_id, client_id, kind, channel, status, title, starts_at, ends_at)
        values (${booking}, ${SALLE}, ${clientId}, 'booking', 'client', 'pending', ${`Réunion ${index}`},
                date_add(now(3), interval ${index + 2} day),
                date_add(date_add(now(3), interval ${index + 2} day), interval 1 hour))`)
      await tx.execute(sql`
        insert into mail_items (id, client_id, sender) values (${item}, ${clientId}, ${`Expéditeur ${index}`})`)
      await tx.execute(sql`
        insert into mail_scans (id, mail_item_id, side, storage_key, content_type, byte_size)
        values (${scan}, ${item}, 'envelope', ${`courrier/${clientId}.pdf`}, 'application/pdf', 100)`)
      await tx.execute(sql`
        insert into mail_scan_views (mail_scan_id, viewer, client_member_id, auth_user_id)
        values (${scan}, 'client', ${memberId}, ${`u-${index}`})`)
    })
    ids[clientId] = { mail: item, scan, booking }
  }

  const errorCode = async (run: () => Promise<unknown>) => {
    try {
      await run()
    } catch (error) {
      return dbErrorCode(error)
    }
    return undefined
  }

  before(async () => {
    bases = await ouvrirBasesDeTest()
    // Les requêtes de l'espace passent par la base du processus : celle des tests.
    ;(globalThis as { database?: unknown }).database = bases.app
  })

  beforeEach(async () => {
    await toutVider(bases.owner)
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
    await toutVider(bases.owner)
    delete (globalThis as { database?: unknown }).database
    await bases.fermer()
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
    // Un identifiant venu de l'URL, accepté sans vérifier à qui il est.
    assert.equal(await findScanForAccounts(ids[PETIT].scan, durand), undefined)
  })

  it('l’historique du compte ne remonte rien de l’entreprise voisine', async () => {
    const { sources } = await loadAccountHistory(durand, {
      year: new Date().getUTCFullYear(),
      timeZone: 'Europe/Paris',
    })
    assert.deepEqual(
      sources.bookings.map((row) => row.id),
      [ids[DURAND].booking],
    )
    for (const rubrique of Object.values(sources)) {
      for (const row of rubrique as unknown as { clientId: string; clientName: string }[]) {
        assert.equal(row.clientId, DURAND)
        assert.equal(row.clientName, 'Atelier Durand')
      }
    }
    // Le premier instant de l'historique vient lui aussi des seules entreprises du compte.
    assert.ok(await findAccountHistoryStart(durand))
    // Un compte sans entreprise n'a pas d'historique.
    assert.equal(await findAccountHistoryStart([]), null)
    const vide = await loadAccountHistory([], { year: 2026, timeZone: 'Europe/Paris' })
    assert.equal(vide.sources.bookings.length, 0)
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

  it('une écriture sans filtre sous la portée d’un client échoue, sans rien modifier chez l’autre', async () => {
    // Plus de politique qui « ne voit pas » l'autre ligne : c'est le trigger de
    // garde qui refuse, et la transaction entière est annulée.
    const code = await errorCode(() =>
      inClientSpace(durand, (tx) => tx.update(clientContacts).set({ phone: '0102030405' })),
    )
    assert.equal(code, CLIENT_SCOPE_REFUSED)
    const code2 = await errorCode(() =>
      inClientSpace(durand, (tx) => tx.update(clientMembers).set({ fullName: 'Détourné' })),
    )
    assert.equal(code2, CLIENT_SCOPE_REFUSED)
    const code3 = await errorCode(() =>
      inClientSpace(durand, (tx) => tx.update(clients).set({ notes: 'Détourné' })),
    )
    assert.equal(code3, CLIENT_SCOPE_REFUSED)

    const autres = await asTenant((tx) =>
      lire(
        tx,
        sql`select (select count(*) from client_contacts where client_id = ${PETIT} and phone is not null) as contacts,
                   (select count(*) from client_members where client_id = ${PETIT} and full_name is not null) as membres,
                   (select count(*) from clients where id = ${PETIT} and notes is not null) as clients`,
      ),
    )
    assert.deepEqual(
      { contacts: Number(autres[0].contacts), membres: Number(autres[0].membres), clients: Number(autres[0].clients) },
      { contacts: 0, membres: 0, clients: 0 },
    )
  })

  it('une écriture filtrée sur l’autre entreprise, ou une insertion pour elle, est refusée', async () => {
    assert.equal(
      await errorCode(() =>
        inClientSpace(durand, (tx) =>
          tx.update(clientContacts).set({ phone: '0102030405' }).where(eq(clientContacts.clientId, PETIT)),
        ),
      ),
      // Aucune ligne de Petit n'est écrite : le filtre `where` les atteint, le trigger les refuse.
      CLIENT_SCOPE_REFUSED,
    )
    assert.equal(
      await errorCode(() =>
        inClientSpace(durand, (tx) =>
          tx.execute(sql`insert into client_contacts (client_id, full_name) values (${PETIT}, 'Intrus')`),
        ),
      ),
      CLIENT_SCOPE_REFUSED,
    )
    // Pour ses propres entreprises, l'écriture passe.
    await inClientSpace(durand, (tx) =>
      tx.update(clientContacts).set({ phone: '0102030405' }).where(inArray(clientContacts.clientId, [DURAND])),
    )
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
    assert.equal(code, DB_INSUFFICIENT_PRIVILEGE)

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

  it('un compte sans entreprise ne voit rien et n’écrit rien', async () => {
    assert.deepEqual(await listMailForAccounts([]), [])
    assert.equal(await findScanForAccounts(ids[DURAND].scan, []), undefined)
    // Portée vide : défaut fermé, toute écriture est refusée.
    assert.equal(
      await errorCode(() =>
        inClientSpace([], (tx) =>
          tx.execute(sql`insert into client_contacts (client_id, full_name) values (${DURAND}, 'x')`),
        ),
      ),
      CLIENT_SCOPE_REFUSED,
    )
  })

  it('le back-office, sans portée, voit toujours toutes les entreprises', async () => {
    assert.deepEqual(
      (await listMail()).map((row) => row.clientId).sort(),
      [DURAND, PETIT].sort(),
    )
  })
})
