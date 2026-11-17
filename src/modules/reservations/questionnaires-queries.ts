import { and, eq, isNull } from 'drizzle-orm'

import { withTenant } from '../../db/index.ts'
import { todayIsoDate } from '../../lib/dates.ts'
import { currentTenant, currentTenantId } from '../../lib/tenant.ts'
import { findDefaultRatePlan } from '../facturation/queries.ts'
import { services } from '../facturation/schema.ts'
import { pickRateItem } from '../facturation/tarifs.ts'
import type { DomiciliationOffer } from './domiciliation-tarif.ts'
import { questionnaireProblem, storedQuestions } from './questionnaires-edition.ts'
import { defaultQuestionnaires, formulaires, type Formulaire, type Question, type Questionnaire } from './questionnaires.ts'
import { requestForms, type RequestFormRow } from './schema-questionnaires.ts'

/**
 * Formulaires de demande du centre (ADR 074) : lus en base, réglés par le
 * centre, ou ceux du code tant qu'il n'y a pas touché. Toute lecture filtre
 * `tenant_id` (décision 1) ; les écritures passent par `withTenant()`, gardées
 * par la base (`CA014`).
 */

export type FormSettings = {
  questionnaire: Questionnaire
  /** Domiciliation : services proposés en option, par code. */
  serviceCodes: string[]
  /** Le centre a déjà réglé ce formulaire. */
  customized: boolean
  updatedAt: Date | null
}

/** Le formulaire d'une ligne de réglage, ou celui du code. Une ligne illisible repart du code. */
function settingsFrom(form: Formulaire, row: RequestFormRow | undefined): FormSettings {
  const fallback = defaultQuestionnaires[form]
  if (!row) return { questionnaire: fallback, serviceCodes: [], customized: false, updatedAt: null }
  const questions = storedQuestions(row.questions)
  if (!questions) console.error(`Formulaire « ${form} » illisible en base : questions par défaut.`)
  return {
    questionnaire: {
      ...fallback,
      label: row.label,
      description: row.description,
      questions: questions ?? fallback.questions,
    },
    serviceCodes: Array.isArray(row.serviceCodes) ? row.serviceCodes.filter((code): code is string => typeof code === 'string') : [],
    customized: true,
    updatedAt: row.updatedAt,
  }
}

export async function loadFormSettings(form: Formulaire): Promise<FormSettings> {
  const tenantId = currentTenantId()
  const [row] = await withTenant(tenantId, (tx) =>
    tx
      .select()
      .from(requestForms)
      .where(and(eq(requestForms.tenantId, tenantId), eq(requestForms.form, form)))
      .limit(1),
  )
  return settingsFrom(form, row)
}

/** Le questionnaire d'un formulaire, tel que le centre l'a réglé. */
export async function loadQuestionnaire(form: Formulaire): Promise<Questionnaire> {
  return (await loadFormSettings(form)).questionnaire
}

/** Tous les formulaires du centre, en une lecture. */
export async function loadAllFormSettings(): Promise<Record<Formulaire, FormSettings>> {
  const tenantId = currentTenantId()
  const rows = await withTenant(tenantId, (tx) =>
    tx.select().from(requestForms).where(eq(requestForms.tenantId, tenantId)),
  )
  return Object.fromEntries(
    formulaires.map((form) => [form, settingsFrom(form, rows.find((row) => row.form === form))]),
  ) as Record<Formulaire, FormSettings>
}

export async function loadQuestionnaires(): Promise<Record<Formulaire, Questionnaire>> {
  const settings = await loadAllFormSettings()
  return Object.fromEntries(formulaires.map((form) => [form, settings[form].questionnaire])) as Record<Formulaire, Questionnaire>
}

/** Refus d'un réglage de formulaire, avec le message à afficher. */
export class FormSettingsError extends Error {}

export const FORM_LABEL_MAX_LENGTH = 120
export const FORM_DESCRIPTION_MAX_LENGTH = 300

export type FormSettingsChange = {
  label?: string
  description?: string
  questions?: Question[]
  serviceCodes?: string[]
}

