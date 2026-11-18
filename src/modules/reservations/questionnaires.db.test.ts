import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { eq, sql } from 'drizzle-orm'

import { DB_QUESTIONNAIRE_REFUSED, dbErrorCode } from '../../db/errors.ts'
import { withTenant, type Transaction } from '../../db/index.ts'
import { ouvrirBasesDeTest, raisonDeSaut, viderTables, type TestDatabases } from '../../db/test-support.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { runForTenant } from '../../lib/tenant.ts'
import { uuidv7 } from '../../lib/uuid.ts'
import { createProposalInTransaction, findProposal } from '../facturation/propositions-queries.ts'
import { addRatePlanItem } from '../facturation/queries.ts'
import { proposals } from '../facturation/schema-devis.ts'
import { describeDomiciliationPrice, domiciliationLines } from './domiciliation-tarif.ts'
import { putQuestion, setQuestionHidden } from './questionnaires-edition.ts'
import {
  FormSettingsError,
  loadDomiciliationOffer,
  loadFormSettings,
  loadQuestionnaire,
  updateFormSettings,
} from './questionnaires-queries.ts'
import { answersForDisplay, defaultQuestionnaires, describeAnswers } from './questionnaires.ts'

/**
 * Formulaires de demande réglés par le centre, contre la base (ADR 074) : les
 * questions du code tant que le centre n'y touche pas, un réglage par centre,
 * la forme des questions tenue par la base (`CA020`), les options tarifées de
 * la domiciliation et les réponses figées sur le devis.
 */
