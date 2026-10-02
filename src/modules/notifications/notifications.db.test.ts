import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql, type SQL } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import {
  PG_CHECK_VIOLATION,
  PG_FOREIGN_KEY_VIOLATION,
  PG_INSUFFICIENT_PRIVILEGE,
  PG_UNIQUE_VIOLATION,
  pgErrorCode,
} from '../../db/errors.ts'
import { createDatabase, withClientScope, withTenant, type Transaction } from '../../db/index.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import {
  notificationEventAudience,
  notificationEventCategory,
  notificationEvents,
} from './schema.ts'

/**
 * Moteur de notifications (R26, ADR 038), éprouvé contre la base sous le rôle
 * applicatif : modèles par centre et par événement, journal des envois sans
 * corps de message, en ajout seul et purgé au terme de sa durée,
 * préférences des personnes de l'espace client sous portée client.
 */
const ownerUrl = process.env.TEST_OWNER_DATABASE_URL ?? process.env.DATABASE_URL
const appUrl = process.env.TEST_DATABASE_URL

const raison = !appUrl
  ? 'TEST_DATABASE_URL non défini'
  : !ownerUrl
    ? 'TEST_OWNER_DATABASE_URL non défini'
    : false

/** Ligne refusée par une politique RLS. */
const PG_RLS_VIOLATION = '42501'

