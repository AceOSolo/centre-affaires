import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'

import { DB_FOREIGN_KEY_VIOLATION, dbErrorCode } from '../../db/errors.ts'
import { withTenant, type Transaction } from '../../db/index.ts'
import { ouvrirBasesDeTest, raisonDeSaut, viderTables, type TestDatabases } from '../../db/test-support.ts'
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
describe('écrans des notifications', { skip: raisonDeSaut }, () => {
  let bases: TestDatabases
  const compter = async (table: string) =>
    Number(((await bases.owner.client.query(`select count(*) as n from ${table}`))[0] as { n: number }[])[0].n)

  const DURAND = '01a00000-0000-7000-8000-0000000f3c01'
  const PETIT = '01a00000-0000-7000-8000-0000000f3c02'
  const JEANNE = '01a00000-0000-7000-8000-0000000f3d01'
  const JEANNE_PETIT = '01a00000-0000-7000-8000-0000000f3d02'
  const PAUL = '01a00000-0000-7000-8000-0000000f3d03'
  const CAMILLE = '01a00000-0000-7000-8000-0000000f3e01'

  const durand: ClientAccount = { memberId: JEANNE, clientId: DURAND, clientName: 'Atelier Durand' }
  const petit: ClientAccount = { memberId: JEANNE_PETIT, clientId: PETIT, clientName: 'Boulangerie Petit' }

  const asTenant = <T>(run: (tx: Transaction) => Promise<T>) =>
    withTenant(DEFAULT_TENANT_ID, run, bases.app.db)
  const tous = { mail: true, bookings: true, invoices: true, contracts: true, inspections: true, mail_none: true }

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
    await viderTables(bases.owner, 'notification_deliveries', 'notification_templates', 'notification_preferences')
    await bases.fermer()
  })

  describe('modèles', () => {
    it('part du texte par défaut tant que rien n’est écrit', async () => {
      const state = await findTemplateState('invoice_issued', bases.app.db)
      assert.deepEqual(
        [state.subject, state.body, state.active, state.customized, state.stored],
        [defaultTemplates.invoice_issued.subject, defaultTemplates.invoice_issued.body, true, false, false],
      )
      assert.equal((await listTemplateStates(notificationEvents, bases.app.db)).length, notificationEvents.length)
    })

    it('écrit, réécrit puis rétablit le texte par défaut, sans jamais supprimer', async () => {
      await saveTemplate('invoice_issued', { subject: 'Facture {{numero}}', body: 'Texte', active: true }, CAMILLE, bases.app.db)
      let state = await findTemplateState('invoice_issued', bases.app.db)
      assert.deepEqual([state.subject, state.customized, state.stored], ['Facture {{numero}}', true, true])
      assert.equal(state.updatedByName, 'Camille Martin')

      await saveTemplate('invoice_issued', { subject: 'Autre', body: 'Texte', active: false }, CAMILLE, bases.app.db)
      state = await findTemplateState('invoice_issued', bases.app.db)
      assert.deepEqual([state.subject, state.active], ['Autre', false])

      await saveTemplate('invoice_issued', { ...defaultTemplates.invoice_issued, active: false }, CAMILLE, bases.app.db)
      state = await findTemplateState('invoice_issued', bases.app.db)
      assert.deepEqual([state.customized, state.stored, state.active], [false, true, false])
      assert.equal(await compter('notification_templates'), 1)
    })
  })

  describe('journal', () => {
    const envoi = (values: { event?: string; status?: string; recipients?: string[]; sentAt?: string; error?: string | null }) =>
      asTenant((tx) =>
        tx.execute(sql`
          insert into notification_deliveries (event, audience, client_id, recipients, subject, status, error, sent_at)
          values (${values.event ?? 'mail_received'}, 'client', ${DURAND},
                  ${JSON.stringify(values.recipients ?? ['jeanne@durand.fr'])}, 'Objet',
                  ${values.status ?? 'sent'}, ${values.error ?? null},
                  ${new Date(values.sentAt ?? '2026-09-15T10:00:00Z')})`),
      )
    const lister = (params: Record<string, string>) =>
      listDeliveries(parseJournalFilters(params).filters, 'Europe/Paris', bases.app.db)

    it('filtre par événement, issue, période du centre et partie d’adresse', async () => {
      await envoi({})
      await envoi({ event: 'invoice_issued' })
      await envoi({ status: 'skipped', recipients: [], error: 'Modèle désactivé' })
      // 23 h 30 le 30 septembre à Paris : encore septembre pour le centre.
      await envoi({ sentAt: '2026-09-30T21:30:00Z', recipients: ['compta_durand@exemple.fr'] })
      // 0 h 30 le 1er octobre à Paris, 22 h 30 UTC le 30 septembre.
      await envoi({ sentAt: '2026-09-30T22:30:00Z', recipients: ['comptaxdurand@exemple.fr'] })

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
      // MySQL n'a pas `generate_series` : les lignes sont posées une à une.
      await asTenant(async (tx) => {
        for (let n = 1; n <= JOURNAL_PAGE_SIZE + 5; n++) {
          await tx.execute(sql`
            insert into notification_deliveries (event, audience, client_id, recipients, subject, status, sent_at)
            values ('mail_received', 'client', ${DURAND}, '["jeanne@durand.fr"]', ${`Objet ${n}`}, 'sent',
                    ${new Date(Date.UTC(2026, 8, 1, 0, n))})`)
        }
      })
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
      const [preferences] = await listMemberPreferences([durand], bases.app.db)
      assert.deepEqual(preferences.enabled, tous)
    })

    it('règle chaque accès séparément : la même personne, deux entreprises', async () => {
      assert.equal(
        await saveMemberPreferences([durand, petit], DURAND, { ...tous, invoices: false }, bases.app.db),
        true,
      )
      assert.equal(await saveMemberPreferences([durand, petit], DURAND, { ...tous, mail: false }, bases.app.db), true)
      const [pourDurand, pourPetit] = await listMemberPreferences([durand, petit], bases.app.db)
      assert.deepEqual(pourDurand.enabled, { ...tous, mail: false })
      assert.deepEqual(pourPetit.enabled, tous)
      assert.equal(await compter('notification_preferences'), 6)
    })

    it('refuse une entreprise hors du compte connecté', async () => {
      assert.equal(await saveMemberPreferences([durand], PETIT, tous, bases.app.db), false)
      assert.equal(await compter('notification_preferences'), 0)
    })

    it('sous portée client, ne lit que les préférences des entreprises du compte', async () => {
      await asTenant(async (tx) => {
        await tx.execute(sql`
          insert into notification_preferences (client_id, client_member_id, category, enabled) values
            (${DURAND}, ${JEANNE}, 'mail', 0), (${PETIT}, ${PAUL}, 'mail', 0)`)
      })
      // Un compte qui ne porte que Durand ne voit rien de Petit.
      const [pourDurand] = await listMemberPreferences([durand], bases.app.db)
      assert.equal(pourDurand.enabled.mail, false)
      const [pourPetit] = await listMemberPreferences([petit], bases.app.db)
      assert.equal(pourPetit.enabled.mail, true, 'la préférence de Paul ne vaut pas pour Jeanne')
    })

    it('ne laisse pas régler l’accès d’une autre entreprise, même avec un compte forgé', async () => {
      const forge: ClientAccount = { memberId: PAUL, clientId: DURAND, clientName: 'Atelier Durand' }
      let code: string | undefined
      try {
        await saveMemberPreferences([forge], DURAND, tous, bases.app.db)
      } catch (error) {
        code = dbErrorCode(error)
      }
      assert.equal(code, DB_FOREIGN_KEY_VIOLATION)
    })
  })
})
