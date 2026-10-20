import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { solveChallenge } from 'altcha-lib'
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2'
import { hashPassword, verifyPassword } from 'better-auth/crypto'

import { ouvrirBasesDeTest, raisonDeSaut, type TestDatabases } from '../../db/test-support.ts'
import { EN_TETE_PREUVE } from '../champs-anti-robot.ts'
import { preuveHumaine } from '../preuve-humaine.ts'
import { createAuth, type Auth } from './server.ts'

/**
 * Mot de passe oublié, contre la configuration réelle de Better Auth
 * (`server.ts`) et une vraie base.
 *
 * Une erreur ici laisse un robot faire partir des courriels vers n'importe
 * quelle adresse, dit à un inconnu quelles adresses ont un compte, ou laisse
 * ouvertes les sessions de quelqu'un qui vient de changer son mot de passe.
 */
describe('mot de passe oublié', { skip: raisonDeSaut }, () => {
  let bases: TestDatabases
  let auth: Auth

  const U_CAMILLE = '00000000-0051-4000-8000-000000000001'
  const camille = 'camille@exemple.test'
  const ancien = 'ancien-mot-de-passe'
  const nouveau = 'nouveau-mot-de-passe'
  const redirectTo = '/auth/nouveau-mot-de-passe'

  const requete = async <T>(sql: string, valeurs: unknown[] = []) =>
    ((await bases.owner.client.query(sql, valeurs)) as unknown as [T[]])[0]

  /**
   * Ce qu'envoie le widget : le défi du serveur et sa solution, en JSON encodé
   * en base 64. Au réglage de production : quelques secondes de calcul.
   */
  const preuve = async () => {
    const challenge = await preuveHumaine().defi()
    const solution = await solveChallenge({ challenge, deriveKey })
    assert.ok(solution)
    return btoa(JSON.stringify({ challenge, solution }))
  }

  const demander = async (email: string, enTetes: Record<string, string> = {}) =>
    auth.api.requestPasswordReset({ body: { email, redirectTo }, headers: new Headers(enTetes) })

  /** Jetons de réinitialisation en base, tous comptes confondus. */
  const jetons = async () =>
    (
      await requete<{ identifier: string }>(
        "select identifier from auth_verifications where identifier like 'reset-password:%'",
      )
    ).map((ligne) => ligne.identifier.slice('reset-password:'.length))

  const motDePasse = async () =>
    (
      await requete<{ password: string }>(
        "select password from auth_accounts where user_id = ? and provider_id = 'credential'",
        [U_CAMILLE],
      )
    )[0].password

  const sessions = async () =>
    Number((await requete<{ n: number }>('select count(*) as n from auth_sessions where user_id = ?', [U_CAMILLE]))[0].n)

  const viderComptes = async () => {
    await bases.owner.client.query("delete from auth_verifications where identifier like 'reset-password:%'")
    await bases.owner.client.query("delete from auth_users where id like '00000000-0051-%'")
  }

  before(async () => {
    // Aucun courriel ne part d'un test, même quand `.env.local` configure le SMTP.
    for (const nom of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD', 'MAIL_FROM']) delete process.env[nom]
    bases = await ouvrirBasesDeTest()
    // Le refus des comptes bannis, à l'ouverture d'une session, passe par
    // `withTenant()` : la base du processus est celle des tests.
    ;(globalThis as { database?: unknown }).database = bases.app
    auth = createAuth(bases.app.db)
  })

  beforeEach(async () => {
    await viderComptes()
    await bases.owner.client.query(
      `insert into auth_users (id, name, email, email_verified, created_at, updated_at)
       values (?, 'Camille', ?, true, current_timestamp(3), current_timestamp(3))`,
      [U_CAMILLE, camille],
    )
    await bases.owner.client.query(
      `insert into auth_accounts (id, account_id, provider_id, user_id, password, created_at, updated_at)
       values (uuid(), ?, 'credential', ?, ?, current_timestamp(3), current_timestamp(3))`,
      [U_CAMILLE, U_CAMILLE, await hashPassword(ancien)],
    )
  })

  after(async () => {
    await viderComptes()
    delete (globalThis as { database?: unknown }).database
    await bases.fermer()
  })

  it('refuse une demande sans preuve anti-robot', async () => {
    await assert.rejects(demander(camille), (erreur: { body?: { code?: string } }) => {
      assert.equal(erreur.body?.code, 'PREUVE_HUMAINE')
      return true
    })
    await assert.rejects(demander(camille, { [EN_TETE_PREUVE]: 'inventée' }))
    assert.deepEqual(await jetons(), [])
  })

  it('répond pareil que l’adresse ait un compte ou non, et ne crée de lien que pour un compte', async () => {
    const inconnue = await demander('personne@exemple.test', { [EN_TETE_PREUVE]: await preuve() })
    const connue = await demander(camille, { [EN_TETE_PREUVE]: await preuve() })
    assert.deepEqual(inconnue, connue)
    assert.equal((await jetons()).length, 1)
  })

  it('change le mot de passe une seule fois, et ferme les sessions ouvertes', async () => {
    await bases.owner.client.query(
      `insert into auth_sessions (id, expires_at, token, created_at, updated_at, user_id)
       values (uuid(), current_timestamp(3) + interval 1 day, uuid(), current_timestamp(3), current_timestamp(3), ?)`,
      [U_CAMILLE],
    )
    await demander(camille, { [EN_TETE_PREUVE]: await preuve() })
    const [jeton] = await jetons()

    assert.deepEqual(await auth.api.resetPassword({ body: { newPassword: nouveau, token: jeton } }), { status: true })
    assert.equal(await verifyPassword({ hash: await motDePasse(), password: nouveau }), true)
    assert.equal(await sessions(), 0)

    // Le lien a servi : il ne sert plus.
    await assert.rejects(auth.api.resetPassword({ body: { newPassword: 'encore-un-autre', token: jeton } }), (erreur: {
      body?: { code?: string }
    }) => {
      assert.equal(erreur.body?.code, 'INVALID_TOKEN')
      return true
    })
  })

  it('refuse un nouveau mot de passe trop court, sans consommer le lien', async () => {
    await demander(camille, { [EN_TETE_PREUVE]: await preuve() })
    const [jeton] = await jetons()

    await assert.rejects(auth.api.resetPassword({ body: { newPassword: 'court', token: jeton } }), (erreur: {
      body?: { code?: string }
    }) => {
      assert.equal(erreur.body?.code, 'PASSWORD_TOO_SHORT')
      return true
    })
    assert.equal(await verifyPassword({ hash: await motDePasse(), password: ancien }), true)
    assert.deepEqual(await jetons(), [jeton])
  })
})
