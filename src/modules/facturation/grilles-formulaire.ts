/**
 * Saisie d'une grille tarifaire : nom, dates de validité, rôle de grille par
 * défaut (R08). Module pur, éprouvé seul (`grilles-formulaire.test.ts`) :
 * l'action serveur ne fait que l'appeler.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** Une date ISO qui existe : le 31 février est refusé. */
function isCalendarDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

export const ratePlanFieldLabels: Record<string, string> = {
  name: 'Nom de la grille',
  validFrom: 'Valable à partir du',
  validTo: 'Jusqu’au',
}

export type RatePlanFormValues = {
  name: string
  validFrom: string
  validTo: string
  isDefault: boolean
}

export type RatePlanFormResult =
  | {
      ok: true
      input: { name: string; validFrom: string | null; validTo: string | null; isDefault: boolean }
    }
  | { ok: false; fieldErrors: Record<string, string> }

export function validateRatePlanForm(values: RatePlanFormValues): RatePlanFormResult {
  const fieldErrors: Record<string, string> = {}
  const name = values.name.trim()
  const validFrom = values.validFrom.trim()
  const validTo = values.validTo.trim()

  if (!name) fieldErrors.name = 'Nommez la grille.'
  else if (name.length > 120) fieldErrors.name = 'Nom trop long : 120 caractères au plus.'
  if (validFrom && !isCalendarDate(validFrom)) fieldErrors.validFrom = 'Date illisible.'
  if (validTo && !isCalendarDate(validTo)) fieldErrors.validTo = 'Date illisible.'
  if (!fieldErrors.validFrom && !fieldErrors.validTo && validFrom && validTo && validTo < validFrom) {
    fieldErrors.validTo = 'La fin de validité doit suivre le début.'
  }

  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors }
  return {
    ok: true,
    input: { name, validFrom: validFrom || null, validTo: validTo || null, isDefault: values.isDefault },
  }
}
