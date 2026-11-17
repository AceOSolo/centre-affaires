import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'

import { DB_CLIENT_BELL_REFUSED, DB_CLIENT_SCOPE_REFUSED, DB_INSUFFICIENT_PRIVILEGE, dbErrorCode } from '../../db/errors.ts'
import { withClientScope, withTenant, type Transaction } from '../../db/index.ts'
import { ouvrirBasesDeTest, raisonDeSaut, viderTables, type TestDatabases } from '../../db/test-support.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import type { ClientAccount } from '../clients/comptes.ts'
import { loadMemberProfile, saveMemberProfile } from '../clients/mon-compte-queries.ts'
import { countMailForAccounts } from '../courrier/non-lus.ts'
import { clientBellEvents } from './cloche-client.ts'
import {
  clientBellFeed,
  clientBellUnreadCount,
  loadClientBellSettings,
  markClientBellRead,
  saveClientBellSettings,
} from './cloche-client-queries.ts'
import { findBroadcastForAccounts } from './diffusion-compte-queries.ts'

/**
 * Cloche de l'espace client (ADR 077), contre la base : nourrie par le journal
 * des messages, « lu » par personne, réglage du centre, refus de la base
 * (`CA023`) ; et, du même lot, le nombre de plis non lus, « Mon compte » et le
 * message du centre lu depuis l'espace.
 */
