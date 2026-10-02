'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { requirePermission } from '../../lib/auth/staff.ts'
import { isUuid } from '../../lib/uuid.ts'
import {
  AccountingAccountError,
  EmptyExportError,
  generateAccountingExport,
  saveClientAccountingCodes,
  updateAccountingAccount,
} from './comptabilite.ts'
import { FecExportError } from './fec.ts'
import { daysBetween, isIsoDate } from './paiements-regles.ts'

/*
 * Export comptable et plan de comptes (R16, ADR 027, ADR 030), droit
 * `comptabilite.exporter`.
 */

export type ExportField = 'periodStart' | 'periodEnd'

export type ExportFormState = {
  fieldErrors?: Partial<Record<ExportField, string>>
  message?: string
  /** Ce qui manque au plan de comptes ou aux fiches. */
  problems?: string[]
  values?: Record<ExportField, string>
} | null

/** Un exercice au plus : au-delà, le fichier ne correspond plus à rien de comptable. */
const MAX_PERIOD_DAYS = 366

export async function generateExportAction(
  _previous: ExportFormState,
  formData: FormData,
): Promise<ExportFormState> {
  const { member } = await requirePermission('comptabilite.exporter')
  const values = {
    periodStart: String(formData.get('periodStart') ?? '').trim(),
    periodEnd: String(formData.get('periodEnd') ?? '').trim(),
  }
  const fieldErrors: Partial<Record<ExportField, string>> = {}
  if (!isIsoDate(values.periodStart)) fieldErrors.periodStart = 'Saisissez le premier jour de la période.'
  if (!isIsoDate(values.periodEnd)) fieldErrors.periodEnd = 'Saisissez le dernier jour de la période.'
  if (!fieldErrors.periodStart && !fieldErrors.periodEnd) {
    if (values.periodEnd < values.periodStart) fieldErrors.periodEnd = 'Le dernier jour suit le premier.'
    else if (daysBetween(values.periodStart, values.periodEnd) >= MAX_PERIOD_DAYS) {
      fieldErrors.periodEnd = 'Une période d’un an au plus.'
    }
  }
  if (Object.keys(fieldErrors).length > 0) return { fieldErrors, values }

  let id: string
  try {
    id = (await generateAccountingExport({ ...values, generatedBy: member.id })).id
  } catch (error) {
    if (error instanceof FecExportError) {
      return { message: 'L’export n’a pas été généré :', problems: error.problems, values }
    }
    if (error instanceof EmptyExportError) return { message: error.message, values }
    throw error
  }
  revalidatePath('/comptabilite')
  redirect(`/comptabilite?export=${id}#journal`)
}

export type AccountFormState = { error?: string; saved?: boolean } | null

/** Corrige un compte du plan : numéro et libellé. */
export async function updateAccountAction(
  _previous: AccountFormState,
  formData: FormData,
): Promise<AccountFormState> {
  await requirePermission('comptabilite.exporter')
  const id = String(formData.get('id') ?? '')
  try {
    const updated = await updateAccountingAccount(id, {
      accountNumber: String(formData.get('accountNumber') ?? ''),
      label: String(formData.get('label') ?? ''),
    })
    if (!updated) return { error: 'Compte introuvable.' }
  } catch (error) {
    if (error instanceof AccountingAccountError) return { error: error.message }
    throw error
  }
  revalidatePath('/comptabilite')
  return { saved: true }
}

export type ClientCodesState = {
  /** Erreur par client (son identifiant), ou sous la clé vide pour tout le formulaire. */
  errors?: Record<string, string>
  values?: Record<string, string>
  saved?: boolean
} | null

/** Fixe les comptes auxiliaires des clients facturés (`code-<id>`). */
export async function saveClientCodesAction(
  _previous: ClientCodesState,
  formData: FormData,
): Promise<ClientCodesState> {
  await requirePermission('comptabilite.exporter')
  const values: Record<string, string> = {}
  const codes = new Map<string, string | null>()
  for (const [key, raw] of formData.entries()) {
    if (!key.startsWith('code-')) continue
    const clientId = key.slice('code-'.length)
    if (!isUuid(clientId)) continue
    const code = String(raw).replace(/\s/g, '').toUpperCase()
    values[clientId] = code
    codes.set(clientId, code || null)
  }
  const errors = await saveClientAccountingCodes(codes)
  if (Object.keys(errors).length > 0) return { errors, values }
  revalidatePath('/comptabilite')
  return { saved: true }
}
