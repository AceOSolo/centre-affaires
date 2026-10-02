import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import { PG_FOREIGN_KEY_VIOLATION, pgErrorCode } from '../../db/errors.ts'
import { createDatabase, withTenant, type Transaction } from '../../db/index.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import type { ClientAccount } from '../clients/comptes.ts'
import { defaultTemplates } from './catalogue.ts'
import { JOURNAL_PAGE_SIZE, parseJournalFilters } from './journal-filtres.ts'
import {
  findTemplateState,
  listDeliveries,
  listMemberPreferences,
  listTemplateStates,
  saveMemberPreferences,
  saveTemplate,
} from './queries.ts'
import { notificationEvents } from './schema.ts'

/**
 * Écrans des notifications (R26, ADR 038), contre la base : modèles écrits et
 * rétablis, journal filtré, préférences réglées sous portée client.
 */
const ownerUrl = process.env.TEST_OWNER_DATABASE_URL ?? process.env.DATABASE_URL
const appUrl = process.env.TEST_DATABASE_URL

const raison = !appUrl
  ? 'TEST_DATABASE_URL non défini'
  : !ownerUrl
    ? 'TEST_OWNER_DATABASE_URL non défini'
    : false

describe('écrans des notifications', { skip: raison }, () => {
  const owner = createDatabase(ownerUrl ?? '', { onnotice: () => {} })
  const app = createDatabase(appUrl ?? '')

  const DURAND = '01a00000-0000-7000-8000-0000000f3c01'
  const PETIT = '01a00000-0000-7000-8000-0000000f3c02'
  const JEANNE = '01a00000-0000-7000-8000-0000000f3d01'
  const JEANNE_PETIT = '01a00000-0000-7000-8000-0000000f3d02'
  const PAUL = '01a00000-0000-7000-8000-0000000f3d03'
  const CAMILLE = '01a00000-0000-7000-8000-0000000f3e01'

  const durand: ClientAccount = { memberId: JEANNE, clientId: DURAND, clientName: 'Atelier Durand' }
  const petit: ClientAccount = { memberId: JEANNE_PETIT, clientId: PETIT, clientName: 'Boulangerie Petit' }

  const asTenant = <T>(run: (tx: Transaction) => Promise<T>) => withTenant(DEFAULT_TENANT_ID, run, app.db)
  const tous = { mail: true, bookings: true, invoices: true, contracts: true, inspections: true }

  before(async () => {
    await migrate(owner.db, { migrationsFolder: './src/db/migrations' })
  })

  beforeEach(async () => {
    await owner.client`truncate table clients, staff_members cascade`
    await owner.client`truncate table notification_deliveries, notification_templates, notification_preferences`
    await asTenant(async (tx) => {
      await tx.execute(sql`insert into staff_members (id, email, full_name) values (${CAMILLE}, 'camille@centre.exemple', 'Camille Martin')`)
      await tx.execute(sql`
        insert into clients (id, name, status) values
          (${DURAND}, 'Atelier Durand', 'active'), (${PETIT}, 'Boulangerie Petit', 'active')`)
      await tx.execute(sql`
        insert into client_members (id, client_id, email) values
          (${JEANNE}, ${DURAND}, 'jeanne@durand.fr'),
          (${JEANNE_PETIT}, ${PETIT}, 'jeanne@durand.fr'),
          (${PAUL}, ${PETIT}, 'paul@petit.fr')`)
    })
  })

  after(async () => {
    await owner.client`truncate table notification_deliveries, notification_templates, notification_preferences`
    await Promise.all([owner.client.end(), app.client.end()])
  })

  describe('modèles', () => {
    it('part du texte par défaut tant que rien n’est écrit', async () => {
      const state = await findTemplateState('invoice_issued', app.db)
      assert.deepEqual(
        [state.subject, state.body, state.active, state.customized, state.stored],
        [defaultTemplates.invoice_issued.subject, defaultTemplates.invoice_issued.body, true, false, false],
      )
      assert.equal((await listTemplateStates(notificationEvents, app.db)).length, notificationEvents.length)
    })

    it('écrit, réécrit puis rétablit le texte par défaut, sans jamais supprimer', async () => {
      await saveTemplate('invoice_issued', { subject: 'Facture {{numero}}', body: 'Texte', active: true }, CAMILLE, app.db)
      let state = await findTemplateState('invoice_issued', app.db)
      assert.deepEqual([state.subject, state.customized, state.stored], ['Facture {{numero}}', true, true])
      assert.equal(state.updatedByName, 'Camille Martin')

      await saveTemplate('invoice_issued', { subject: 'Autre', body: 'Texte', active: false }, CAMILLE, app.db)
      state = await findTemplateState('invoice_issued', app.db)
      assert.deepEqual([state.subject, state.active], ['Autre', false])

      await saveTemplate('invoice_issued', { ...defaultTemplates.invoice_issued, active: false }, CAMILLE, app.db)
      state = await findTemplateState('invoice_issued', app.db)
      assert.deepEqual([state.customized, state.stored, state.active], [false, true, false])
      const [{ n }] = await owner.client`select count(*)::int as n from notification_templates`
      assert.equal(n, 1)
    })
  })

  describe('journal', () => {
    const envoi = (values: { event?: string; status?: string; recipients?: string; sentAt?: string; error?: string | null }) =>
      asTenant((tx) =>
        tx.execute(sql`
          insert into notification_deliveries (event, audience, client_id, recipients, subject, status, error, sent_at)
          values (${values.event ?? 'mail_received'}, 'client', ${DURAND},
                  ${values.recipients ?? '{jeanne@durand.fr}'}::text[], 'Objet',
                  ${values.status ?? 'sent'}, ${values.error ?? null}, ${values.sentAt ?? '2026-09-15T10:00:00Z'})`),
      )
    const lister = (params: Record<string, string>) =>
      listDeliveries(parseJournalFilters(params).filters, 'Europe/Paris', app.db)

    it('filtre par événement, issue, période du centre et partie d’adresse', async () => {
      await envoi({})
      await envoi({ event: 'invoice_issued' })
      await envoi({ status: 'skipped', recipients: '{}', error: 'Modèle désactivé' })
      // 23 h 30 le 30 septembre à Paris : encore septembre pour le centre.
      await envoi({ sentAt: '2026-09-30T21:30:00Z', recipients: '{compta_durand@exemple.fr}' })
      // 0 h 30 le 1er octobre à Paris, 22 h 30 UTC le 30 septembre.
      await envoi({ sentAt: '2026-09-30T22:30:00Z', recipients: '{comptaxdurand@exemple.fr}' })

      assert.equal((await lister({})).total, 5)
      assert.equal((await lister({ evenement: 'invoice_issued' })).total, 1)
      assert.equal((await lister({ statut: 'skipped' })).total, 1)
      assert.equal((await lister({ du: '2026-09-30', au: '2026-09-30' })).total, 1)
      assert.equal((await lister({ du: '2026-10-01' })).total, 1)
      // `_` est un caractère, pas un joker : seule la première adresse correspond.
      const compta = await lister({ destinataire: 'COMPTA_' })
      assert.deepEqual(
        compta.rows.map((row) => row.recipients),
        [['compta_durand@exemple.fr']],
      )
      assert.equal(compta.rows[0].clientName, 'Atelier Durand')
    })

    it('pagine du plus récent au plus ancien', async () => {
      await asTenant((tx) =>
        tx.execute(sql`
          insert into notification_deliveries (event, audience, client_id, recipients, subject, status, sent_at)
          select 'mail_received', 'client', ${DURAND}, '{jeanne@durand.fr}', 'Objet ' || n, 'sent',
                 '2026-09-01T00:00:00Z'::timestamptz + make_interval(mins => n)
            from generate_series(1, ${JOURNAL_PAGE_SIZE + 5}) as n`),
      )
      const premiere = await lister({})
      assert.equal(premiere.pageCount, 2)
      assert.equal(premiere.rows.length, JOURNAL_PAGE_SIZE)
      assert.equal(premiere.rows[0].subject, `Objet ${JOURNAL_PAGE_SIZE + 5}`)
      const seconde = await lister({ page: '2' })
      assert.equal(seconde.rows.length, 5)
      assert.equal(seconde.rows.at(-1)?.subject, 'Objet 1')
      // Au-delà de la dernière page : la dernière.
      assert.equal((await lister({ page: '9' })).rows.length, 5)
    })
  })

  describe('préférences de l’espace client', () => {
    it('reçoit tout tant que rien n’est réglé', async () => {
      const [preferences] = await listMemberPreferences([durand], app.db)
      assert.deepEqual(preferences.enabled, tous)
    })

    it('règle chaque accès séparément : la même personne, deux entreprises', async () => {
      assert.equal(
        await saveMemberPreferences([durand, petit], DURAND, { ...tous, invoices: false }, app.db),
        true,
      )
      assert.equal(await saveMemberPreferences([durand, petit], DURAND, { ...tous, mail: false }, app.db), true)
      const [pourDurand, pourPetit] = await listMemberPreferences([durand, petit], app.db)
      assert.deepEqual(pourDurand.enabled, { ...tous, mail: false })
      assert.deepEqual(pourPetit.enabled, tous)
      const [{ n }] = await owner.client`select count(*)::int as n from notification_preferences`
      assert.equal(n, 5)
    })

    it('refuse une entreprise hors du compte connecté', async () => {
      assert.equal(await saveMemberPreferences([durand], PETIT, tous, app.db), false)
      const [{ n }] = await owner.client`select count(*)::int as n from notification_preferences`
      assert.equal(n, 0)
    })

    it('ne laisse pas régler l’accès d’une autre entreprise, même avec un compte forgé', async () => {
      const forge: ClientAccount = { memberId: PAUL, clientId: DURAND, clientName: 'Atelier Durand' }
      let code: string | undefined
      try {
        await saveMemberPreferences([forge], DURAND, tous, app.db)
      } catch (error) {
        code = pgErrorCode(error)
      }
      assert.equal(code, PG_FOREIGN_KEY_VIOLATION)
    })
  })
})