/**
 * Change le réglage d'un formulaire, d'après le réglage courant relu sous
 * verrou : deux membres qui modifient le même formulaire ne s'écrasent pas.
 * Sans ligne, le formulaire part de celui du code. Le résultat est relu par
 * les règles du questionnaire avant d'être écrit.
 */
export async function updateFormSettings(
  form: Formulaire,
  change: (current: FormSettings) => FormSettingsChange,
  staffMemberId: string,
): Promise<void> {
  const tenantId = currentTenantId()
  await withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(requestForms)
      .where(and(eq(requestForms.tenantId, tenantId), eq(requestForms.form, form)))
      .limit(1)
      .for('update')
    const current = settingsFrom(form, row)
    const next = change(current)
    const label = (next.label ?? current.questionnaire.label).trim()
    const description = (next.description ?? current.questionnaire.description).trim()
    const questions = next.questions ?? [...current.questionnaire.questions]
    const serviceCodes = next.serviceCodes ?? current.serviceCodes
    if (!label || label.length > FORM_LABEL_MAX_LENGTH) throw new FormSettingsError(`Le nom du service compte de 1 à ${FORM_LABEL_MAX_LENGTH} caractères.`)
    if (!description || description.length > FORM_DESCRIPTION_MAX_LENGTH) {
      throw new FormSettingsError(`La présentation compte de 1 à ${FORM_DESCRIPTION_MAX_LENGTH} caractères.`)
    }
    const problem = questionnaireProblem(questions)
    if (problem) throw new FormSettingsError(problem)
    const values = { label, description, questions, serviceCodes, updatedBy: staffMemberId }
    await tx
      .insert(requestForms)
      .values({ tenantId, form, ...values })
      .onDuplicateKeyUpdate({ set: values })
  })
}

/**
 * Ce que le formulaire de domiciliation chiffre (ADR 074) : le forfait au mois
 * de la boîte aux lettres dans la grille par défaut du jour, et les services
 * proposés en option — forfaits mensuels vivants et actifs du catalogue, dans
 * l'ordre réglé par le centre. Un code proposé dont le service a disparu est
 * ignoré.
 */
export async function loadDomiciliationOffer(serviceCodes?: readonly string[]): Promise<DomiciliationOffer> {
  const tenant = await currentTenant()
  const codes = serviceCodes ?? (await loadFormSettings('domiciliation')).serviceCodes
  const [plan, available] = await Promise.all([
    findDefaultRatePlan(todayIsoDate(tenant.timezone)),
    listOfferableServices(),
  ])
  const item = plan ? pickRateItem(plan.items, { resourceId: null, resourceType: 'boite_aux_lettres', unit: 'month' }) : undefined
  return {
    currency: plan?.currency ?? tenant.currency,
    base: item ? { label: 'Domiciliation, forfait mensuel', amountCents: item.amountCents, vatRateBp: tenant.defaultVatRateBp, ratePlanItemId: item.id } : null,
    options: codes.flatMap((code) => {
      const service = available.find((candidate) => candidate.code === code)
      return service
        ? [{ code, serviceId: service.id, label: service.name, description: service.description, amountCents: service.unitPriceCents, vatRateBp: service.vatRateBp }]
        : []
    }),
  }
}

export type OfferableService = {
  id: string
  code: string
  name: string
  description: string | null
  unitPriceCents: number
  vatRateBp: number
  currency: string
}

/**
 * Les services qu'une domiciliation peut proposer en option : forfaits
 * mensuels vivants, actifs, avec un code (la référence Dolibarr, ADR 049).
 */
export async function listOfferableServices(): Promise<OfferableService[]> {
  const tenantId = currentTenantId()
  const rows = await withTenant(tenantId, (tx) =>
    tx
      .select({
        id: services.id,
        code: services.code,
        name: services.name,
        description: services.description,
        unitPriceCents: services.unitPriceCents,
        vatRateBp: services.vatRateBp,
        currency: services.currency,
      })
      .from(services)
      .where(
        and(
          eq(services.tenantId, tenantId),
          isNull(services.deletedAt),
          eq(services.isActive, true),
          eq(services.nature, 'package'),
          eq(services.unit, 'month'),
        ),
      )
      .orderBy(services.name),
  )
  return rows.flatMap((row) => (row.code ? [{ ...row, code: row.code }] : []))
}
