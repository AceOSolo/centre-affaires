/**
 * Réglages de « Mes dépenses » dans l'espace client (ADR 081), par centre :
 * valeurs par défaut, lecture de la ligne en base et du formulaire. Module
 * pur, sans base ni Next : le formulaire, l'action et les tests le partagent.
 *
 * Sans réglage, les valeurs par défaut : rien à faire pour que la rubrique
 * apparaisse. Tout se règle dans Réglages > « Dépenses dans l'espace client ».
 */

/** La phrase sous le total estimé, tant que le centre n'en écrit pas une autre. */
export const DEFAULT_EXPENSE_NOTE = 'Montant estimé, facturé en fin de mois par le centre.'

/** Longueur maximale de la phrase (`client_expense_settings.note`). */
export const EXPENSE_NOTE_MAX_LENGTH = 300

/** Mois passés qu'on peut choisir de montrer, en plus du mois en cours. */
export const expenseHistoryChoices = [3, 6, 12, 24] as const

export type ExpenseSettings = {
  showExpenses: boolean
  estimateMailActs: boolean
  historyMonths: number
  /** La phrase montrée : celle du centre, sinon la phrase par défaut. */
  note: string
  /** Le centre a écrit sa propre phrase. */
  customNote: boolean
}

export const defaultExpenseSettings: ExpenseSettings = {
  showExpenses: true,
  estimateMailActs: true,
  historyMonths: 12,
  note: DEFAULT_EXPENSE_NOTE,
  customNote: false,
}

/** La ligne du centre, relue ; sans ligne, les valeurs par défaut. */
export function readExpenseSettings(
  row: { showExpenses: boolean; estimateMailActs: boolean; historyMonths: number; note: string | null } | undefined,
): ExpenseSettings {
  if (!row) return { ...defaultExpenseSettings }
  return {
    showExpenses: Boolean(row.showExpenses),
    estimateMailActs: Boolean(row.estimateMailActs),
    historyMonths: row.historyMonths >= 1 && row.historyMonths <= 24 ? row.historyMonths : defaultExpenseSettings.historyMonths,
    note: row.note?.trim() || DEFAULT_EXPENSE_NOTE,
    customNote: Boolean(row.note?.trim()),
  }
}

export type ExpenseSettingsInput = {
  showExpenses: boolean
  estimateMailActs: boolean
  historyMonths: number
  /** Nulle : la phrase par défaut. */
  note: string | null
}

export type ExpenseSettingsField = 'historyMonths' | 'note'

export const expenseSettingsLabels: Record<ExpenseSettingsField, string> = {
  historyMonths: 'Mois passés montrés',
  note: 'Phrase sous le total',
}

type FormLike = { get(name: string): FormDataEntryValue | null }

/**
 * Lit le formulaire. Une case décochée est absente du formulaire : faux. Une
 * phrase vide, ou identique à celle par défaut, revient à la phrase par
 * défaut (gardée nulle : elle suivra le code si elle change).
 */
export function readExpenseSettingsForm(
  form: FormLike,
): { ok: true; value: ExpenseSettingsInput } | { ok: false; fieldErrors: Partial<Record<ExpenseSettingsField, string>> } {
  const fieldErrors: Partial<Record<ExpenseSettingsField, string>> = {}
  const months = Number(String(form.get('historyMonths') ?? ''))
  if (!(expenseHistoryChoices as readonly number[]).includes(months)) {
    fieldErrors.historyMonths = `Choisissez ${expenseHistoryChoices.slice(0, -1).join(', ')} ou ${expenseHistoryChoices.at(-1)} mois.`
  }
  const note = String(form.get('note') ?? '')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ')
    .trim()
  if (note.length > EXPENSE_NOTE_MAX_LENGTH) {
    fieldErrors.note = `${EXPENSE_NOTE_MAX_LENGTH} caractères au plus (${note.length} saisis).`
  }
  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors }
  return {
    ok: true,
    value: {
      showExpenses: form.get('showExpenses') === 'on',
      estimateMailActs: form.get('estimateMailActs') === 'on',
      historyMonths: months,
      note: note === '' || note === DEFAULT_EXPENSE_NOTE ? null : note,
    },
  }
}
