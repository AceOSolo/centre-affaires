'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { requirePermission } from '../../lib/auth/staff.ts'
import { wallClockToUtc } from '../../lib/dates.ts'
import { currentTimeZone } from '../../lib/tenant.ts'
import { uuidv7 } from '../../lib/uuid.ts'
import { registerMailCounts, UnknownRecipientError } from './saisie-groupee.ts'
import { MAX_PER_ENTRY, parseMailCounts } from './saisie-groupee-regles.ts'

export type MailCountsFormState = {
  error?: string
  fieldErrors?: Record<string, string>
  /** Saisie renvoyée après un échec, pour ne rien retaper. */
  values?: Record<string, string>
} | null

/**
 * Saisie groupée du courrier : tous les plis de la saisie entrent dans la
 * tournée ouverte, puis retour à un tableau vide pour la distribution
 * suivante.
 */
export async function registerMailCountsAction(
  _previous: MailCountsFormState,
  formData: FormData,
): Promise<MailCountsFormState> {
  // Contrôle d'accès dans l'action elle-même (ADR 008).
  const { member } = await requirePermission('courrier.gerer')
  const timeZone = await currentTimeZone()

  const values: Record<string, string> = {}
  for (const [name, value] of formData.entries()) {
    if (typeof value === 'string' && value.trim() !== '') values[name] = value
  }

  const { counts, fieldErrors, total } = parseMailCounts(formData.entries())

  let receivedAt: Date | undefined
  try {
    receivedAt = wallClockToUtc(String(formData.get('receivedAt') ?? ''), timeZone)
    if (receivedAt.getTime() > Date.now() + 60_000) {
      fieldErrors.receivedAt = 'La date de réception ne peut pas être dans le futur.'
    }
  } catch {
    fieldErrors.receivedAt = 'Indiquez la date et l’heure de réception.'
  }

  if (Object.keys(fieldErrors).length > 0 || !receivedAt) return { fieldErrors, values }
  if (total === 0) {
    return { error: 'Aucun pli saisi : indiquez au moins un nombre dans le tableau.', values }
  }
  if (total > MAX_PER_ENTRY) {
    return {
      error: `${total} plis en une fois : au-delà de ${MAX_PER_ENTRY}, saisissez la tournée en deux envois.`,
      values,
    }
  }

  let done: { items: number; clients: number }
  try {
    done = await registerMailCounts(counts, receivedAt, member.id)
  } catch (error) {
    if (error instanceof UnknownRecipientError) {
      return {
        error: `${error.message} Rechargez la page : rien n’a été enregistré.`,
        values,
      }
    }
    throw error
  }

  revalidatePath('/courrier')
  // `saisie` distingue deux envois identiques : le tableau revient vide à chaque fois.
  redirect(`/courrier/tournee/saisie?plis=${done.items}&entreprises=${done.clients}&saisie=${uuidv7()}`)
}