describe('cloche de l’espace client', { skip: raisonDeSaut }, () => {
  let bases: TestDatabases

  const DURAND = '01a00000-0000-7000-8000-0000000f7c01'
  const PETIT = '01a00000-0000-7000-8000-0000000f7c02'
  const JEANNE = '01a00000-0000-7000-8000-0000000f7d01'
  const JEANNE_PETIT = '01a00000-0000-7000-8000-0000000f7d02'
  const PAUL = '01a00000-0000-7000-8000-0000000f7d03'
  const CAMILLE = '01a00000-0000-7000-8000-0000000f7e01'
  const PLI = '01a00000-0000-7000-8000-0000000f7f01'
  const DEMANDE = '01a00000-0000-7000-8000-0000000f7f02'
  const MESSAGE = '01a00000-0000-7000-8000-0000000f7f03'

  const durand: ClientAccount = { memberId: JEANNE, clientId: DURAND, clientName: 'Atelier Durand' }
  const jeannePetit: ClientAccount = { memberId: JEANNE_PETIT, clientId: PETIT, clientName: 'Boulangerie Petit' }
  const paul: ClientAccount = { memberId: PAUL, clientId: PETIT, clientName: 'Boulangerie Petit' }

  const NOW = new Date('2026-11-17T10:00:00Z')
  const ilYA = (heures: number) => new Date(NOW.getTime() - heures * 3_600_000)
  const timeZone = 'Europe/Paris'

  const asTenant = <T>(run: (tx: Transaction) => Promise<T>) => withTenant(DEFAULT_TENANT_ID, run, bases.app.db)
  const feed = (accounts: ClientAccount[]) => clientBellFeed(accounts, { timeZone, now: NOW, database: bases.app.db })
  const compter = async (table: string) =>
    Number(((await bases.owner.client.query(`select count(*) as n from ${table}`))[0] as { n: number }[])[0].n)
  const code = async (run: () => Promise<unknown>) => {
    try {
      await run()
    } catch (error) {
      return dbErrorCode(error)
    }
    return undefined
  }

  let seq = 0
  /** Une ligne du journal ; rend son identifiant. */
  const envoi = async (values: {
    event: string
    clientId?: string | null
    audience?: string
    sentAt?: Date
    related?: [string, string]
    subject?: string
  }) => {
    seq += 1
    const id = `01a00000-0000-7000-8000-0000000f8${String(seq).padStart(3, '0')}`
    await asTenant((tx) =>
      tx.execute(sql`
        insert into notification_deliveries
          (id, event, audience, client_id, recipients, subject, status, sent_at, related_type, related_id)
        values (${id}, ${values.event}, ${values.audience ?? 'client'}, ${values.clientId === undefined ? DURAND : values.clientId},
                ${JSON.stringify(['jeanne@durand.fr'])}, ${values.subject ?? `Objet ${seq}`}, 'sent',
                ${values.sentAt ?? ilYA(seq)}, ${values.related?.[0] ?? null}, ${values.related?.[1] ?? null})`),
    )
    return id
  }

  before(async () => {
    bases = await ouvrirBasesDeTest()
  })

  beforeEach(async () => {
    seq = 0
    await viderTables(
      bases.owner,
      'client_notification_reads',
      'client_bell_settings',
      'notification_deliveries',
      'client_broadcast_recipients',
      'client_broadcasts',
      'mail_requests',
      'mail_item_member_states',
      'mail_items',
      'client_members',
      'clients',
      'staff_members',
    )
    await asTenant(async (tx) => {
      await tx.execute(sql`insert into staff_members (id, email, full_name, role) values (${CAMILLE}, 'camille@centre.exemple', 'Camille Martin', 'admin')`)
      await tx.execute(sql`
        insert into clients (id, name, status) values
          (${DURAND}, 'Atelier Durand', 'active'), (${PETIT}, 'Boulangerie Petit', 'active')`)
      await tx.execute(sql`
        insert into client_members (id, client_id, email, full_name) values
          (${JEANNE}, ${DURAND}, 'jeanne@durand.fr', 'Jeanne Durand'),
          (${JEANNE_PETIT}, ${PETIT}, 'jeanne@durand.fr', null),
          (${PAUL}, ${PETIT}, 'paul@petit.fr', 'Paul Petit')`)
    })
  })

  after(async () => {
    await viderTables(bases.owner, 'client_notification_reads', 'client_bell_settings', 'notification_deliveries')
    await bases.fermer()
  })

  describe('ce qui la nourrit', () => {
    it('lit les messages au client de ses entreprises, des natures retenues, de la période', async () => {
      const tournee = await envoi({ event: 'mail_batch_received', related: ['mail_batch', PLI] })
      const scan = await envoi({ event: 'mail_scanned', related: ['mail_item', PLI] })
      await envoi({ event: 'mail_none' })
      await envoi({ event: 'invoice_issued' })
      await envoi({ event: 'booking_request_submitted', audience: 'centre', clientId: DURAND })
      // Trente et un jours : sortie de la cloche.
      await envoi({ event: 'mail_scanned', sentAt: ilYA(31 * 24) })
      // Une autre entreprise.
      await envoi({ event: 'client_broadcast', clientId: PETIT })

      const vue = await feed([durand])
      assert.equal(vue.count, 2)
      assert.deepEqual(
        vue.items.map((item) => [item.id, item.label, item.read, item.who]),
        [
          [tournee, 'Courrier reçu', false, null],
          [scan, 'Numérisation prête', false, null],
        ],
      )
      assert.equal(vue.items[1]?.href, `/compte/courrier/${PLI}`)
      assert.equal(await clientBellUnreadCount([durand], { now: NOW, database: bases.app.db }), 2)
    })

    it('réunit les entreprises du compte et les nomme', async () => {
      await envoi({ event: 'mail_scanned' })
      await envoi({ event: 'client_broadcast', clientId: PETIT, related: ['client_broadcast', MESSAGE] })
      const vue = await feed([durand, jeannePetit])
      assert.equal(vue.count, 2)
      assert.deepEqual(
        vue.items.map((item) => [item.who, item.href]),
        [
          ['Atelier Durand', '/compte/courrier'],
          ['Boulangerie Petit', `/compte/messages/${MESSAGE}`],
        ],
      )
    })

    it('mène une demande de courrier traitée à la fiche de son pli', async () => {
      await asTenant(async (tx) => {
        await tx.execute(sql`insert into mail_items (id, client_id) values (${PLI}, ${DURAND})`)
        await tx.execute(sql`
          insert into mail_requests (id, mail_item_id, client_id, kind, requested_by_member_id)
          values (${DEMANDE}, ${PLI}, ${DURAND}, 'open_and_scan', ${JEANNE})`)
      })
      await envoi({ event: 'mail_request_done', related: ['mail_request', DEMANDE] })
      const [item] = (await feed([durand])).items
      assert.equal(item?.label, 'Demande de courrier traitée')
      assert.equal(item?.href, `/compte/courrier/${PLI}`)
    })
  })

  describe('lu, personne par personne', () => {
    it('marque lue une nouveauté ouverte, pour la personne seule, une fois', async () => {
      const message = await envoi({ event: 'client_broadcast', clientId: PETIT })
      await envoi({ event: 'mail_received', clientId: PETIT })

      assert.equal(await markClientBellRead([durand, jeannePetit], [message], { now: NOW, database: bases.app.db }), 1)
      // Rejouer ne change rien.
      assert.equal(await markClientBellRead([durand, jeannePetit], [message], { now: NOW, database: bases.app.db }), 0)

      const jeanne = await feed([durand, jeannePetit])
      assert.equal(jeanne.count, 1)
      assert.equal(jeanne.items.find((item) => item.id === message)?.read, true)
      // Paul, de la même entreprise, ne l'a pas ouverte.
      assert.equal((await feed([paul])).count, 2)
    })

    it('ne marque rien hors des entreprises du compte', async () => {
      const ailleurs = await envoi({ event: 'client_broadcast', clientId: PETIT })
      assert.equal(await markClientBellRead([durand], [ailleurs], { now: NOW, database: bases.app.db }), 0)
      assert.equal(await compter('client_notification_reads'), 0)
    })

    it('marque tout comme lu, sur la période', async () => {
      await envoi({ event: 'mail_scanned' })
      await envoi({ event: 'booking_confirmed', related: ['booking', PLI] })
      const ancien = await envoi({ event: 'mail_scanned', sentAt: ilYA(40 * 24) })
      assert.equal(await markClientBellRead([durand], 'toutes', { now: NOW, database: bases.app.db }), 2)
      assert.equal((await feed([durand])).count, 0)
      const [lu] = (await bases.owner.client.query('select delivery_id as id from client_notification_reads where delivery_id = ?', [ancien]))[0] as { id: string }[]
      assert.equal(lu, undefined)
    })
  })

  describe('réglage du centre', () => {
    it('retire des natures, raccourcit la période, en une ligne par centre', async () => {
      await envoi({ event: 'mail_scanned', sentAt: ilYA(30) })
      await envoi({ event: 'client_broadcast', sentAt: ilYA(1) })

      assert.deepEqual(await loadClientBellSettings(bases.app.db), { hiddenEvents: [], windowDays: 30 })
      await saveClientBellSettings({ hiddenEvents: ['client_broadcast'], windowDays: 2 }, CAMILLE, bases.app.db)
      assert.equal((await feed([durand])).count, 1)
      await saveClientBellSettings({ hiddenEvents: ['mail_scanned'], windowDays: 1 }, CAMILLE, bases.app.db)
      assert.equal((await feed([durand])).count, 1)
      assert.equal((await feed([durand])).items[0]?.label, 'Message du centre')
      assert.equal(await compter('client_bell_settings'), 1)

      // Tout retiré : la cloche se tait, rien ne se marque.
      await saveClientBellSettings({ hiddenEvents: [...clientBellEvents], windowDays: 30 }, CAMILLE, bases.app.db)
      assert.deepEqual(await feed([durand]), { count: 0, items: [] })
      assert.equal(await markClientBellRead([durand], 'toutes', { now: NOW, database: bases.app.db }), 0)
    })

    it('refuse le réglage sous portée client, et sa suppression', async () => {
      const refuse = await code(() =>
        withClientScope(
          DEFAULT_TENANT_ID,
          [DURAND],
          (tx) => tx.execute(sql`insert into client_bell_settings (window_days) values (5)`),
          bases.app.db,
        ),
      )
      assert.equal(refuse, DB_INSUFFICIENT_PRIVILEGE)
      await saveClientBellSettings({ hiddenEvents: [], windowDays: 7 }, CAMILLE, bases.app.db)
      assert.equal(await code(() => asTenant((tx) => tx.execute(sql`delete from client_bell_settings`))), DB_CLIENT_BELL_REFUSED)
    })
  })

  describe('règles de la base (CA023)', () => {
    const lecture = (clientId: string, memberId: string, deliveryId: string) =>
      sql`insert into client_notification_reads (client_id, client_member_id, delivery_id)
          values (${clientId}, ${memberId}, ${deliveryId})`

    it('refuse une lecture d’un message d’une autre entreprise, ou adressé au centre', async () => {
      const petit = await envoi({ event: 'client_broadcast', clientId: PETIT })
      const centre = await envoi({ event: 'booking_request_submitted', audience: 'centre', clientId: DURAND })
      assert.equal(await code(() => asTenant((tx) => tx.execute(lecture(DURAND, JEANNE, petit)))), DB_CLIENT_BELL_REFUSED)
      assert.equal(await code(() => asTenant((tx) => tx.execute(lecture(DURAND, JEANNE, centre)))), DB_CLIENT_BELL_REFUSED)
    })

    it('refuse hors de la portée du compte, et l’effacement depuis l’espace', async () => {
      const petit = await envoi({ event: 'client_broadcast', clientId: PETIT })
      const hors = await code(() =>
        withClientScope(DEFAULT_TENANT_ID, [DURAND], (tx) => tx.execute(lecture(PETIT, PAUL, petit)), bases.app.db),
      )
      assert.equal(hors, DB_CLIENT_SCOPE_REFUSED)

      await withClientScope(DEFAULT_TENANT_ID, [PETIT], (tx) => tx.execute(lecture(PETIT, PAUL, petit)), bases.app.db)
      const efface = await code(() =>
        withClientScope(DEFAULT_TENANT_ID, [PETIT], (tx) => tx.execute(sql`delete from client_notification_reads`), bases.app.db),
      )
      assert.equal(efface, DB_CLIENT_BELL_REFUSED)
      const deplace = await code(() =>
        asTenant((tx) => tx.execute(sql`update client_notification_reads set client_member_id = ${JEANNE_PETIT}`)),
      )
      assert.equal(deplace, DB_CLIENT_BELL_REFUSED)
    })

    it('laisse la purge du journal emporter les lectures', async () => {
      const message = await envoi({ event: 'mail_scanned' })
      await markClientBellRead([durand], [message], { now: NOW, database: bases.app.db })
      const connexion = await bases.owner.client.getConnection()
      try {
        await connexion.query('set @app_notification_purge = 1')
        await connexion.query('delete from notification_deliveries where id = ?', [message])
        await connexion.query('set @app_notification_purge = null')
      } finally {
        connexion.release()
      }
      assert.equal(await compter('client_notification_reads'), 0)
    })
  })

  describe('plis non lus de la personne', () => {
    it('compte les plis sans lecture, retirés exclus, chacun pour sa personne', async () => {
      await asTenant(async (tx) => {
        await tx.execute(sql`
          insert into mail_items (id, client_id) values
            ('01a00000-0000-7000-8000-0000000f9001', ${DURAND}),
            ('01a00000-0000-7000-8000-0000000f9002', ${DURAND}),
            ('01a00000-0000-7000-8000-0000000f9003', ${DURAND}),
            ('01a00000-0000-7000-8000-0000000f9004', ${PETIT})`)
        await tx.execute(sql`
          insert into mail_items (id, client_id, deleted_at)
          values ('01a00000-0000-7000-8000-0000000f9005', ${DURAND}, ${NOW})`)
        await tx.execute(sql`
          insert into mail_item_member_states (client_id, mail_item_id, client_member_id, read_at) values
            (${DURAND}, '01a00000-0000-7000-8000-0000000f9001', ${JEANNE}, ${NOW}),
            (${DURAND}, '01a00000-0000-7000-8000-0000000f9002', ${JEANNE}, null)`)
      })
      assert.deepEqual(await countMailForAccounts([durand], bases.app.db), { total: 3, unread: 2 })
      assert.deepEqual(await countMailForAccounts([durand, jeannePetit], bases.app.db), { total: 4, unread: 3 })
      assert.deepEqual(await countMailForAccounts([paul], bases.app.db), { total: 1, unread: 1 })
    })
  })

  describe('« Mon compte »', () => {
    it('écrit le prénom, le nom et le téléphone sur chaque accès de la personne, et seulement les siens', async () => {
      // Accès ouvert avant l'ADR 084 : le prénom et le nom sont tirés du nom complet.
      assert.deepEqual(await loadMemberProfile([durand, jeannePetit], bases.app.db), { firstName: 'Jeanne', lastName: 'Durand', fullName: 'Jeanne Durand', phone: null })
      await saveMemberProfile([durand, jeannePetit], { firstName: 'Jeanne Marie', lastName: 'Martin', fullName: 'Jeanne Marie Martin', phone: '06 12 34 56 78' }, bases.app.db)
      const [rows] = (await bases.owner.client.query(
        'select id, first_name as prenom, last_name as nom, full_name as complet, phone from client_members order by id',
      )) as unknown as [{ id: string; prenom: string | null; nom: string | null; complet: string | null; phone: string | null }[]]
      assert.deepEqual(
        rows.map((row) => [row.id, row.prenom, row.nom, row.complet, row.phone]),
        [
          [JEANNE, 'Jeanne Marie', 'Martin', 'Jeanne Marie Martin', '06 12 34 56 78'],
          [JEANNE_PETIT, 'Jeanne Marie', 'Martin', 'Jeanne Marie Martin', '06 12 34 56 78'],
          [PAUL, null, null, 'Paul Petit', null],
        ],
      )
      // Une fois saisis, le prénom composé et le nom se relisent tels quels.
      assert.deepEqual(await loadMemberProfile([durand], bases.app.db), { firstName: 'Jeanne Marie', lastName: 'Martin', fullName: 'Jeanne Marie Martin', phone: '06 12 34 56 78' })
    })

    it('efface le téléphone, le prénom et le nom à l’anonymisation de l’accès', async () => {
      await saveMemberProfile([paul], { firstName: 'Paul', lastName: 'Petit', fullName: 'Paul Petit', phone: '06 00 00 00 01' }, bases.app.db)
      await asTenant(async (tx) => {
        await tx.execute(sql`update client_members set deleted_at = current_timestamp(3) where id = ${PAUL}`)
        await tx.execute(sql`select anonymize_member_rows('client_members', ${PAUL}, null, 'retention', null)`)
      })
      const [[row]] = (await bases.owner.client.query(
        'select phone, first_name as prenom, last_name as nom, anonymized_at as anonymise from client_members where id = ?',
        [PAUL],
      )) as unknown as [{ phone: string | null; prenom: string | null; nom: string | null; anonymise: Date | null }[]]
      assert.ok(row?.anonymise)
      assert.equal(row?.phone, null)
      assert.equal(row?.prenom, null)
      assert.equal(row?.nom, null)
    })
  })

  describe('message du centre lu depuis l’espace', () => {
    it('se lit par les seules entreprises destinataires, une fois servies', async () => {
      await asTenant(async (tx) => {
        await tx.execute(sql`
          insert into client_broadcasts (id, subject, body, target, created_by)
          values (${MESSAGE}, 'Fermeture le 11 novembre', 'Le centre sera fermé.', 'selection', ${CAMILLE})`)
        await tx.execute(sql`
          insert into client_broadcast_recipients (broadcast_id, client_id, status, processed_at)
          values (${MESSAGE}, ${PETIT}, 'sent', ${NOW}), (${MESSAGE}, ${DURAND}, 'pending', null)`)
      })
      const lu = await findBroadcastForAccounts(MESSAGE, [paul], bases.app.db)
      assert.equal(lu?.subject, 'Fermeture le 11 novembre')
      assert.equal(lu?.body, 'Le centre sera fermé.')
      assert.equal(await findBroadcastForAccounts(MESSAGE, [durand], bases.app.db), undefined)
      assert.equal(await findBroadcastForAccounts('pas-un-uuid', [paul], bases.app.db), undefined)
    })
  })
})
