'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { requireStaff } from '../../lib/auth/staff.ts'

import { formatTime, toIsoDate, wallClockToUtc } from '../../lib/dates.ts'
import { currentTimeZone } from '../../lib/tenant.ts'
import { isUuid } from '../../lib/uuid.ts'
import {
  BookingConflictError,
  BookingNotMovableError,
  InvalidRangeError,
  assignBookingClient,
  cancelBooking,
  confirmBooking,
  createBooking,
  moveBooking,
  refuseBooking,
} from './queries.ts'

export type FormState = { error?: string } | null

function text(formData: FormData, key: string): string {
  return String(formData.get(key) ?? '').trim()
}

/**
 * Message rendu au staff pour les erreurs métier d'une réservation.
 *
 * Partagé par la création et le déplacement : les deux se heurtent à la même
 * contrainte d'exclusion et doivent nommer le créneau qui bloque de la même
 * façon. `undefined` signale une erreur qui n'est pas de ce ressort et qui doit
 * remonter.
 */
function describeBookingError(error: unknown, timeZone: string): string | undefined {
  if (error instanceof InvalidRangeError) return error.message
  if (error instanceof BookingNotMovableError) return error.message
  if (error instanceof BookingConflictError) {
    const occupied = error.conflicts
      .map(
        (conflict) =>
          `« ${conflict.title} » de ${formatTime(conflict.startsAt, timeZone)} à ${formatTime(conflict.endsAt, timeZone)}`,
      )
      .join(', ')
    return occupied ? `Créneau déjà pris sur cette ressource : ${occupied}.` : error.message
  }
  return undefined
}

export async function createBookingAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  // Contrôle d'accès dans l'action elle-même : une action serveur s'invoque
  // par son identifiant depuis n'importe quel chemin, le filtre de routes ne
  // la protège pas (ADR 008).
  await requireStaff()
  const timeZone = await currentTimeZone()
  const resourceId = text(formData, 'resourceId')
  const date = text(formData, 'date')
  const title = text(formData, 'title')

  if (!resourceId) return { error: 'Choisir une ressource.' }
  if (!title) return { error: "Indiquer l'objet de la réservation." }

  let startsAt: Date
  let endsAt: Date
  try {
    // Le staff saisit une date et deux heures murales ; la base reçoit deux
    // instants UTC (décision 4).
    startsAt = wallClockToUtc(`${date}T${text(formData, 'startTime')}`, timeZone)
    endsAt = wallClockToUtc(`${date}T${text(formData, 'endTime')}`, timeZone)
  } catch {
    return { error: 'Date ou horaires illisibles.' }
  }

  try {
    await createBooking({
      resourceId,
      startsAt,
      endsAt,
      title,
      notes: text(formData, 'notes') || null,
      // Facultatif : la réservation apparaît alors dans l'espace du client.
      clientId: isUuid(text(formData, 'clientId')) ? text(formData, 'clientId') : null,
    })
  } catch (error) {
    const message = describeBookingError(error, timeZone)
    if (message) return { error: message }
    throw error
  }

  const day = toIsoDate(startsAt, timeZone)
  revalidatePath('/reservations', 'layout')
  revalidatePath('/')
  redirect(`/reservations?date=${day}`)
}

/**
 * Déplacement d'une réservation existante.
 *
 * Même contrôle d'accès et même traduction des erreurs que la création : une
 * action serveur s'invoque par son identifiant depuis n'importe quel chemin
 * (ADR 008).
 */
export async function moveBookingAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  await requireStaff()
  const timeZone = await currentTimeZone()
  const id = text(formData, 'id')
  const resourceId = text(formData, 'resourceId')
  const date = text(formData, 'date')

  if (!id) return { error: 'Réservation inconnue.' }
  if (!resourceId) return { error: 'Choisir une ressource.' }

  let startsAt: Date
  let endsAt: Date
  try {
    startsAt = wallClockToUtc(`${date}T${text(formData, 'startTime')}`, timeZone)
    endsAt = wallClockToUtc(`${date}T${text(formData, 'endTime')}`, timeZone)
  } catch {
    return { error: 'Date ou horaires illisibles.' }
  }

  try {
    await moveBooking({ id, resourceId, startsAt, endsAt })
  } catch (error) {
    const message = describeBookingError(error, timeZone)
    if (message) return { error: message }
    throw error
  }

  revalidatePath('/reservations', 'layout')
  revalidatePath('/')
  revalidatePath(`/reservations/${id}`)
  redirect(`/reservations/${id}`)
}

export async function cancelBookingAction(formData: FormData): Promise<void> {
  await requireStaff()
  const id = text(formData, 'id')
  if (!id) return
  await cancelBooking(id, text(formData, 'reason') || null)
  revalidatePath('/')
  // Portée `layout` : le planning et la fiche de la réservation doivent tous
  // deux repartir de la base, pas du cache de rendu.
  revalidatePath('/reservations', 'layout')
}

/**
 * Validation d'une demande publique (ADR 005). Le créneau était bloqué depuis
 * le dépôt : confirmer ne peut pas échouer sur un conflit.
 */
export async function confirmBookingAction(formData: FormData): Promise<void> {
  await requireStaff()
  const id = text(formData, 'id')
  if (!id) return
  await confirmBooking(id)
  revalidatePath('/demandes')
  revalidatePath('/reservations', 'layout')
}

/** Refus d'une demande : annulation motivée, le créneau redevient libre. */
export async function refuseBookingAction(formData: FormData): Promise<void> {
  await requireStaff()
  const id = text(formData, 'id')
  if (!id) return
  await refuseBooking(id, text(formData, 'reason') || null)
  revalidatePath('/')
  revalidatePath('/demandes')
  revalidatePath('/reservations', 'layout')
}

/**
 * Rattache une réservation à un client, ou l'en détache (ADR 015) : c'est ce
 * qui la fait apparaître dans son espace. Utile pour une demande déposée par
 * une personne qui gère plusieurs entreprises, et pour l'historique d'avant
 * l'espace client.
 */
export async function assignBookingClientAction(formData: FormData): Promise<void> {
  await requireStaff()
  const id = text(formData, 'id')
  if (!isUuid(id)) return
  const clientId = text(formData, 'clientId')
  await assignBookingClient(id, isUuid(clientId) ? clientId : null)
  revalidatePath(`/reservations/${id}`)
  revalidatePath('/compte/reservations')
}
