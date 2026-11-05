import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { hashPassword } from 'better-auth/crypto'
import { sql } from 'drizzle-orm'

import { withTenant } from '../../db/index.ts'
import { ouvrirBasesDeTest, raisonDeSaut, viderTables, type TestDatabases } from '../../db/test-support.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import type { Message, SendResult } from '../courriel.ts'
import { latestStaffInvitations, sendStaffInvitation } from './equipe-invitation.ts'
import { resolveStaffMember } from './membre.ts'
import { createAuth, type Auth } from './server.ts'

/**
 * Invitation dans l'équipe (ADR 068), de bout en bout, contre la
 * configuration réelle de Better Auth : courriel avec le lien, choix du mot de
 * passe aux textes de l'équipe, première connexion qui ouvre le back-office.
 * Et l'inscription libre, fermée : personne ne crée son compte seul.
 */
describe('invitation dans l’équipe', { skip: raisonDeSaut }, () => {
  let bases: TestDatabases
  let auth: Auth

  const LEA = '01a00000-0000-7000-8000-000000068e01'
  const RETIRE = '01a00000-0000-7000-8000-000000068e02'
  const lea = 'lea@equipe.exemple'
  const motDePasse = 'mot-de-passe-de-lea'

  let envoyes: Message[] = []
  const send = async (message: Message): Promise<SendResult> => {
    envoyes.push(message)
    return { status: 'sent', recipients: message.to, failed: [], error: null }
  }
  const options = () => ({ auth, database: bases.app.db, send })

  const lire = async (text: string, params: unknown[] = []) =>
    (await bases.owner.client.query(text, params))[0] as Record<string, unknown>[]
  const lienRecu = () => envoyes.at(-1)?.text.match(/http\S+\/reset-password\/\S+/)?.[0]
  const viderComptes = () => lire("delete from auth_users where email like '%@equipe.exemple'")

  before(async () => {
    for (const nom of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD', 'MAIL_FROM']) delete process.env[nom]
    process.env.AUTH_SKIP_EMAIL_VERIFICATION = 'false'
    process.env.AUTH_SECRET ||= 'secret-de-test-de-l-invitation-equipe-0123456789'
    process.env.APP_URL ||= 'http://localhost:3000'
    bases = await ouvrirBasesDeTest()
    ;(globalThis as { database?: unknown }).database = bases.app
    auth = createAuth(bases.app.db)
  })

  beforeEach(async () => {
    envoyes = []
    await viderComptes()
    await viderTables(bases.owner, 'notification_deliveries', 'notification_templates', 'staff_members', 'auth_verifications')
    await withTenant(
      DEFAULT_TENANT_ID,
      (tx) =>
        tx.execute(sql`
          insert into staff_members (id, email, role, full_name, deleted_at) values
            (${LEA}, ${lea}, 'staff', 'Léa Martin', null),
            (${RETIRE}, 'retire@equipe.exemple', 'staff', null, CURRENT_TIMESTAMP(3))`),
      bases.app.db,
    )
  })

  after(async () => {
    await viderComptes()
    await viderTables(bases.owner, 'notification_deliveries', 'staff_members')
    delete (globalThis as { database?: unknown }).database
    await bases.fermer()
  })

  it('envoie le lien vers le back-office, qui ouvre l’équipe à la première connexion', async () => {
    const issue = await sendStaffInvitation(LEA, options())
    assert.equal(issue?.status, 'sent')
    assert.deepEqual(envoyes[0].to, [lea])
    assert.match(envoyes[0].text, /vous a ajouté à son équipe, avec le rôle Accueil\./)
    assert.match(envoyes[0].text, /\/auth\/equipe/)

    // Le lien mène au choix du mot de passe, aux textes de l'équipe.
    const reponse = await auth.handler(new Request(lienRecu() as string))
    const arrivee = new URL(reponse.headers.get('location') as string)
    assert.equal(arrivee.pathname, '/auth/nouveau-mot-de-passe')
    assert.equal(arrivee.searchParams.get('invitation'), '1')
    assert.equal(arrivee.searchParams.get('espace'), 'equipe')
    await auth.api.resetPassword({
      body: { newPassword: motDePasse, token: arrivee.searchParams.get('token') as string },
    })

    // Première connexion : l'adresse est confirmée, le back-office s'ouvre.
    const session = await auth.api.signInEmail({ body: { email: lea, password: motDePasse } })
    const membre = await withTenant(
      DEFAULT_TENANT_ID,
      (tx) => resolveStaffMember(tx, { id: session.user.id, email: lea, name: 'Léa Martin' }, { emailVerified: true }),
      bases.app.db,
    )
    assert.equal(membre?.id, LEA)
    assert.equal(membre?.authUserId, session.user.id)

    // L'écran Équipe lit l'invitation au journal ; une fois entrée, plus d'invitation.
    const invitations = await latestStaffInvitations([LEA], { database: bases.app.db })
    assert.equal(invitations.get(LEA)?.status, 'sent')
    assert.equal(await sendStaffInvitation(LEA, options()), null)
  })

  it('n’envoie pas de lien à qui a déjà un mot de passe : le message l’invite à s’en servir', async () => {
    const compte = '00000000-0068-4000-8000-0000000000e1'
    await lire(
      `insert into auth_users (id, name, email, email_verified, created_at, updated_at)
       values (?, 'Léa', ?, true, current_timestamp(3), current_timestamp(3))`,
      [compte, lea],
    )
    await lire(
      `insert into auth_accounts (id, account_id, provider_id, user_id, password, created_at, updated_at)
       values (uuid(), ?, 'credential', ?, ?, current_timestamp(3), current_timestamp(3))`,
      [compte, compte, await hashPassword(motDePasse)],
    )
    assert.equal((await sendStaffInvitation(LEA, options()))?.status, 'sent')
    assert.equal(lienRecu(), undefined)
    assert.match(envoyes[0].text, /Vous avez déjà un mot de passe pour .* Connectez-vous avec lui/)
  })

  it('n’invite pas un membre retiré', async () => {
    assert.equal(await sendStaffInvitation(RETIRE, options()), null)
    assert.equal(envoyes.length, 0)
  })

  it('refuse toute inscription libre (ADR 068)', async () => {
    await assert.rejects(
      auth.api.signUpEmail({ body: { email: 'inconnu@equipe.exemple', password: motDePasse, name: 'Inconnu' } }),
      (error: { body?: { code?: string } }) => error.body?.code === 'EMAIL_PASSWORD_SIGN_UP_DISABLED',
    )
    assert.equal((await lire('select count(*) as n from auth_users where email = ?', ['inconnu@equipe.exemple']))[0].n, 0)
  })
})
