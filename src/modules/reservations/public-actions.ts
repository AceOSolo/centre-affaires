'use server'

import { revalidatePath } from 'next/cache'

import { formatLongDate, formatTime, toIsoDate, wallClockToUtc } from '../../lib/dates.ts'
import { currentTimeZone } from '../../lib/tenant.ts'
import { findResource } from '../ressources/queries.ts'
import {
  BookingConflictError,
  InvalidRangeError,
  countRecentRequestsByEmail,
  createBookingRequest,
} from './queries.ts'
import { RATE_WINDOW_HOURS, rejectRequest, rejectionMessages } from './requests.ts'

/**
 * Dépôt d'une demande depuis la page publique (ADR 005).
 *
 * Seul point d'écriture ouvert à tous : rien de ce qui arrive ici n'a été
 * filtré en amont, et le message renvoyé ne doit jamais révéler autre chose que
 * ce que le visiteur peut déjà voir sur la page.
 */
export type PublicFormState =
  | { status: 'idle' }
  | { status: 'error'; message: string }
  | { status: 'sent'; summary: string }

function text(formData: FormData, key: string): string {
  return String(formData.get(key) ?? '').trim()
}

export async function requestBookingAction(
  _previous: PublicFormState,
  formData: FormData,
): Promise<PublicFormState> {
  const timeZone = await currentTimeZone()

  const resourceId = text(formData, 'resourceId')
  const date = text(formData, 'date')
  const email = text(formData, 'email')

  let startsAt: Date
  let endsAt: Date
  try {
    startsAt = wallClockToUtc(`${date}T${text(formData, 'startTime')}`, timeZone)
    endsAt = wallClockToUtc(`${date}T${text(formData, 'endTime')}`, timeZone)
  } catch {
    return { status: 'error', message: rejectionMessages['creneau-illisible'] }
  }

  // La ressource est relue en base : l'identifiant vient d'un `<select>` que
  // n'importe qui peut réécrire avant l'envoi.
  const resource = resourceId ? await findResource(resourceId) : undefined
  const bookable = Boolean(resource && resource.status === 'active' && !resource.deletedAt)

  // Le quota n'est interrogé que si l'adresse est exploitable, pour ne pas
  // lancer une requête par soumission vide.
  const recentRequestCount =
    bookable && email ? await countRecentRequestsByEmail(email, RATE_WINDOW_HOURS) : 0

  const rejection = rejectRequest({
    name: text(formData, 'name'),
    email,
    phone: text(formData, 'phone'),
    title: text(formData, 'title'),
    range: { startsAt, endsAt },
    resourceIsBookable: bookable,
    recentRequestCount,
  })
  if (rejection) return { status: 'error', message: rejectionMessages[rejection] }

  try {
    await createBookingRequest({
      resourceId,
      startsAt,
      endsAt,
      title: text(formData, 'title'),
      notes: text(formData, 'notes') || null,
      requesterName: text(formData, 'name'),
      requesterEmail: email,
      requesterPhone: text(formData, 'phone'),
    })
  } catch (error) {
    if (error instanceof InvalidRangeError) {
      return { status: 'error', message: rejectionMessages['duree-trop-courte'] }
    }
    if (error instanceof BookingConflictError) {
      // Le détail des réservations en conflit reste au staff : un visiteur n'a
      // pas à savoir qui occupe la salle. La page affiche déjà les créneaux
      // libres, il suffit de l'y renvoyer.
      return {
        status: 'error',
        message: 'Ce créneau vient d’être pris. Choisissez-en un autre parmi les créneaux libres.',
      }
    }
    throw error
  }

  // Le planning du staff doit montrer la demande sans attendre.
  revalidatePath('/reservations')
  revalidatePath('/demandes')

  const jour = formatLongDate(toIsoDate(startsAt, timeZone), timeZone)
  return {
    status: 'sent',
    summary: `${resource?.name} — ${jour} de ${formatTime(startsAt, timeZone)} à ${formatTime(endsAt, timeZone)}`,
  }
}
