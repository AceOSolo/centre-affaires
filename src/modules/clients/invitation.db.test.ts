import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { hashPassword } from 'better-auth/crypto'
import { sql } from 'drizzle-orm'

import { withTenant } from '../../db/index.ts'
import { ouvrirBasesDeTest, raisonDeSaut, viderTables, type TestDatabases } from '../../db/test-support.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { prepareInvitationLink } from '../../lib/auth/invitation.ts'
import { createAuth, type Auth } from '../../lib/auth/server.ts'
import type { Message, SendResult } from '../../lib/courriel.ts'
import { resolveClientAccounts } from './comptes.ts'
import { latestInvitations, sendInvitation } from './invitation.ts'
import { memberAccessState } from './invitation-etat.ts'

/**
 * Création d'un compte client par l'accueil (ADR 059), de bout en bout,
 * contre la configuration réelle de Better Auth et une vraie base :
 * invitation, lien et durée de validité, choix du mot de passe, première
 * connexion, renvoi d'une invitation expirée, état sur la fiche.
 */
describe('invitation à l’espace client', { skip: raisonDeSaut }, () => {
  let bases: TestDatabases
  let auth: Auth

  const DURAND = '01a00000-0000-7000-8000-0000000c2c01'
  const JEANNE = '01a00000-0000-7000-8000-0000000c2d01'
  const PAUL = '01a00000-0000-7000-8000-0000000c2d02'
  const jeanne = 'jeanne@durand.exemple'
  const motDePasse = 'mot-de-passe-de-jeanne'

  let envoyes: Message[] = []
  const send = async (message: Message): Promise<SendResult> => {
    envoyes.push(message)
    return { status: 'sent', recipients: message.to, failed: [], error: null }
  }
  const options = () => ({ auth, database: bases.app.db, send })

  const lire = async (text: string, params: unknown[] = []) =>
    (await bases.owner.client.query(text, params))[0] as Record<string, unknown>[]

  /** Le lien du dernier courriel. */
  const lienRecu = () => {
    const lien = envoyes.at(-1)?.text.match(/http\S+\/reset-password\/\S+/)?.[0]
    assert.ok(lien, 'le courriel porte le lien')
    return lien
  }
  const jetonDe = (lien: string) => new URL(lien).pathname.split('/').at(-1) as string

  /** Ce que fait le navigateur en ouvrant le lien : Better Auth vérifie le jeton et redirige. */
  const ouvrir = async (lien: string) => {
    const reponse = await auth.handler(new Request(lien))
    assert.equal(reponse.status, 302)
    return new URL(reponse.headers.get('location') as string)
  }

  const viderComptes = async () => {
    await lire("delete from auth_verifications where identifier like 'reset-password:%'")
    await lire('delete from auth_users where email like ?', ['%@durand.exemple'])
  }

  before(async () => {
    // Aucun courriel réel, et la vérification d'adresse exigée comme en production.
    for (const nom of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD', 'MAIL_FROM']) delete process.env[nom]
    process.env.AUTH_SKIP_EMAIL_VERIFICATION = 'false'
    process.env.AUTH_SECRET ||= 'secret-de-test-de-l-invitation-0123456789abcdef'
    process.env.APP_URL ||= 'http://localhost:3000'
    bases = await ouvrirBasesDeTest()
    ;(globalThis as { database?: unknown }).database = bases.app
    auth = createAuth(bases.app.db)
  })

  beforeEach(async () => {
    envoyes = []
    await viderComptes()
    await viderTables(bases.owner, 'notification_deliveries', 'notification_templates', 'client_members', 'clients')
    await withTenant(
      DEFAULT_TENANT_ID,
      async (tx) => {
        await tx.execute(sql`insert into clients (id, name, status) values (${DURAND}, 'Atelier Durand', 'active')`)
        await tx.execute(sql`
          insert into client_members (id, client_id, email, full_name) values
            (${JEANNE}, ${DURAND}, ${jeanne}, 'Jeanne Durand'),
            (${PAUL}, ${DURAND}, 'paul@durand.exemple', null)`)
      },
      bases.app.db,
    )
  })

  after(async () => {
    await viderComptes()
    await viderTables(bases.owner, 'notification_deliveries', 'client_members', 'clients')
    delete (globalThis as { database?: unknown }).database
    await bases.fermer()
  })

  it('crée le compte, envoie le lien pour choisir son mot de passe, valable sept jours', async () => {
    const avant = Date.now()
    const issue = await sendInvitation(DURAND, jeanne, options())
    assert.equal(issue?.status, 'sent')
    assert.deepEqual(envoyes[0].to, [jeanne])
    assert.match(envoyes[0].text, /choisissez votre mot de passe en ouvrant ce lien, valable une fois, jusqu’au \w+ \d+ \w+ 2026 à \d{2}:\d{2}/)
    assert.match(envoyes[0].text, /Votre identifiant est votre adresse : jeanne@durand\.exemple\./)

    // Un compte sans mot de passe ni adresse confirmée : personne n'y entre sans le lien.
    const [compte] = await lire('select id, name, email_verified from auth_users where email = ?', [jeanne])
    assert.equal(compte.name, 'Jeanne Durand')
    assert.equal(Number(compte.email_verified), 0)
    assert.equal((await lire('select count(*) as n from auth_accounts where user_id = ?', [compte.id]))[0].n, 0)

    const [jeton] = await lire(
      "select value, expires_at from auth_verifications where identifier = concat('reset-password:', ?)",
      [jetonDe(lienRecu())],
    )
    assert.equal(jeton.value, compte.id)
    const septJours = 7 * 86_400_000
    const expire = (jeton.expires_at as Date).getTime()
    assert.ok(expire >= avant + septJours - 1000 && expire <= Date.now() + septJours + 1000)

    // L'invitation est au journal : la fiche dit « invitée ».
    const invitations = await latestInvitations([JEANNE, PAUL], { database: bases.app.db })
    assert.equal(invitations.get(JEANNE)?.status, 'sent')
    assert.equal(invitations.has(PAUL), false)
    assert.equal(memberAccessState({ authUserId: null }, invitations.get(JEANNE)).kind, 'invite')
  })

  it('mène au choix du mot de passe, confirme l’adresse, et ouvre l’espace à la première connexion', async () => {
    await sendInvitation(DURAND, jeanne, options())
    const lien = lienRecu()
    const arrivee = await ouvrir(lien)
    assert.equal(arrivee.pathname, '/auth/nouveau-mot-de-passe')
    assert.equal(arrivee.searchParams.get('invitation'), '1')
    const token = arrivee.searchParams.get('token')
    assert.equal(token, jetonDe(lien))

    // Sans mot de passe choisi, pas de connexion.
    await assert.rejects(auth.api.signInEmail({ body: { email: jeanne, password: motDePasse } }))

    assert.deepEqual(await auth.api.resetPassword({ body: { newPassword: motDePasse, token: token as string } }), {
      status: true,
    })
    const [compte] = await lire('select id, email_verified from auth_users where email = ?', [jeanne])
    assert.equal(Number(compte.email_verified), 1)

    // Première connexion : l'adresse est confirmée, la session s'ouvre.
    const session = await auth.api.signInEmail({ body: { email: jeanne, password: motDePasse } })
    assert.equal(session.user.email, jeanne)

    // L'espace client la rattache à son entreprise : l'accès devient actif.
    const entreprises = await withTenant(
      DEFAULT_TENANT_ID,
      (tx) => resolveClientAccounts(tx, { id: compte.id as string, email: jeanne, name: 'Jeanne Durand' }, { emailVerified: true }),
      bases.app.db,
    )
    assert.deepEqual(
      entreprises.map((entreprise) => entreprise.clientId),
      [DURAND],
    )
    const [acces] = await lire('select auth_user_id from client_members where id = ?', [JEANNE])
    assert.equal(acces.auth_user_id, compte.id)
    assert.equal(memberAccessState({ authUserId: acces.auth_user_id as string }, undefined).kind, 'actif')

    // Le lien a servi : il ne sert plus.
    assert.equal((await ouvrir(lien)).searchParams.get('error'), 'INVALID_TOKEN')
  })

  it('refuse un lien expiré ; l’invitation renvoyée en donne un neuf, pour le même compte', async () => {
    const huitJours = new Date(Date.now() - 8 * 86_400_000)
    const ancien = await prepareInvitationLink({ email: jeanne, name: 'Jeanne Durand' }, { auth, now: huitJours })
    assert.equal(ancien.created, true)
    const refus = await ouvrir(ancien.url)
    assert.equal(refus.pathname, '/auth/nouveau-mot-de-passe')
    assert.equal(refus.searchParams.get('error'), 'INVALID_TOKEN')
    await assert.rejects(auth.api.resetPassword({ body: { newPassword: motDePasse, token: jetonDe(ancien.url) } }))

    await sendInvitation(DURAND, jeanne, options())
    const neuf = await ouvrir(lienRecu())
    assert.ok(neuf.searchParams.get('token'))
    assert.equal(Number((await lire('select count(*) as n from auth_users where email = ?', [jeanne]))[0].n), 1)
  })

  it('reprend le compte d’une personne déjà inscrite, sans toucher à son mot de passe', async () => {
    // Jeanne a déjà un compte, pour l'espace d'une autre entreprise.
    const compte = '00000000-0059-4000-8000-000000000001'
    await lire(
      `insert into auth_users (id, name, email, email_verified, created_at, updated_at)
       values (?, 'Jeanne', ?, true, current_timestamp(3), current_timestamp(3))`,
      [compte, jeanne],
    )
    await lire(
      `insert into auth_accounts (id, account_id, provider_id, user_id, password, created_at, updated_at)
       values (uuid(), ?, 'credential', ?, ?, current_timestamp(3), current_timestamp(3))`,
      [compte, compte, await hashPassword(motDePasse)],
    )
    const premier = await prepareInvitationLink({ email: jeanne }, { auth })
    const second = await prepareInvitationLink({ email: jeanne }, { auth })
    assert.equal(premier.created, false)
    assert.notEqual(jetonDe(premier.url), jetonDe(second.url))
    assert.equal(Number((await lire('select count(*) as n from auth_users where email = ?', [jeanne]))[0].n), 1)
    // Son mot de passe reste le sien : elle se connecte comme avant.
    const session = await auth.api.signInEmail({ body: { email: jeanne, password: motDePasse } })
    assert.equal(session.user.id, compte)
    await lire('delete from auth_sessions where user_id = ?', [compte])
  })

  it('ne crée rien pour un accès retiré entre-temps', async () => {
    await lire('update client_members set deleted_at = current_timestamp(3) where id = ?', [JEANNE])
    assert.equal(await sendInvitation(DURAND, jeanne, options()), null)
    assert.equal(envoyes.length, 0)
    assert.equal(Number((await lire('select count(*) as n from auth_users where email = ?', [jeanne]))[0].n), 0)
  })
})
