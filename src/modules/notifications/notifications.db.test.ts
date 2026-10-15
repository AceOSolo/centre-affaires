import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql, type SQL } from 'drizzle-orm'

import {
  DB_CHECK_VIOLATION,
  DB_FOREIGN_KEY_VIOLATION,
  DB_INSUFFICIENT_PRIVILEGE,
  DB_UNIQUE_VIOLATION,
  dbErrorCode,
} from '../../db/errors.ts'
import { withClientScope, withTenant, type Transaction } from '../../db/index.ts'
import { ouvrirBasesDeTest, raisonDeSaut, viderTables, type TestDatabases } from '../../db/test-support.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { uuidv7 } from '../../lib/uuid.ts'
import {
  notificationEventAudience,
  notificationEventCategory,
  notificationEvents,
} from './schema.ts'

/**
 * Moteur de notifications (R26, ADR 038), éprouvé contre la base : modèles par
 * centre et par événement, journal des envois sans corps de message, en ajout
 * seul et purgé au terme de sa durée, préférences des personnes de l'espace
 * client sous portée client.
 *
 * MySQL n'a pas de RLS : « ne voit que les siens » n'est plus une propriété de
 * la base mais de la requête (voir `queries.db.test.ts`) ; ici la base garde
 * les écritures.
 */
