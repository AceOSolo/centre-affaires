import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { hashPassword } from 'better-auth/crypto'
import { sql } from 'drizzle-orm'

import { withTenant, type Transaction } from '../../db/index.ts'
import { ouvrirBasesDeTest, raisonDeSaut, viderTables, type TestDatabases } from '../../db/test-support.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { createAuth, type Auth } from '../../lib/auth/server.ts'
import type { Message, SendResult } from '../../lib/courriel.ts'
import { createProposalInTransaction } from '../facturation/propositions-queries.ts'
import { listOpenDomiciliationRequests } from '../facturation/propositions-portail.ts'
import type { LineDraft } from '../facturation/propositions.ts'
import { sendRequestReceived } from './demandes-site.ts'
import { resolveOrSignupClientAccounts } from './inscription.ts'

/**
 * Demande déposée sur le site par un visiteur (ADR 068), de bout en bout,
 * contre la configuration réelle de Better Auth et une vraie base : accusé de
 * réception avec le lien de l'espace, choix du mot de passe, première entrée
 * — fiche créée au nom de la raison sociale donnée, demandes retrouvées —, et
 * accusé seul pour une adresse déjà connue du centre.
 */
describe('demande du site : accusé de réception et espace du demandeur', { skip: raisonDeSaut }, () => {
  let bases: TestDatabases
  let auth: Auth

  const SALLE = '01a00000-0000-7000-8000-000000068a01'
  const RESA = '01a00000-0000-7000-8000-000000068b01'
  const RESA_ANNULEE = '01a00000-0000-7000-8000-000000068b02'
  const RESA_AUTRE = '01a00000-0000-7000-8000-000000068b03'
  const RESA_CLIENT = '01a00000-0000-7000-8000-000000068b04'
  const DURAND = '01a00000-0000-7000-8000-000000068c01'
  const camille = 'camille@rousseau.exemple'
  const motDePasse = 'mot-de-passe-de-camille'

  let envoyes: Message[] = []
  const send = async (message: Message): Promise<SendResult> => {
    envoyes.push(message)
    return { status: 'sent', recipients: message.to, failed: [], error: null }
  }
  const options = () => ({ auth, database: bases.app.db, send })
  const asTenant = <T>(run: (tx: Transaction) => Promise<T>) => withTenant(DEFAULT_TENANT_ID, run, bases.app.db)

  const lire = async (text: string, params: unknown[] = []) =>
    (await bases.owner.client.query(text, params))[0] as Record<string, unknown>[]

  const lienRecu = () => envoyes.at(-1)?.text.match(/http\S+\/reset-password\/\S+/)?.[0]

  const ligne: LineDraft = {
    source: 'manual',
    label: 'Domiciliation — forfait mensuel',
    description: null,
    unit: 'month',
    quantity: 12,
    unitPriceCents: 3_000,
    discountBp: null,
    discountAmountCents: null,
    vatRateBp: 2_000,
    resourceId: null,
    serviceId: null,
    ratePlanItemId: null,
  }

  /** Une demande de salle de la page publique, et son devis brouillon. */
  const demandeDeSalle = async (id: string, email: string, jour: number, options: { annulee?: boolean; clientId?: string } = {}) => {
    await asTenant(async (tx) => {
      await tx.execute(sql`
        insert into bookings (id, resource_id, client_id, channel, status, title, requester_name, requester_email,
                              requester_phone, starts_at, ends_at, cancelled_at)
        values (${id}, ${SALLE}, ${options.clientId ?? null}, 'public', ${options.annulee ? 'cancelled' : 'pending'},
                'Réunion', 'Camille Rousseau', ${email}, '0600000000',
                CURRENT_TIMESTAMP(3) + interval ${jour} day, CURRENT_TIMESTAMP(3) + interval ${jour} day + interval 2 hour,
                ${options.annulee ? sql`CURRENT_TIMESTAMP(3)` : null})`)
      await createProposalInTransaction(tx, {
        product: 'espace',
        channel: 'public',
        clientId: options.clientId ?? null,
        bookingId: id,
        requesterName: 'Camille Rousseau',
        requesterEmail: email,
        requesterCompany: 'Atelier Rousseau',
        answers: {},
        lines: [],
      })
    })
  }

  const domiciliation = (email: string, validee = false) =>
    asTenant((tx) =>
      createProposalInTransaction(tx, {
        product: 'domiciliation',
        channel: 'public',
        requesterName: 'Camille Rousseau',
        requesterEmail: email,
        requesterCompany: 'Atelier Rousseau',
        answers: { situation: 'creation', raisonSociale: 'Atelier Rousseau' },
        lines: validee ? [ligne] : [],
        validate: validee,
      }),
    )

  const viderComptes = () => lire("delete from auth_users where email like '%.exemple'")

  before(async () => {
    for (const nom of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD', 'MAIL_FROM']) delete process.env[nom]
    process.env.AUTH_SKIP_EMAIL_VERIFICATION = 'false'
    process.env.AUTH_SECRET ||= 'secret-de-test-des-demandes-du-site-0123456789'
    process.env.APP_URL ||= 'http://localhost:3000'
    bases = await ouvrirBasesDeTest()
    ;(globalThis as { database?: unknown }).database = bases.app
    auth = createAuth(bases.app.db)
  })

  beforeEach(async () => {
    envoyes = []
    await viderComptes()
    await viderTables(
      bases.owner,
      'notification_deliveries',
      'proposal_lines',
      'proposals',
      'bookings',
      'client_members',
      'clients',
      'staff_members',
      'auth_verifications',
      'resources',
    )
    await asTenant(async (tx) => {
      await tx.execute(sql`insert into resources (id, resource_type, code, name) values (${SALLE}, 'salle', 'SAL-68', 'Salle Horizon')`)
      await tx.execute(sql`insert into clients (id, name, status) values (${DURAND}, 'Atelier Durand', 'active')`)
    })
  })

  after(async () => {
    await viderComptes()
    await viderTables(bases.owner, 'notification_deliveries', 'proposal_lines', 'proposals', 'bookings', 'client_members', 'clients', 'resources')
    delete (globalThis as { database?: unknown }).database
    await bases.fermer()
  })

  it('envoie l’accusé de réception avec le lien de l’espace, et crée le compte sans mot de passe', async () => {
    await demandeDeSalle(RESA, camille, 3)
    const issue = await sendRequestReceived({ bookingId: RESA }, options())
    assert.equal(issue?.status, 'sent')
    assert.deepEqual(envoyes[0].to, [camille])
    assert.match(envoyes[0].subject, /est bien reçue/)
    assert.match(envoyes[0].text, /Nous avons bien reçu votre demande : Salle Horizon, /)
    assert.match(envoyes[0].text, /Référence : DV-\d{4}-\d{4}/)
    assert.match(envoyes[0].text, /créez votre espace : choisissez votre mot de passe en ouvrant ce lien, valable une fois, jusqu’au /)
    assert.ok(lienRecu(), 'le courriel porte le lien')
    assert.doesNotMatch(envoyes[0].text, /Vous avez déjà un compte/)

    // Un compte sans mot de passe ni adresse confirmée, à la raison sociale donnée.
    const [compte] = await lire('select id, name, company_name, email_verified from auth_users where email = ?', [camille])
    assert.equal(compte.name, 'Camille Rousseau')
    assert.equal(compte.company_name, 'Atelier Rousseau')
    assert.equal(Number(compte.email_verified), 0)
    assert.equal(Number((await lire('select count(*) as n from auth_accounts where user_id = ?', [compte.id]))[0].n), 0)

    // Au journal, à la personne seule : ni entreprise ni préférence.
    const [journal] = await lire('select audience, client_id, related_type, related_id from notification_deliveries')
    assert.deepEqual(journal, { audience: 'person', client_id: null, related_type: 'booking', related_id: RESA })
  })

  it('à la première entrée, crée la fiche et y rattache les demandes faites à cette adresse', async () => {
    await demandeDeSalle(RESA, camille, 3)
    await demandeDeSalle(RESA_ANNULEE, camille, 5, { annulee: true })
    await demandeDeSalle(RESA_AUTRE, 'autre@personne.exemple', 7)
    const enCours = await domiciliation(camille)
    const validee = await domiciliation(camille, true)
    const [{ status: statutValidee }] = await lire('select status from proposals where id = ?', [validee.id])
    assert.equal(statutValidee, 'ready')

    await sendRequestReceived({ proposalId: enCours.id }, options())
    assert.match(envoyes[0].text, /Nous avons bien reçu votre demande : domiciliation de Atelier Rousseau\./)

    // Le navigateur ouvre le lien, la personne choisit son mot de passe.
    const arrivee = await auth.handler(new Request(lienRecu() as string))
    const token = new URL(arrivee.headers.get('location') as string).searchParams.get('token') as string
    await auth.api.resetPassword({ body: { newPassword: motDePasse, token } })
    const session = await auth.api.signInEmail({ body: { email: camille, password: motDePasse } })

    const user = { id: session.user.id, email: camille, name: 'Camille Rousseau' }
    const comptes = await asTenant((tx) => resolveOrSignupClientAccounts(tx, user, { emailVerified: true }))
    assert.equal(comptes.length, 1)
    const fiche = comptes[0].clientId
    const [client] = await lire('select name, status, origin from clients where id = ?', [fiche])
    assert.deepEqual(client, { name: 'Atelier Rousseau', status: 'prospect', origin: 'inscription' })

    // Les réservations de cette adresse, annulée comprise ; pas celle d'un autre.
    const resas = await lire('select id, client_id from bookings order by id')
    assert.deepEqual(
      Object.fromEntries(resas.map((row) => [row.id, row.client_id])),
      { [RESA]: fiche, [RESA_ANNULEE]: fiche, [RESA_AUTRE]: null },
    )
    // Les devis brouillons suivent ; un devis validé ne change plus de destinataire (CA016).
    const devis = await lire('select id, status, client_id from proposals where requester_email = ?', [camille])
    for (const row of devis) {
      assert.equal(row.client_id, row.id === validee.id ? null : fiche, `devis ${row.status}`)
    }

    // L'espace montre la demande de domiciliation en cours.
    const demandes = await listOpenDomiciliationRequests(comptes)
    assert.deepEqual(
      demandes.map((demande) => [demande.id, demande.company]),
      [[enCours.id, 'Atelier Rousseau']],
    )

    // Une seconde entrée ne crée rien de plus.
    await asTenant((tx) => resolveOrSignupClientAccounts(tx, user, { emailVerified: true }))
    assert.equal(Number((await lire('select count(*) as n from clients where origin = ?', ['inscription']))[0].n), 1)
  })

  it('n’offre pas de lien à une adresse déjà connue du centre : l’accusé l’invite à se connecter', async () => {
    // Un accès à une entreprise, même jamais activé.
    await asTenant((tx) =>
      tx.execute(sql`insert into client_members (client_id, email, full_name) values (${DURAND}, ${camille}, 'Camille')`),
    )
    await demandeDeSalle(RESA, camille, 3)
    assert.equal((await sendRequestReceived({ bookingId: RESA }, options()))?.status, 'sent')
    assert.equal(lienRecu(), undefined)
    assert.match(envoyes[0].text, /Vous avez déjà un compte chez .* : l’équipe vous répond par courriel\..*\/auth\/connexion/)
    assert.equal((await lire('select count(*) as n from auth_users where email = ?', [camille]))[0].n, 0)
  })

  it('n’offre pas de lien à un compte qui a déjà un mot de passe', async () => {
    const compte = '00000000-0068-4000-8000-000000000001'
    await lire(
      `insert into auth_users (id, name, email, email_verified, created_at, updated_at)
       values (?, 'Camille', ?, true, current_timestamp(3), current_timestamp(3))`,
      [compte, camille],
    )
    await lire(
      `insert into auth_accounts (id, account_id, provider_id, user_id, password, created_at, updated_at)
       values (uuid(), ?, 'credential', ?, ?, current_timestamp(3), current_timestamp(3))`,
      [compte, compte, await hashPassword(motDePasse)],
    )
    await demandeDeSalle(RESA, camille, 3)
    await sendRequestReceived({ bookingId: RESA }, options())
    assert.equal(lienRecu(), undefined)
    assert.match(envoyes[0].text, /Vous avez déjà un compte/)
    assert.equal((await lire("select count(*) as n from auth_verifications where identifier like 'reset-password:%'"))[0].n, 0)
  })

  it('ne dit rien pour une demande faite depuis un espace client : la personne la voit déjà', async () => {
    await demandeDeSalle(RESA_CLIENT, camille, 3, { clientId: DURAND })
    assert.equal(await sendRequestReceived({ bookingId: RESA_CLIENT }, options()), null)
    assert.equal(envoyes.length, 0)
  })
})
