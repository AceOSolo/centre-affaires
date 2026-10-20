import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'

import { withTenant, type Transaction } from '../../db/index.ts'
import { ouvrirBasesDeTest, raisonDeSaut, type TestDatabases } from '../../db/test-support.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import type { AuthenticatedUser } from '../../lib/auth/membre.ts'
import { resolveClientAccounts } from '../clients/comptes.ts'
import { lire, toutVider } from '../clients/test-support.ts'
import { activeBan, attachAccountToClient, banAccounts, liftBans, listAccounts } from './comptes.ts'
import { ensureSignupClient } from './inscription.ts'

/**
 * Inscription libre et comptes bannis (ADR 045), contre une vraie base.
 *
 * Une erreur ici crée une fiche client à quelqu'un dont l'équipe a retiré
 * l'accès, ou laisse se reconnecter un compte banni.
 */
describe('comptes du site', { skip: raisonDeSaut }, () => {
  let bases: TestDatabases

  const AUTRE_CENTRE = '01999f00-0000-7000-8000-0000000000fc'
  const EXPLOITANT = '01a00000-0000-7000-8000-0000000045e1'
  const HOLDING = '01a00000-0000-7000-8000-0000000045c1'
  const U_EXPLOITANT = '00000000-0045-4000-8000-000000000001'
  const U_JEANNE = '00000000-0045-4000-8000-000000000002'
  const U_PAUL = '00000000-0045-4000-8000-000000000003'

  const jeanne: AuthenticatedUser = { id: U_JEANNE, email: 'jeanne@exemple.test', name: 'Jeanne Durand' }
  const actor = { memberId: EXPLOITANT, authUserId: U_EXPLOITANT }

  const asTenant = <T>(run: (tx: Transaction) => Promise<T>, tenant = DEFAULT_TENANT_ID) =>
    withTenant(tenant, run, bases.app.db)

  const creerCompte = (id: string, email: string, companyName: string | null = null) =>
    bases.owner.client.query(
      `insert into auth_users (id, name, email, email_verified, company_name, created_at, updated_at)
       values (?, ?, ?, true, ?, current_timestamp(3), current_timestamp(3))`,
      [id, email.split('@')[0], email, companyName],
    )

  const ouvrirSession = (userId: string) =>
    bases.owner.client.query(
      `insert into auth_sessions (id, expires_at, token, created_at, updated_at, user_id)
       values (uuid(), current_timestamp(3) + interval 1 day, uuid(), current_timestamp(3), current_timestamp(3), ?)`,
      [userId],
    )

  const sessions = async (userId: string) => {
    const [rows] = (await bases.owner.client.query(
      'select count(*) as n from auth_sessions where user_id = ?',
      [userId],
    )) as unknown as [{ n: number }[]]
    return Number(rows[0].n)
  }

  const viderComptes = () =>
    bases.owner.client.query("delete from auth_users where id like '00000000-0045-%'")

  before(async () => {
    bases = await ouvrirBasesDeTest()
  })

  beforeEach(async () => {
    await toutVider(bases.owner)
    await bases.owner.client.query('delete from tenants where id <> ?', [DEFAULT_TENANT_ID])
    await viderComptes()
    await creerCompte(U_EXPLOITANT, 'exploitant@exemple.test')
    await creerCompte(U_JEANNE, jeanne.email, 'Durand Conseil')
    await creerCompte(U_PAUL, 'paul@exemple.test')
    await asTenant((tx) =>
      tx.execute(sql`
        insert into staff_members (id, email, auth_user_id, role)
        values (${EXPLOITANT}, 'exploitant@exemple.test', ${U_EXPLOITANT}, 'admin')
      `),
    )
    await asTenant((tx) =>
      tx.execute(sql`insert into clients (id, name, status) values (${HOLDING}, 'Durand Holding', 'active')`),
    )
  })

  after(async () => {
    await toutVider(bases.owner)
    await viderComptes()
    await bases.fermer()
  })

  describe('inscription libre', () => {
    it('crée une fiche prospect « inscrite en ligne » et y donne accès', async () => {
      assert.equal(await asTenant((tx) => ensureSignupClient(tx, jeanne)), true)

      const comptes = await asTenant((tx) => resolveClientAccounts(tx, jeanne))
      assert.deepEqual(comptes.map((c) => c.clientName), ['Durand Conseil'])
      const [fiche] = await asTenant((tx) =>
        lire(tx, sql`select status, origin, email from clients where id = ${comptes[0].clientId}`),
      )
      assert.deepEqual(fiche, { status: 'prospect', origin: 'inscription', email: jeanne.email })
    })

    it('ne crée qu’une fiche par compte', async () => {
      await asTenant((tx) => ensureSignupClient(tx, jeanne))
      assert.equal(await asTenant((tx) => ensureSignupClient(tx, jeanne)), false)
      const [{ n }] = await asTenant((tx) => lire(tx, sql`select count(*) as n from clients where origin = 'inscription'`))
      assert.equal(Number(n), 1)
    })

    it('sans raison sociale : le nom de la personne', async () => {
      const paul = { id: U_PAUL, email: 'paul@exemple.test', name: 'Paul Martin' }
      await asTenant((tx) => ensureSignupClient(tx, paul))
      const comptes = await asTenant((tx) => resolveClientAccounts(tx, paul))
      assert.deepEqual(comptes.map((c) => c.clientName), ['Paul Martin'])
    })

    it('ne recrée rien après le retrait de l’accès par l’équipe', async () => {
      await asTenant((tx) => ensureSignupClient(tx, jeanne))
      await asTenant((tx) => tx.execute(sql`update client_members set deleted_at = current_timestamp(3)`))

      assert.equal(await asTenant((tx) => ensureSignupClient(tx, jeanne)), false)
      assert.deepEqual(await asTenant((tx) => resolveClientAccounts(tx, jeanne)), [])
    })

    it('ne crée rien pour un membre de l’équipe', async () => {
      const exploitant = { id: U_EXPLOITANT, email: 'exploitant@exemple.test', name: null }
      assert.equal(await asTenant((tx) => ensureSignupClient(tx, exploitant)), false)
    })

    it('ne crée rien pour une adresse invitée par le centre, pas encore réclamée', async () => {
      // La résolution la rattache d'abord ; si elle ne l'a pas fait, la fiche
      // existante prime sur une fiche neuve.
      await asTenant((tx) =>
        tx.execute(sql`insert into client_members (client_id, email) values (${HOLDING}, ${jeanne.email})`),
      )
      assert.equal(await asTenant((tx) => ensureSignupClient(tx, jeanne)), false)
    })
  })

  describe('bannissement', () => {
    const ban = { reason: 'Inscriptions en masse', bannedUntil: null }

    it('bannit, ferme les sessions, et la connexion le voit', async () => {
      await ouvrirSession(U_JEANNE)
      const [outcome] = await asTenant((tx) => banAccounts(tx, { actor, authUserIds: [U_JEANNE], ban }))
      assert.equal(outcome.refusal, null)
      assert.equal(await sessions(U_JEANNE), 0)
      assert.ok(await asTenant((tx) => activeBan(tx, U_JEANNE)))

      const { rows } = await asTenant((tx) => listAccounts(tx, { state: 'banni' }))
      assert.deepEqual(rows.map((row) => row.id), [U_JEANNE])
    })

    it('refuse soi-même, un membre de l’équipe, un compte déjà banni', async () => {
      await asTenant((tx) => banAccounts(tx, { actor, authUserIds: [U_JEANNE], ban }))
      const outcomes = await asTenant((tx) =>
        banAccounts(tx, {
          actor: { memberId: EXPLOITANT, authUserId: U_PAUL },
          authUserIds: [U_PAUL, U_EXPLOITANT, U_JEANNE],
          ban,
        }),
      )
      assert.deepEqual(
        outcomes.map((o) => o.refusal),
        ['soi-meme', 'equipe', 'deja-banni'],
      )
    })

    it('un bannissement échu n’est plus en vigueur', async () => {
      await asTenant((tx) =>
        banAccounts(tx, {
          actor,
          authUserIds: [U_JEANNE],
          ban: { reason: 'x', bannedUntil: new Date(Date.now() + 60_000) },
        }),
      )
      assert.ok(await asTenant((tx) => activeBan(tx, U_JEANNE)))
      await asTenant((tx) =>
        tx.execute(sql`update account_bans set banned_until = current_timestamp(3) - interval 1 second`),
      )
      assert.equal(await asTenant((tx) => activeBan(tx, U_JEANNE)), undefined)
    })

    it('la levée rouvre le compte et garde la trace', async () => {
      await asTenant((tx) => banAccounts(tx, { actor, authUserIds: [U_JEANNE], ban }))
      assert.deepEqual(await asTenant((tx) => liftBans(tx, { actorMemberId: EXPLOITANT, authUserIds: [U_JEANNE] })), [U_JEANNE])
      assert.equal(await asTenant((tx) => activeBan(tx, U_JEANNE)), undefined)

      const [ligne] = await asTenant((tx) => lire(tx, sql`select lifted_by from account_bans`))
      assert.equal(ligne.lifted_by, EXPLOITANT)
      // Rien à lever une seconde fois.
      assert.deepEqual(await asTenant((tx) => liftBans(tx, { actorMemberId: EXPLOITANT, authUserIds: [U_JEANNE] })), [])
    })

    it('un bannissement d’un autre centre ne ferme pas celui-ci', async () => {
      await bases.owner.client.query(
        `insert into tenants (id, name, slug, timezone) values (?, 'Autre centre', 'autre', 'Europe/Paris')`,
        [AUTRE_CENTRE],
      )
      await bases.owner.client.query(
        `insert into staff_members (id, tenant_id, email, role) values (uuid(), ?, 'x@autre.test', 'admin')`,
        [AUTRE_CENTRE],
      )
      await bases.owner.client.query(
        `insert into account_bans (tenant_id, auth_user_id, reason, banned_by)
         select ?, ?, 'ailleurs', id from staff_members where tenant_id = ?`,
        [AUTRE_CENTRE, U_JEANNE, AUTRE_CENTRE],
      )
      assert.equal(await asTenant((tx) => activeBan(tx, U_JEANNE)), undefined)
      assert.ok(await asTenant((tx) => activeBan(tx, U_JEANNE), AUTRE_CENTRE))
    })
  })

  describe('rattachement à une entreprise', () => {
    it('donne l’accès à l’espace de l’entreprise, une seule fois', async () => {
      const result = await asTenant((tx) => attachAccountToClient(tx, { authUserId: U_JEANNE, clientId: HOLDING }))
      assert.deepEqual(result, { ok: true, clientName: 'Durand Holding' })
      const comptes = await asTenant((tx) => resolveClientAccounts(tx, jeanne))
      assert.deepEqual(comptes.map((c) => c.clientId), [HOLDING])

      const again = await asTenant((tx) => attachAccountToClient(tx, { authUserId: U_JEANNE, clientId: HOLDING }))
      assert.deepEqual(again, { ok: false, refusal: 'deja-rattache' })
    })

    it('refuse une entreprise archivée', async () => {
      await asTenant((tx) => tx.execute(sql`update clients set deleted_at = current_timestamp(3)`))
      const result = await asTenant((tx) => attachAccountToClient(tx, { authUserId: U_JEANNE, clientId: HOLDING }))
      assert.deepEqual(result, { ok: false, refusal: 'client-introuvable' })
    })
  })
})
