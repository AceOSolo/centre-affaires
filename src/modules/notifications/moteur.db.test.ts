import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import { createDatabase, withTenant, type Transaction } from '../../db/index.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import type { Message, SendResult } from '../../lib/courriel.ts'
import { notify, type NotificationRequest } from './moteur.ts'

/**
 * Moteur de notifications (R26, ADR 038), éprouvé contre la base sous le rôle
 * applicatif : modèle du centre ou texte par défaut, préférences des
 * personnes, journal écrit quelle que soit l'issue — envoyé, échec, SMTP non
 * configuré, non envoyé — et jamais le corps du message.
 */
const ownerUrl = process.env.TEST_OWNER_DATABASE_URL ?? process.env.DATABASE_URL
const appUrl = process.env.TEST_DATABASE_URL

const raison = !appUrl
  ? 'TEST_DATABASE_URL non défini'
  : !ownerUrl
    ? 'TEST_OWNER_DATABASE_URL non défini'
    : false

describe('moteur de notifications', { skip: raison }, () => {
  const owner = createDatabase(ownerUrl ?? '', { onnotice: () => {} })
  const app = createDatabase(appUrl ?? '')

  const DURAND = '01a00000-0000-7000-8000-0000000f1c01'
  const PETIT = '01a00000-0000-7000-8000-0000000f1c02'
  const JEANNE = '01a00000-0000-7000-8000-0000000f1d01'
  const JULES = '01a00000-0000-7000-8000-0000000f1d02'
  const ANCIEN = '01a00000-0000-7000-8000-0000000f1d03'
  const PAUL = '01a00000-0000-7000-8000-0000000f1d04'
  const PLI = '01a00000-0000-7000-8000-0000000f1f01'

  const asTenant = <T>(run: (tx: Transaction) => Promise<T>) => withTenant(DEFAULT_TENANT_ID, run, app.db)

  /** Transport des tests : garde chaque message, rend l'issue demandée. */
  let envoyes: Message[] = []
  let refusees: string[] = []
  const send = async (message: Message): Promise<SendResult> => {
    envoyes.push(message)
    const recipients = [...new Set(message.to.map((to) => to.trim().toLowerCase()))]
    const failed = recipients.filter((address) => refusees.includes(address))
    return failed.length > 0
      ? { status: 'failed', recipients, failed, error: `${failed.length} envoi sur ${recipients.length} en échec : 550 boîte inexistante` }
      : { status: 'sent', recipients, failed: [], error: null }
  }
  const options = { database: app.db, send }

  /** Arrivée d'un pli chez Durand, avec un jeton qui ne doit vivre que dans le corps. */
  const arrivee = (values: NotificationRequest['values'] = {}): NotificationRequest => ({
    event: 'mail_received',
    clientId: DURAND,
    related: { type: 'mail_item', id: PLI },
    values: {
      client: 'Atelier Durand',
      nature: 'recommandé',
      date: 'JETON-DU-CORPS-7f3a',
      lien: 'https://centre.exemple/compte/courrier',
      ...values,
    },
  })

  const journal = () =>
    owner.client`
      select event, audience, client_id, recipients, failed_recipients, subject, status, error,
             related_type, related_id
        from notification_deliveries order by sent_at, id`

  let centre: { name: string; email: string | null }

  before(async () => {
    await migrate(owner.db, { migrationsFolder: './src/db/migrations' })
    const [row] = await owner.client`select name, email from tenants where id = ${DEFAULT_TENANT_ID}`
    centre = { name: row.name as string, email: row.email as string | null }
  })

  beforeEach(async () => {
    envoyes = []
    refusees = []
    await owner.client`truncate table clients, staff_members cascade`
    await owner.client`truncate table notification_deliveries, notification_templates, notification_preferences`
    await owner.client`update tenants set email = 'accueil@centre.exemple' where id = ${DEFAULT_TENANT_ID}`
    await asTenant(async (tx) => {
      await tx.execute(sql`
        insert into clients (id, name, status) values
          (${DURAND}, 'Atelier Durand', 'active'), (${PETIT}, 'Boulangerie Petit', 'active')`)
      await tx.execute(sql`
        insert into client_members (id, client_id, email, full_name, deleted_at) values
          (${JEANNE}, ${DURAND}, 'jeanne@durand.fr', 'Jeanne Durand', null),
          (${JULES}, ${DURAND}, 'jules@durand.fr', null, null),
          (${ANCIEN}, ${DURAND}, 'ancien@durand.fr', null, now()),
          (${PAUL}, ${PETIT}, 'paul@petit.fr', null, null)`)
    })
  })

  after(async () => {
    await owner.client`truncate table notification_deliveries, notification_templates, notification_preferences`
    await owner.client`update tenants set email = ${centre.email} where id = ${DEFAULT_TENANT_ID}`
    await Promise.all([owner.client.end(), app.client.end()])
  })

  const renoncer = (memberId: string, clientId: string, category: string) =>
    asTenant((tx) =>
      tx.execute(sql`
        insert into notification_preferences (client_id, client_member_id, category, enabled)
        values (${clientId}, ${memberId}, ${category}, false)`),
    )

  describe('rendu et journal', () => {
    it('envoie le texte par défaut aux personnes de l’entreprise, et journalise l’objet sans le corps', async () => {
      const issue = await notify(arrivee(), options)

      assert.equal(issue.status, 'sent')
      assert.equal(issue.logged, true)
      assert.equal(envoyes.length, 1)
      assert.deepEqual([...envoyes[0].to].sort(), ['jeanne@durand.fr', 'jules@durand.fr'])
      assert.equal(envoyes[0].subject, 'Nouveau courrier pour Atelier Durand')
      assert.match(envoyes[0].text, /JETON-DU-CORPS-7f3a/)
      assert.ok(envoyes[0].text.endsWith(`—\n${centre.name}`))

      const [ligne] = await journal()
      assert.equal(ligne.event, 'mail_received')
      assert.equal(ligne.audience, 'client')
      assert.equal(ligne.client_id, DURAND)
      assert.equal(ligne.status, 'sent')
      assert.equal(ligne.subject, 'Nouveau courrier pour Atelier Durand')
      assert.deepEqual([...(ligne.recipients as string[])].sort(), ['jeanne@durand.fr', 'jules@durand.fr'])
      assert.equal(ligne.related_type, 'mail_item')
      assert.equal(ligne.related_id, PLI)

      // Aucune donnée du corps dans le journal, quelle que soit la colonne.
      const [texte] = await owner.client`
        select string_agg(row_to_json(d)::text, ' ') as tout from notification_deliveries d`
      assert.doesNotMatch(texte.tout as string, /JETON-DU-CORPS/)
      assert.doesNotMatch(texte.tout as string, /centre\.exemple\/compte/)
    })

    it('applique le modèle du centre, ligne à variable manquante retirée', async () => {
      await asTenant((tx) =>
        tx.execute(sql`
          insert into notification_templates (event, subject, body)
          values ('mail_received', 'Pli pour {{client}}', ${'Bonjour {{client}},\n\nVoir : {{lien}}\n\nÀ bientôt.'})`),
      )
      await notify(arrivee({ lien: undefined }), options)
      assert.equal(envoyes[0].subject, 'Pli pour Atelier Durand')
      assert.equal(envoyes[0].text, 'Bonjour Atelier Durand,\n\nÀ bientôt.')
      const [ligne] = await journal()
      assert.equal(ligne.subject, 'Pli pour Atelier Durand')
    })

    it('n’envoie rien quand le modèle est désactivé, et le journalise « non envoyé »', async () => {
      await asTenant((tx) =>
        tx.execute(sql`
          insert into notification_templates (event, subject, body, active)
          values ('mail_received', 'Pli pour {{client}}', 'Texte', false)`),
      )
      const issue = await notify(arrivee(), options)
      assert.equal(issue.status, 'skipped')
      assert.equal(envoyes.length, 0)
      const [ligne] = await journal()
      assert.equal(ligne.status, 'skipped')
      assert.deepEqual(ligne.recipients, [])
      assert.match(ligne.error as string, /Modèle désactivé/)
    })
  })

  describe('préférences', () => {
    it('écarte la personne qui a renoncé à la catégorie, et elle seule', async () => {
      await renoncer(JEANNE, DURAND, 'mail')
      await notify(arrivee(), options)
      assert.deepEqual(envoyes[0].to, ['jules@durand.fr'])
      const [ligne] = await journal()
      assert.deepEqual(ligne.recipients, ['jules@durand.fr'])
    })

    it('n’envoie rien quand toutes ont renoncé, et dit à quoi', async () => {
      await renoncer(JEANNE, DURAND, 'mail')
      await renoncer(JULES, DURAND, 'mail')
      const issue = await notify(arrivee(), options)
      assert.equal(issue.status, 'skipped')
      assert.equal(envoyes.length, 0)
      const [ligne] = await journal()
      assert.equal(ligne.status, 'skipped')
      assert.match(ligne.error as string, /renoncé aux messages « Courrier »/)
    })

    it('ne vaut que pour sa catégorie', async () => {
      await renoncer(JEANNE, DURAND, 'invoices')
      await notify(arrivee(), options)
      assert.equal(envoyes[0].to.length, 2)
    })

    it('ne s’applique pas à un message sans catégorie : l’ouverture d’un accès part toujours', async () => {
      for (const category of ['mail', 'bookings', 'invoices', 'contracts', 'inspections']) {
        await renoncer(JEANNE, DURAND, category)
      }
      const issue = await notify(
        {
          event: 'member_invited',
          clientId: DURAND,
          related: { type: 'client_member', id: JEANNE },
          recipients: { memberIds: [JEANNE] },
          values: { client: 'Atelier Durand', adresse: 'jeanne@durand.fr' },
        },
        options,
      )
      assert.equal(issue.status, 'sent')
      assert.deepEqual(envoyes[0].to, ['jeanne@durand.fr'])
    })

    it('sert toujours une adresse donnée sans accès : un contact « factures »', async () => {
      await renoncer(JEANNE, DURAND, 'invoices')
      const issue = await notify(
        {
          event: 'invoice_reminder',
          clientId: DURAND,
          related: { type: 'invoice', id: PLI },
          recipients: { addresses: [{ email: 'Jeanne@Durand.fr' }, { email: 'compta@durand.fr' }] },
          values: { client: 'Atelier Durand', objet: 'Relance — facture FA-1', lettre: 'Madame, Monsieur,' },
        },
        options,
      )
      assert.equal(issue.status, 'sent')
      assert.deepEqual(envoyes[0].to, ['jeanne@durand.fr', 'compta@durand.fr'])
      assert.equal(envoyes[0].subject, 'Relance — facture FA-1')
      assert.equal(envoyes[0].text, 'Madame, Monsieur,')
    })
  })

  describe('destinataires', () => {
    it('écarte les accès retirés ou anonymisés, et ceux d’une autre entreprise', async () => {
      await notify(arrivee(), options)
      assert.ok(!envoyes[0].to.includes('ancien@durand.fr'))
      assert.ok(!envoyes[0].to.includes('paul@petit.fr'))
    })

    it('ne prévient plus personne d’une fiche archivée', async () => {
      await asTenant((tx) => tx.execute(sql`update clients set deleted_at = now() where id = ${DURAND}`))
      const issue = await notify(arrivee(), options)
      assert.equal(issue.status, 'skipped')
      const [ligne] = await journal()
      assert.match(ligne.error as string, /Aucune personne n’a accès/)
    })

    it('ne garde, parmi les accès désignés, que ceux de l’entreprise du message', async () => {
      await notify({ ...arrivee(), recipients: { memberIds: [JULES, PAUL] } }, options)
      assert.deepEqual(envoyes[0].to, ['jules@durand.fr'])
    })

    it('envoie un message au centre à son adresse ; sans adresse, rien ne part', async () => {
      const demande: NotificationRequest = {
        event: 'mail_request_submitted',
        clientId: DURAND,
        values: { client: 'Atelier Durand', demande: 'numérisation', demandeur: 'Jeanne Durand' },
      }
      await notify(demande, options)
      assert.deepEqual(envoyes[0].to, ['accueil@centre.exemple'])

      await owner.client`update tenants set email = null where id = ${DEFAULT_TENANT_ID}`
      const issue = await notify(demande, options)
      assert.equal(issue.status, 'skipped')
      const lignes = await journal()
      assert.deepEqual(
        lignes.map((ligne) => [ligne.audience, ligne.status]),
        [
          ['centre', 'sent'],
          ['centre', 'skipped'],
        ],
      )
      assert.match(lignes[1].error as string, /adresse de courriel/)
    })
  })

  describe('échecs', () => {
    it('journalise un échec SMTP avec les adresses refusées', async () => {
      refusees = ['jules@durand.fr']
      const issue = await notify(arrivee(), options)
      assert.equal(issue.status, 'failed')
      const [ligne] = await journal()
      assert.equal(ligne.status, 'failed')
      assert.deepEqual(ligne.failed_recipients, ['jules@durand.fr'])
      assert.match(ligne.error as string, /550/)
    })

    it('journalise « SMTP non configuré » sans rien envoyer', async () => {
      const variables = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD', 'MAIL_FROM'] as const
      const saved = Object.fromEntries(variables.map((name) => [name, process.env[name]]))
      for (const name of variables) delete process.env[name]
      try {
        // Le vrai transport, sans configuration : celui du développement.
        const issue = await notify(arrivee(), { database: app.db })
        assert.equal(issue.status, 'not_configured')
      } finally {
        for (const name of variables) if (saved[name] !== undefined) process.env[name] = saved[name]
      }
      const [ligne] = await journal()
      assert.equal(ligne.status, 'not_configured')
      assert.deepEqual([...(ligne.recipients as string[])].sort(), ['jeanne@durand.fr', 'jules@durand.fr'])
      assert.deepEqual(ligne.failed_recipients, [])
    })

    it('ne lève jamais : un transport qui lève vaut échec, journalisé', async () => {
      const issue = await notify(arrivee(), {
        database: app.db,
        send: async () => {
          throw new Error('Connexion SMTP refusée')
        },
      })
      assert.equal(issue.status, 'failed')
      assert.equal(issue.logged, true)
      const [ligne] = await journal()
      assert.equal(ligne.status, 'failed')
      assert.equal((ligne.failed_recipients as string[]).length, 2)
    })

    it('ne lève jamais : une base injoignable rend un échec non journalisé', async () => {
      const coupee = createDatabase(appUrl ?? '')
      await coupee.client.end()
      const issue = await notify(arrivee(), { database: coupee.db, send })
      assert.equal(issue.status, 'failed')
      assert.equal(issue.logged, false)
      assert.equal(envoyes.length, 0)
    })
  })
})