describe('formulaires de demande, en base', { skip: raisonDeSaut }, () => {
  const AUTRE = '01999f00-0000-7000-8000-0000000000d7'
  const GRILLE = '01a00000-0000-7000-8000-000000f0a001'
  let bases: TestDatabases
  let direction: string

  const asTenant = <T>(run: (tx: Transaction) => Promise<T>) => withTenant(DEFAULT_TENANT_ID, run, bases.app.db)

  const code = async (run: () => Promise<unknown>) => {
    try {
      await run()
    } catch (error) {
      return dbErrorCode(error)
    }
    return undefined
  }

  before(async () => {
    bases = await ouvrirBasesDeTest()
    ;(globalThis as { database?: unknown }).database = bases.app
    await bases.owner.client.query(
      `insert into tenants (id, name, slug) values (?, 'Centre de Lyon', 'centre-de-lyon-formulaires') on duplicate key update id = id`,
      [AUTRE],
    )
  })

  beforeEach(async () => {
    await viderTables(bases.owner, 'questionnaires', 'proposal_lines', 'proposals', 'document_sequences', 'services', 'rate_plan_items', 'rate_plans', 'staff_members')
    direction = uuidv7()
    await bases.owner.client.query(
      `insert into staff_members (id, tenant_id, email, full_name, role) values (?, ?, 'direction@exemple.fr', 'Camille Direction', 'super_admin')`,
      [direction, DEFAULT_TENANT_ID],
    )
  })

  after(async () => {
    await viderTables(bases.owner, 'questionnaires', 'proposal_lines', 'proposals', 'document_sequences', 'services', 'rate_plan_items', 'rate_plans', 'staff_members')
    await bases.owner.client.query('delete from tenants where id = ?', [AUTRE])
    delete (globalThis as { database?: unknown }).database
    await bases?.fermer()
  })

  it('pose les questions du code tant que le centre n’y a pas touché', async () => {
    const settings = await loadFormSettings('bureau')
    assert.equal(settings.customized, false)
    assert.deepEqual(settings.questionnaire, defaultQuestionnaires.bureau)
    assert.deepEqual(settings.serviceCodes, [])
  })

  it('garde le réglage d’un centre, sans toucher à celui d’un autre', async () => {
    await updateFormSettings(
      'salle',
      ({ questionnaire }) => ({
        label: 'Salle de réunion ou de formation',
        questions: putQuestion(setQuestionHidden(questionnaire.questions, 'restauration', true), {
          name: 'parking',
          label: 'Une place de parking ?',
          kind: 'yesno',
        }),
      }),
      direction,
    )
    const salle = await loadQuestionnaire('salle')
    assert.equal(salle.label, 'Salle de réunion ou de formation')
    assert.equal(salle.description, defaultQuestionnaires.salle.description)
    assert.equal(salle.questions.find((question) => question.name === 'restauration')?.hidden, true)
    assert.equal(salle.questions.at(-1)?.name, 'parking')
    const [row] = await bases.owner.client.query('select updated_by as updatedBy from questionnaires where form = ?', ['salle']) as unknown as [{ updatedBy: string }[]]
    assert.equal(row[0].updatedBy, direction)

    // Le centre de Lyon garde les questions du code.
    const ailleurs = await runForTenant(AUTRE, () => loadQuestionnaire('salle'))
    assert.deepEqual(ailleurs, defaultQuestionnaires.salle)
  })

  it('refuse un questionnaire bancal, dans le code comme en base (CA020)', async () => {
    await assert.rejects(
      updateFormSettings('domiciliation', ({ questionnaire }) => ({ questions: [...questionnaire.questions].reverse() }), direction),
      FormSettingsError,
    )
    assert.equal((await loadFormSettings('domiciliation')).customized, false)

    const insertion = (questions: string, codes = '[]') =>
      code(() =>
        bases.owner.client.query(
          `insert into questionnaires (id, form, label, description, questions, service_codes) values (?, 'salle', 'Salle', 'Une salle.', ?, ?)`,
          [uuidv7(), questions, codes],
        ),
      )
    assert.equal(await insertion('[{"name":"1abc","label":"x","kind":"text"}]'), DB_QUESTIONNAIRE_REFUSED)
    assert.equal(await insertion('[{"name":"a","label":"x","kind":"inconnu"}]'), DB_QUESTIONNAIRE_REFUSED)
    assert.equal(await insertion('[{"name":"a","label":"x","kind":"choice","choices":[{"value":"Pas Bon","label":"x"}]}]'), DB_QUESTIONNAIRE_REFUSED)
    assert.equal(await insertion('[]', '["Code Faux"]'), DB_QUESTIONNAIRE_REFUSED)
    assert.equal(await insertion('[{"name":"a","label":"x","kind":"text"}]', '["domiciliation.scan"]'), undefined)
  })

  it('chiffre la domiciliation : le forfait de la grille et les options choisies par le centre', async () => {
    await asTenant(async (tx) => {
      await tx.execute(sql`insert into rate_plans (id, name, is_default) values (${GRILLE}, 'Tarifs 2026', true)`)
      await tx.execute(sql`
        insert into services (id, code, name, nature, unit, unit_price_cents) values
          (${uuidv7()}, 'domiciliation.scan', 'Numérisation du courrier', 'package', 'month', 1250),
          (${uuidv7()}, 'domiciliation.reexpedition', 'Réexpédition hebdomadaire', 'package', 'month', 2500),
          (${uuidv7()}, 'courrier.ouverture', 'Ouverture d’un pli', 'act', 'unit', 200)`)
    })
    await addRatePlanItem({ ratePlanId: GRILLE, resourceType: 'boite_aux_lettres', unit: 'month', amountCents: 3_000 })

    // Sans option choisie, le forfait seul.
    const seul = await loadDomiciliationOffer()
    assert.equal(seul.base?.amountCents, 3_000)
    assert.deepEqual(seul.options, [])

    // Un acte (à l'unité) n'est pas proposable ; un code disparu est ignoré.
    await updateFormSettings('domiciliation', () => ({ serviceCodes: ['domiciliation.scan', 'domiciliation.reexpedition', 'courrier.ouverture', 'disparu'] }), direction)
    const offer = await loadDomiciliationOffer()
    assert.deepEqual(offer.options.map((option) => option.code), ['domiciliation.scan', 'domiciliation.reexpedition'])

    // Le devis né de la demande : forfait et option, au prix annoncé, et le tarif en clair.
    const answers = { situation: 'immatriculee', raisonSociale: 'Atelier Martin', siret: '73282932000074', services: ['domiciliation.scan'] }
    const proposal = await asTenant((tx) =>
      createProposalInTransaction(tx, {
        product: 'domiciliation',
        channel: 'public',
        requesterName: 'Léa Martin',
        requesterEmail: 'lea@atelier.fr',
        requesterCompany: 'Atelier Martin',
        answers,
        describedAnswers: [
          ...describeAnswers(defaultQuestionnaires.domiciliation, answers),
          ...describeDomiciliationPrice(offer, ['domiciliation.scan']),
        ],
        currency: offer.currency,
        lines: domiciliationLines(offer, ['domiciliation.scan']),
      }),
    )
    const detail = await findProposal(proposal.id)
    assert.equal(detail?.status, 'draft')
    assert.deepEqual(detail?.lines.map((line) => [line.source, line.unitPriceCents, line.amountCents]), [
      ['manual', 3_000, 3_000],
      ['service', 1_250, 1_250],
    ])
    const lues = answersForDisplay({ ...detail!, answers: detail!.answers })
    assert.equal(lues.find((answer) => answer.name === 'siret')?.value, '732 829 320 00074')
    assert.match(lues.find((answer) => answer.name === 'tarif')?.value ?? '', /^42,50\s€ HT, soit 51,00\s€ TTC par mois$/)
  })

  it('fige les réponses lues par le demandeur hors brouillon (CA020)', async () => {
    const created = await asTenant((tx) =>
      createProposalInTransaction(tx, {
        product: 'domiciliation',
        channel: 'staff',
        requesterEmail: 'lea@atelier.fr',
        answers: { forme: 'sas' },
        describedAnswers: [{ name: 'forme', label: 'Forme juridique', value: 'SAS ou SASU' }],
        lines: [{ source: 'manual', label: 'Forfait', description: null, unit: 'month', quantity: 1, unitPriceCents: 3_000, discountBp: null, discountAmountCents: null, vatRateBp: 2_000, resourceId: null, serviceId: null, ratePlanItemId: null }],
        validate: false,
      }),
    )
    const corriger = (value: string) =>
      asTenant((tx) =>
        tx.update(proposals).set({ describedAnswers: [{ name: 'forme', label: 'Forme juridique', value }] }).where(eq(proposals.id, created.id)),
      )
    // En brouillon, l'accueil corrige.
    assert.equal(await code(() => corriger('SARL ou EURL')), undefined)
    await asTenant((tx) => tx.update(proposals).set({ status: 'ready' }).where(eq(proposals.id, created.id)))
    assert.equal(await code(() => corriger('SCI')), DB_QUESTIONNAIRE_REFUSED)
    assert.equal((await findProposal(created.id))?.describedAnswers?.[0].value, 'SARL ou EURL')
  })
})
