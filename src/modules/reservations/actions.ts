'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { formatTime, toIsoDate, wallClockToUtc } from '../../lib/dates.ts'
import { currentTimeZone } from '../../lib/tenant.ts'
import {
  BookingConflictError,
  InvalidRangeError,
  cancelBooking,
  createBooking,
} from './queries.ts'

export type FormState = { error?: string } | null

function text(formData: FormData, key: string): string {
  return String(formData.get(key) ?? '').trim()
}

export async function createBookingAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
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
    })
  } catch (error) {
    if (error instanceof InvalidRangeError) return { error: error.message }
    if (error instanceof BookingConflictError) {
      const occupied = error.conflicts
        .map(
          (conflict) =>
            `« ${conflict.title} » de ${formatTime(conflict.startsAt, timeZone)} à ${formatTime(conflict.endsAt, timeZone)}`,
        )
        .join(', ')
      return {
        error: occupied
          ? `Créneau déjà pris sur cette ressource : ${occupied}.`
          : error.message,
      }
    }
    throw error
  }

  const day = toIsoDate(startsAt, timeZone)
  revalidatePath('/reservations')
  redirect(`/reservations?date=${day}`)
}

export async function cancelBookingAction(formData: FormData): Promise<void> {
  const id = text(formData, 'id')
  if (!id) return
  await cancelBooking(id, text(formData, 'reason') || null)
  // Portée `layout` : le planning et la fiche de la réservation doivent tous
  // deux repartir de la base, pas du cache de rendu.
  revalidatePath('/reservations', 'layout')
}