describe('notifications', { skip: raison }, () => {
  const owner = createDatabase(ownerUrl ?? '', { onnotice: () => {} })
  const app = createDatabase(appUrl ?? '')

  const DURAND = '01a00000-0000-7000-8000-0000000f0c01'
  const PETIT = '01a00000-0000-7000-8000-0000000f0c02'
  const JEANNE = '01a00000-0000-7000-8000-0000000f0d01'
  const PAUL = '01a00000-0000-7000-8000-0000000f0d02'
  const AUTRE_CENTRE = '01999f00-0000-7000-8000-0000000000f7'

  const asTenant = <T>(run: (tx: Transaction) => Promise<T>, tenant = DEFAULT_TENANT_ID) =>
    withTenant(tenant, run, app.db)
  const asClients = <T>(clientIds: string[], run: (tx: Transaction) => Promise<T>) =>
    withClientScope(DEFAULT_TENANT_ID, clientIds, run, app.db)

  const codeErreur = async (run: () => Promise<unknown>) => {
    try {
      await run()
    } catch (error) {
      return pgErrorCode(error)
    }
    return undefined
  }

  /** Un envoi au journal. */
  const journaliser = (
    tx: Transaction,
    {
      event = 'mail_received',
      audience = 'client',
      clientId = DURAND as string | null,
      recipients = sql`'{jeanne@durand.fr}'::text[]` as SQL,
      failed = sql`'{}'::text[]` as SQL,
      status = 'sent',
      error = null as string | null,
      sentAt = sql`now()` as SQL,
    } = {},
  ) =>
    tx.execute(sql`
      insert into notification_deliveries (event, audience, client_id, recipients, failed_recipients,
                                           subject, status, error, related_type, related_id, sent_at)
      values (${event}, ${audience}, ${clientId}, ${recipients}, ${failed},
              'Nouveau courrier pour Atelier Durand', ${status}, ${error}, 'mail_item',
              '01a00000-0000-7000-8000-0000000f0f01', ${sentAt})
      returning id`)

  before(async () => {
    await migrate(owner.db, { migrationsFolder: './src/db/migrations' })
  })

  beforeEach(async () => {
    await owner.client`truncate table clients, staff_members cascade`
    await owner.client`truncate table notification_deliveries, notification_templates, notification_preferences`
    await owner.client`delete from tenants where id <> ${DEFAULT_TENANT_ID}`
    await owner.client`update tenants set notification_log_retention_months = 12 where id = ${DEFAULT_TENANT_ID}`
    await asTenant(async (tx) => {
      await tx.execute(sql`
        insert into clients (id, name, status) values
          (${DURAND}, 'Atelier Durand', 'active'), (${PETIT}, 'Boulangerie Petit', 'active')`)
      await tx.execute(sql`
        insert into client_members (id, client_id, email, auth_user_id) values
          (${JEANNE}, ${DURAND}, 'jeanne@durand.fr', 'u-jeanne'),
          (${PAUL}, ${PETIT}, 'paul@petit.fr', 'u-paul')`)
    })
  })

  after(async () => {
    await owner.client`truncate table notification_deliveries, notification_templates, notification_preferences`
    await Promise.all([owner.client.end(), app.client.end()])
  })

  describe('événements', () => {
    it('connaît les mêmes événements que le code, ni plus ni moins', async () => {
      const [row] = await asTenant((tx) =>
        tx.execute(sql`select enum_range(null::notification_event)::text[] as events`),
      )
      assert.deepEqual(row.events, [...notificationEvents])
    })

    it('fixe le destinataire et la catégorie de chaque événement, comme le code', async () => {
      for (const event of notificationEvents) {
        const [row] = await asTenant((tx) =>
          tx.execute(sql`
            select notification_event_audience(${event}) as audience,
                   notification_event_category(${event}) as category`),
        )
        assert.equal(row.audience, notificationEventAudience[event], event)
        assert.equal(row.category, notificationEventCategory[event], event)
      }
    })

    it('refuse un événement inconnu plutôt que de le laisser passer', async () => {
      assert.ok(
        await codeErreur(() =>
          asTenant((tx) => tx.execute(sql`select notification_event_audience('inconnu')`)),
        ),
      )
    })
  })

  describe('journal des envois', () => {
    it('ne garde pas le corps des messages : il n’a pas de colonne pour lui', async () => {
      const colonnes = await asTenant((tx) =>
        tx.execute(sql`
          select column_name from information_schema.columns
           where table_schema = 'public' and table_name = 'notification_deliveries'
           order by ordinal_position`),
      )
      assert.deepEqual(
        colonnes.map((row) => row.column_name),
        [
          'id',
          'tenant_id',
          'event',
          'audience',
          'client_id',
          'recipients',
          'failed_recipients',
          'subject',
          'status',
          'error',
          'related_type',
          'related_id',
          'sent_at',
        ],
      )
    })

    it('refuse un message au mauvais destinataire, ou à un client sans client', async () => {
      assert.equal(
        await codeErreur(() => asTenant((tx) => journaliser(tx, { audience: 'centre' }))),
        PG_CHECK_VIOLATION,
      )
      assert.equal(
        await codeErreur(() => asTenant((tx) => journaliser(tx, { clientId: null }))),
        PG_CHECK_VIOLATION,
      )
      // Le centre, prévenu d'une demande : sans client possible.
      await asTenant((tx) =>
        journaliser(tx, {
          event: 'mail_request_submitted',
          audience: 'centre',
          clientId: null,
          recipients: sql`'{accueil@centre.fr}'::text[]`,
        }),
      )
    })

    it('tient un statut cohérent avec ses destinataires', async () => {
      // Un échec dit pourquoi, et qui.
      assert.equal(
        await codeErreur(() =>
          asTenant((tx) => journaliser(tx, { status: 'failed', failed: sql`'{jeanne@durand.fr}'::text[]` })),
        ),
        PG_CHECK_VIOLATION,
      )
      assert.equal(
        await codeErreur(() =>
          asTenant((tx) =>
            journaliser(tx, { status: 'failed', error: 'Boîte pleine', failed: sql`'{autre@ailleurs.fr}'::text[]` }),
          ),
        ),
        PG_CHECK_VIOLATION,
      )
      // Envoyé à personne : non. Sauté faute de destinataire : oui, avec sa raison.
      assert.equal(
        await codeErreur(() => asTenant((tx) => journaliser(tx, { recipients: sql`'{}'::text[]` }))),
        PG_CHECK_VIOLATION,
      )
      await asTenant((tx) =>
        journaliser(tx, {
          status: 'skipped',
          error: 'Toutes les personnes ont renoncé aux messages du courrier.',
          recipients: sql`'{}'::text[]`,
        }),
      )
      await asTenant((tx) =>
        journaliser(tx, {
          status: 'failed',
          error: '550 Boîte inexistante',
          recipients: sql`'{jeanne@durand.fr,ancien@durand.fr}'::text[]`,
          failed: sql`'{ancien@durand.fr}'::text[]`,
        }),
      )
      await asTenant((tx) => journaliser(tx, { status: 'not_configured' }))
    })

    it('ne se corrige ni ne s’efface depuis l’application', async () => {
      const [row] = await asTenant((tx) => journaliser(tx))
      assert.equal(
        await codeErreur(() =>
          asTenant((tx) =>
            tx.execute(sql`update notification_deliveries set subject = 'Autre' where id = ${row.id as string}`),
          ),
        ),
        PG_INSUFFICIENT_PRIVILEGE,
      )
      assert.equal(
        await codeErreur(() =>
          asTenant((tx) => tx.execute(sql`delete from notification_deliveries where id = ${row.id as string}`)),
        ),
        PG_INSUFFICIENT_PRIVILEGE,
      )
    })

    it('se purge au terme de la durée du centre, et pas au-delà', async () => {
      await owner.client`
        insert into tenants (id, name, slug) values (${AUTRE_CENTRE}, 'Autre centre', 'autre-centre-notifications')`
      await asTenant(async (tx) => {
        await journaliser(tx, { sentAt: sql`now() - interval '13 months'` })
        await journaliser(tx, { sentAt: sql`now() - interval '11 months'` })
      })
      await owner.client`
        insert into notification_deliveries (tenant_id, event, audience, recipients, subject, status, sent_at)
        values (${AUTRE_CENTRE}, 'mail_request_submitted', 'centre', '{accueil@autre.fr}', 'Demande', 'sent',
                now() - interval '5 years')`

      const [purge] = await asTenant((tx) =>
        tx.execute(sql`select purge_expired_notification_deliveries() as purged`),
      )
      assert.equal(purge.purged, 1)
      const [reste] = await asTenant((tx) =>
        tx.execute(sql`select count(*)::int as n from notification_deliveries`),
      )
      assert.equal(reste.n, 1)
      const [ailleurs] = await owner.client`
        select count(*)::int as n from notification_deliveries where tenant_id = ${AUTRE_CENTRE}`
      assert.equal(ailleurs.n, 1)

      // La durée du centre fait foi, y compris raccourcie.
      await owner.client`update tenants set notification_log_retention_months = 6 where id = ${DEFAULT_TENANT_ID}`
      const [encore] = await asTenant((tx) =>
        tx.execute(sql`select purge_expired_notification_deliveries() as purged`),
      )
      assert.equal(encore.purged, 1)
      await owner.client`delete from notification_deliveries where tenant_id = ${AUTRE_CENTRE}`
    })

    it('sous portée client, une entreprise ne lit que les messages qui lui ont été adressés', async () => {
      await asTenant(async (tx) => {
        await journaliser(tx)
        // Au centre, à propos de Durand : reste au back-office.
        await journaliser(tx, {
          event: 'mail_request_submitted',
          audience: 'centre',
          recipients: sql`'{accueil@centre.fr}'::text[]`,
        })
        await journaliser(tx, { clientId: PETIT, recipients: sql`'{paul@petit.fr}'::text[]` })
      })
      const vus = await asClients([DURAND], (tx) =>
        tx.execute(sql`select client_id, audience from notification_deliveries`),
      )
      assert.deepEqual(
        vus.map((row) => [row.client_id, row.audience]),
        [[DURAND, 'client']],
      )
    })
  })

  describe('modèles de messages', () => {
    const modele = (tx: Transaction, event = 'mail_received', subject = 'Courrier pour {{client}}') =>
      tx.execute(sql`
        insert into notification_templates (event, subject, body)
        values (${event}, ${subject}, 'Bonjour, un courrier est arrivé : {{lien}}')`)

    it('un modèle par événement et par centre', async () => {
      await asTenant((tx) => modele(tx))
      assert.equal(await codeErreur(() => asTenant((tx) => modele(tx))), PG_UNIQUE_VIOLATION)
      await asTenant((tx) => modele(tx, 'mail_scanned'))
    })

    it('refuse un objet vide', async () => {
      assert.equal(
        await codeErreur(() => asTenant((tx) => modele(tx, 'mail_received', '  '))),
        PG_CHECK_VIOLATION,
      )
    })

    it('reste au back-office : invisible et non modifiable depuis un espace client', async () => {
      await asTenant((tx) => modele(tx))
      const vus = await asClients([DURAND], (tx) => tx.execute(sql`select id from notification_templates`))
      assert.equal(vus.length, 0)
      assert.equal(await codeErreur(() => asClients([DURAND], (tx) => modele(tx, 'mail_scanned'))), PG_RLS_VIOLATION)
    })

    it('ne se supprime pas : revenir au texte par défaut, c’est le réécrire', async () => {
      await asTenant((tx) => modele(tx))
      assert.equal(
        await codeErreur(() => asTenant((tx) => tx.execute(sql`delete from notification_templates`))),
        PG_INSUFFICIENT_PRIVILEGE,
      )
    })
  })

  describe('préférences des personnes de l’espace client', () => {
    const preference = (tx: Transaction, clientId: string, memberId: string, enabled = false) =>
      tx.execute(sql`
        insert into notification_preferences (client_id, client_member_id, category, enabled)
        values (${clientId}, ${memberId}, 'mail', ${enabled})
        on conflict (tenant_id, client_member_id, category) do update set enabled = excluded.enabled`)

    it('une préférence par personne et par catégorie, que la personne règle elle-même', async () => {
      await asClients([DURAND], (tx) => preference(tx, DURAND, JEANNE, false))
      await asClients([DURAND], (tx) => preference(tx, DURAND, JEANNE, true))
      const [row] = await asTenant((tx) =>
        tx.execute(sql`select count(*)::int as n, bool_and(enabled) as enabled from notification_preferences`),
      )
      assert.equal(row.n, 1)
      assert.equal(row.enabled, true)
      assert.equal(
        await codeErreur(() =>
          asTenant((tx) =>
            tx.execute(sql`
              insert into notification_preferences (client_id, client_member_id, category, enabled)
              values (${DURAND}, ${JEANNE}, 'mail', false)`),
          ),
        ),
        PG_UNIQUE_VIOLATION,
      )
    })

    it('n’accepte que la personne de l’entreprise de la ligne', async () => {
      assert.equal(
        await codeErreur(() => asTenant((tx) => preference(tx, DURAND, PAUL))),
        PG_FOREIGN_KEY_VIOLATION,
      )
    })

    it('sous portée client, ne voit ni n’écrit les préférences d’une autre entreprise', async () => {
      await asTenant(async (tx) => {
        await preference(tx, DURAND, JEANNE)
        await preference(tx, PETIT, PAUL)
      })
      const vues = await asClients([DURAND], (tx) =>
        tx.execute(sql`select client_id from notification_preferences`),
      )
      assert.deepEqual(
        vues.map((row) => row.client_id),
        [DURAND],
      )
      assert.equal(
        await codeErreur(() => asClients([DURAND], (tx) => preference(tx, PETIT, PAUL, true))),
        PG_RLS_VIOLATION,
      )
    })
  })
})