describe('notifications', { skip: raisonDeSaut }, () => {
  let bases: TestDatabases

  const DURAND = '01a00000-0000-7000-8000-0000000f0c01'
  const PETIT = '01a00000-0000-7000-8000-0000000f0c02'
  const JEANNE = '01a00000-0000-7000-8000-0000000f0d01'
  const PAUL = '01a00000-0000-7000-8000-0000000f0d02'
  const AUTRE_CENTRE = '01999f00-0000-7000-8000-0000000000f7'

  const asTenant = <T>(run: (tx: Transaction) => Promise<T>, tenant = DEFAULT_TENANT_ID) =>
    withTenant(tenant, run, bases.app.db)
  const asClients = <T>(clientIds: string[], run: (tx: Transaction) => Promise<T>) =>
    withClientScope(DEFAULT_TENANT_ID, clientIds, run, bases.app.db)

  const lire = async (text: string, params: unknown[] = []) =>
    (await bases.owner.client.query(text, params))[0] as Record<string, unknown>[]
  const rowsOf = async (tx: Transaction, query: SQL) =>
    (await tx.execute(query))[0] as unknown as Record<string, unknown>[]

  const codeErreur = async (run: () => Promise<unknown>) => {
    try {
      await run()
    } catch (error) {
      return dbErrorCode(error)
    }
    return undefined
  }

  /** Un envoi au journal. Les listes d'adresses sont des tableaux JSON. */
  const journaliser = (
    tx: Transaction,
    {
      event = 'mail_received',
      audience = 'client',
      clientId = DURAND as string | null,
      recipients = ['jeanne@durand.fr'],
      failed = [] as string[],
      status = 'sent',
      error = null as string | null,
      sentAt = sql`CURRENT_TIMESTAMP(3)` as SQL,
    } = {},
  ) => {
    const id = uuidv7()
    return tx
      .execute(sql`
        insert into notification_deliveries (id, event, audience, client_id, recipients, failed_recipients,
                                             subject, status, error, related_type, related_id, sent_at)
        values (${id}, ${event}, ${audience}, ${clientId}, ${JSON.stringify(recipients)}, ${JSON.stringify(failed)},
                'Nouveau courrier pour Atelier Durand', ${status}, ${error}, 'mail_item',
                '01a00000-0000-7000-8000-0000000f0f01', ${sentAt})`)
      .then(() => id)
  }

  before(async () => {
    bases = await ouvrirBasesDeTest()
  })

  beforeEach(async () => {
    await viderTables(
      bases.owner,
      'notification_deliveries',
      'notification_templates',
      'notification_preferences',
      'client_members',
      'clients',
      'staff_members',
    )
    await lire('delete from tenants where id <> ?', [DEFAULT_TENANT_ID])
    await lire('update tenants set notification_log_retention_months = 12 where id = ?', [DEFAULT_TENANT_ID])
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
    await viderTables(bases.owner, 'notification_deliveries', 'notification_templates', 'notification_preferences')
    await bases.fermer()
  })

  describe('événements', () => {
    it('connaît les mêmes événements que le code, ni plus ni moins', async () => {
      const [row] = await lire(
        `select column_type as column_type from information_schema.columns
          where table_schema = database() and table_name = 'notification_deliveries' and column_name = 'event'`,
      )
      const valeurs = [...String(row.column_type).matchAll(/'([^']+)'/g)].map((match) => match[1])
      assert.deepEqual(valeurs, [...notificationEvents])
    })

    it('fixe le destinataire et la catégorie de chaque événement, comme le code', async () => {
      for (const event of notificationEvents) {
        const [row] = await asTenant((tx) =>
          rowsOf(
            tx,
            sql`select notification_event_audience(${event}) as audience,
                       notification_event_category(${event}) as category`,
          ),
        )
        assert.equal(row.audience, notificationEventAudience[event], event)
        assert.equal(row.category, notificationEventCategory[event], event)
      }
    })

    it('refuse un événement inconnu plutôt que de le laisser passer', async () => {
      await assert.rejects(
        asTenant((tx) => tx.execute(sql`select notification_event_audience('inconnu')`)),
      )
    })
  })

  describe('journal des envois', () => {
    it('ne garde pas le corps des messages : il n’a pas de colonne pour lui', async () => {
      const colonnes = await lire(
        `select column_name as column_name from information_schema.columns
          where table_schema = database() and table_name = 'notification_deliveries'
          order by ordinal_position`,
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
        DB_CHECK_VIOLATION,
      )
      assert.equal(
        await codeErreur(() => asTenant((tx) => journaliser(tx, { clientId: null }))),
        DB_CHECK_VIOLATION,
      )
      // Le centre, prévenu d'une demande : sans client possible.
      await asTenant((tx) =>
        journaliser(tx, {
          event: 'mail_request_submitted',
          audience: 'centre',
          clientId: null,
          recipients: ['accueil@centre.fr'],
        }),
      )
    })

    it('tient un statut cohérent avec ses destinataires', async () => {
      // Un échec dit pourquoi, et qui.
      assert.equal(
        await codeErreur(() =>
          asTenant((tx) => journaliser(tx, { status: 'failed', failed: ['jeanne@durand.fr'] })),
        ),
        DB_CHECK_VIOLATION,
      )
      assert.equal(
        await codeErreur(() =>
          asTenant((tx) =>
            journaliser(tx, { status: 'failed', error: 'Boîte pleine', failed: ['autre@ailleurs.fr'] }),
          ),
        ),
        DB_CHECK_VIOLATION,
      )
      // Envoyé à personne : non. Sauté faute de destinataire : oui, avec sa raison.
      assert.equal(
        await codeErreur(() => asTenant((tx) => journaliser(tx, { recipients: [] }))),
        DB_CHECK_VIOLATION,
      )
      await asTenant((tx) =>
        journaliser(tx, {
          status: 'skipped',
          error: 'Toutes les personnes ont renoncé aux messages du courrier.',
          recipients: [],
        }),
      )
      await asTenant((tx) =>
        journaliser(tx, {
          status: 'failed',
          error: '550 Boîte inexistante',
          recipients: ['jeanne@durand.fr', 'ancien@durand.fr'],
          failed: ['ancien@durand.fr'],
        }),
      )
      await asTenant((tx) => journaliser(tx, { status: 'not_configured' }))
    })

    it('ne se corrige ni ne s’efface depuis l’application', async () => {
      const id = await asTenant((tx) => journaliser(tx))
      assert.equal(
        await codeErreur(() =>
          asTenant((tx) => tx.execute(sql`update notification_deliveries set subject = 'Autre' where id = ${id}`)),
        ),
        DB_INSUFFICIENT_PRIVILEGE,
      )
      assert.equal(
        await codeErreur(() =>
          asTenant((tx) => tx.execute(sql`delete from notification_deliveries where id = ${id}`)),
        ),
        DB_INSUFFICIENT_PRIVILEGE,
      )
    })

    it('se purge au terme de la durée du centre, et pas au-delà', async () => {
      await lire(
        `insert into tenants (id, name, slug) values (?, 'Autre centre', 'autre-centre-notifications')`,
        [AUTRE_CENTRE],
      )
      await asTenant(async (tx) => {
        await journaliser(tx, { sentAt: sql`date_sub(CURRENT_TIMESTAMP(3), interval 13 month)` })
        await journaliser(tx, { sentAt: sql`date_sub(CURRENT_TIMESTAMP(3), interval 11 month)` })
      })
      await lire(
        `insert into notification_deliveries (id, tenant_id, event, audience, recipients, subject, status, sent_at)
         values (?, ?, 'mail_request_submitted', 'centre', '["accueil@autre.fr"]', 'Demande', 'sent',
                 date_sub(CURRENT_TIMESTAMP(3), interval 5 year))`,
        [uuidv7(), AUTRE_CENTRE],
      )

      const purger = () =>
        asTenant(async (tx) => {
          await tx.execute(sql`call purge_expired_notification_deliveries(@purged)`)
          const [row] = await rowsOf(tx, sql`select @purged as purged`)
          return Number(row.purged)
        })

      assert.equal(await purger(), 1)
      const [reste] = await asTenant((tx) => rowsOf(tx, sql`select count(*) as n from notification_deliveries where tenant_id = ${DEFAULT_TENANT_ID}`),
      )
      assert.equal(Number(reste.n), 1)
      const [ailleurs] = await lire(
        'select count(*) as n from notification_deliveries where tenant_id = ?',
        [AUTRE_CENTRE],
      )
      assert.equal(Number(ailleurs.n), 1)

      // La durée du centre fait foi, y compris raccourcie.
      await lire('update tenants set notification_log_retention_months = 6 where id = ?', [DEFAULT_TENANT_ID])
      assert.equal(await purger(), 1)

      // Le verrou du journal est remis : une écriture directe reste refusée.
      assert.equal(
        await codeErreur(() =>
          asTenant((tx) => tx.execute(sql`delete from notification_deliveries`)),
        ),
        DB_INSUFFICIENT_PRIVILEGE,
      )
    })

    it('sous portée client, n’écrit que les messages adressés à l’une de ses entreprises', async () => {
      // Le client lui-même ne journalise pas (c'est le moteur, sous
      // `withTenant`) ; la base refuse néanmoins qu'une écriture sous portée
      // sorte de ses entreprises ou vise le centre.
      await asClients([DURAND], (tx) => journaliser(tx))
      assert.equal(
        await codeErreur(() =>
          asClients([DURAND], (tx) =>
            journaliser(tx, {
              event: 'mail_request_submitted',
              audience: 'centre',
              recipients: ['accueil@centre.fr'],
            }),
          ),
        ),
        DB_INSUFFICIENT_PRIVILEGE,
      )
      assert.equal(
        await codeErreur(() => asClients([DURAND], (tx) => journaliser(tx, { clientId: PETIT }))),
        DB_INSUFFICIENT_PRIVILEGE,
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
      assert.equal(await codeErreur(() => asTenant((tx) => modele(tx))), DB_UNIQUE_VIOLATION)
      await asTenant((tx) => modele(tx, 'mail_scanned'))
    })

    it('refuse un objet vide', async () => {
      assert.equal(
        await codeErreur(() => asTenant((tx) => modele(tx, 'mail_received', '  '))),
        DB_CHECK_VIOLATION,
      )
    })

    it('reste au back-office : non modifiable depuis un espace client', async () => {
      await asTenant((tx) => modele(tx))
      assert.equal(
        await codeErreur(() => asClients([DURAND], (tx) => modele(tx, 'mail_scanned'))),
        DB_INSUFFICIENT_PRIVILEGE,
      )
      assert.equal(
        await codeErreur(() =>
          asClients([DURAND], (tx) => tx.execute(sql`update notification_templates set active = 0`)),
        ),
        DB_INSUFFICIENT_PRIVILEGE,
      )
    })

    it('ne se supprime pas : revenir au texte par défaut, c’est le réécrire', async () => {
      await asTenant((tx) => modele(tx))
      assert.equal(
        await codeErreur(() => asTenant((tx) => tx.execute(sql`delete from notification_templates`))),
        DB_INSUFFICIENT_PRIVILEGE,
      )
    })
  })

  describe('préférences des personnes de l’espace client', () => {
    const preference = (tx: Transaction, clientId: string, memberId: string, enabled = false) =>
      tx.execute(sql`
        insert into notification_preferences (id, client_id, client_member_id, category, enabled)
        values (${uuidv7()}, ${clientId}, ${memberId}, 'mail', ${enabled ? 1 : 0})
        on duplicate key update enabled = ${enabled ? 1 : 0}`)

    it('une préférence par personne et par catégorie, que la personne règle elle-même', async () => {
      await asClients([DURAND], (tx) => preference(tx, DURAND, JEANNE, false))
      await asClients([DURAND], (tx) => preference(tx, DURAND, JEANNE, true))
      const [row] = await asTenant((tx) =>
        rowsOf(tx, sql`select count(*) as n, min(enabled) as enabled from notification_preferences`),
      )
      assert.equal(Number(row.n), 1)
      assert.equal(Number(row.enabled), 1)
      assert.equal(
        await codeErreur(() =>
          asTenant((tx) =>
            tx.execute(sql`
              insert into notification_preferences (client_id, client_member_id, category, enabled)
              values (${DURAND}, ${JEANNE}, 'mail', 0)`),
          ),
        ),
        DB_UNIQUE_VIOLATION,
      )
    })

    it('n’accepte que la personne de l’entreprise de la ligne', async () => {
      assert.equal(
        await codeErreur(() => asTenant((tx) => preference(tx, DURAND, PAUL))),
        DB_FOREIGN_KEY_VIOLATION,
      )
    })

    it('sous portée client, n’écrit pas les préférences d’une autre entreprise', async () => {
      await asTenant(async (tx) => {
        await preference(tx, DURAND, JEANNE)
        await preference(tx, PETIT, PAUL)
      })
      assert.equal(
        await codeErreur(() => asClients([DURAND], (tx) => preference(tx, PETIT, PAUL, true))),
        DB_INSUFFICIENT_PRIVILEGE,
      )
      // Une préférence se change, elle ne se supprime pas.
      assert.equal(
        await codeErreur(() =>
          asClients([DURAND], (tx) => tx.execute(sql`delete from notification_preferences`)),
        ),
        DB_INSUFFICIENT_PRIVILEGE,
      )
    })
  })
})
