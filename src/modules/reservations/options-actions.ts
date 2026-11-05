'use server'

import { revalidatePath } from 'next/cache'

import { requirePermission } from '../../lib/auth/staff.ts'
import { formatTime } from '../../lib/dates.ts'
import { currentTimeZone } from '../../lib/tenant.ts'
import { isUuid } from '../../lib/uuid.ts'
import { parseEquipmentIds } from './options.ts'
import { OptionRefusedError, addOptionsToBooking, type OptionLinesOutcome } from './options-queries.ts'
import { BookingConflictError } from './queries.ts'

/** État rendu au formulaire « Ajouter du matériel » : le refus, ou ce qui a été fait. */
export type AddOptionsFormState = { error?: string; done?: string } | null

/** Ce que le devis est devenu, en une phrase pour l'accueil. */
const proposalNotices: Record<OptionLinesOutcome, string> = {
  'aucun-devis': '',
  'a-jour': '',
  'mis-a-jour': ' Le prix est ajouté au devis de la réservation.',
  transmis:
    ' Le devis est déjà transmis à Dolibarr : il ne change plus. Annulez-le puis refaites-le pour y porter le matériel.',
}

/**
 * Ajoute des appareils en option d'une réservation de salle (ADR 062).
 * Contrôle d'accès dans l'action elle-même (ADR 008) ; la base tranche la
 * disponibilité (décision 3) et les règles de l'option (`CA018`).
 */
export async function addOptionsAction(_previous: AddOptionsFormState, formData: FormData): Promise<AddOptionsFormState> {
  const { member } = await requirePermission('reservations.gerer')
  const timeZone = await currentTimeZone()
  const bookingId = String(formData.get('bookingId') ?? '').trim()
  if (!isUuid(bookingId)) return { error: 'Réservation introuvable.' }
  const ids = parseEquipmentIds(formData.getAll('equipmentIds'))
  if (ids.length === 0) return { error: 'Cochez au moins un appareil.' }

  let added: { id: string }[]
  let proposal: OptionLinesOutcome
  try {
    ;({ added, proposal } = await addOptionsToBooking(bookingId, ids, member.id, timeZone))
  } catch (error) {
    if (error instanceof OptionRefusedError) return { error: error.message }
    if (error instanceof BookingConflictError) {
      const taken = error.conflicts
        .map((conflict) => `« ${conflict.title} » de ${formatTime(conflict.startsAt, timeZone)} à ${formatTime(conflict.endsAt, timeZone)}`)
        .join(', ')
      return {
        error: taken
          ? `Un appareil vient d’être pris sur cette période : ${taken}. Rien n’a été ajouté.`
          : `${error.message} Rien n’a été ajouté.`,
      }
    }
    throw error
  }

  revalidatePath(`/reservations/${bookingId}`)
  revalidatePath('/reservations', 'layout')
  revalidatePath('/devis', 'layout')
  revalidatePath('/demandes')
  const count = added.length
  return {
    done: `${count} appareil${count > 1 ? 's' : ''} ajouté${count > 1 ? 's' : ''} en option.${proposalNotices[proposal]}`,
  }
}
