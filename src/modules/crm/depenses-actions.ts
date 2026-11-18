'use server'

import { revalidatePath } from 'next/cache'

import { DB_CHECK_VIOLATION, dbErrorCode } from '../../db/errors.ts'
import { requirePermission } from '../../lib/auth/staff.ts'
import { saveExpenseSettings } from './depenses-queries.ts'
import { readExpenseSettingsForm, type ExpenseSettingsField } from './depenses-reglages.ts'

/*
 * Réglages de « Mes dépenses » (ADR 081). L'action revérifie son droit : une
 * action serveur s'invoque par son identifiant, depuis n'importe quel chemin
 * (ADR 008, ADR 019).
 */

export type ExpenseSettingsFormState = {
  ok?: string
  error?: string
  fieldErrors?: Partial<Record<ExpenseSettingsField, string>>
  values?: Record<string, string>
} | null

export async function saveExpenseSettingsAction(
  _previous: ExpenseSettingsFormState,
  formData: FormData,
): Promise<ExpenseSettingsFormState> {
  const { member } = await requirePermission('centre.configurer')
  const values = {
    showExpenses: formData.get('showExpenses') === 'on' ? 'on' : '',
    estimateMailActs: formData.get('estimateMailActs') === 'on' ? 'on' : '',
    historyMonths: String(formData.get('historyMonths') ?? ''),
    note: String(formData.get('note') ?? ''),
  }
  const read = readExpenseSettingsForm(formData)
  if (!read.ok) return { fieldErrors: read.fieldErrors, values }
  try {
    await saveExpenseSettings(read.value, member.id)
  } catch (error) {
    if (dbErrorCode(error) === DB_CHECK_VIOLATION) return { error: 'Réglage refusé par la base.', values }
    throw error
  }
  revalidatePath('/reglages/depenses')
  revalidatePath('/compte/factures')
  return {
    ok: read.value.showExpenses
      ? 'Réglages enregistrés : l’espace client les applique dès maintenant.'
      : 'Réglages enregistrés : les dépenses ne sont plus montrées aux clients ; leurs factures, si.',
  }
}
