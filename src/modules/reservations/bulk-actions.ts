'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { after } from 'next/server'
import { requireStaff } from '../../lib/auth/staff.ts'
import { currentTenantId, currentTimeZone } from '../../lib/tenant.ts'
import { formatTime, toIsoDate } from '../../lib/dates.ts'
import { withTenant } from '../../db/index.ts'
import { syncBookingsToGoogleCalendar, syncSeriesToGoogleCalendar } from './agenda-google-queries.ts'
import { cancelFutureSeries, createBookingSeries } from './bulk-queries.ts'
import { BookingConflictError } from './queries.ts'
import { RecurrenceError, type WeeklySlot } from './recurrence.ts'

export type BulkFormState = { error: string } | null

export async function createBookingSeriesAction(_previous: BulkFormState, formData: FormData): Promise<BulkFormState> {
  await requireStaff()
  const timeZone = await currentTimeZone()
  let slots: WeeklySlot[]
  try { slots = JSON.parse(String(formData.get('slots') ?? '')) } catch {
    return { error: 'Les plages horaires sont illisibles.' }
  }
  const kind = String(formData.get('kind'))
  if (kind !== 'booking' && kind !== 'unavailability') return { error: 'Choisissez le type de lot.' }
  let seriesId: string
  try {
    const result = await createBookingSeries({
      startsOn: String(formData.get('startsOn') ?? ''), endsOn: String(formData.get('endsOn') ?? ''), slots,
      resourceIds: formData.getAll('resourceIds').map(String), kind,
      title: String(formData.get('title') ?? ''), notes: String(formData.get('notes') ?? ''),
    }, timeZone)
    seriesId = result.seriesId
  } catch (error) {
    if (error instanceof RecurrenceError) return { error: error.message }
    if (error instanceof BookingConflictError) {
      const detail = error.conflicts.slice(0, 8).map((booking) =>
        `${toIsoDate(booking.startsAt, timeZone)} de ${formatTime(booking.startsAt, timeZone)} à ${formatTime(booking.endsAt, timeZone)} : « ${booking.title} »`,
      ).join(' ; ')
      return { error: `Aucune réservation créée. ${detail ? `Conflits : ${detail}${error.conflicts.length > 8 ? ` ; et ${error.conflicts.length - 8} autres` : ''}.` : 'Un créneau vient d’être pris. Vérifiez le planning et réessayez.'}` }
    }
    throw error
  }
  // Jusqu'à 500 écritures chez Google, une à une, après la réponse (ADR 014).
  after(() => syncSeriesToGoogleCalendar(seriesId))
  revalidatePath('/reservations', 'layout')
  revalidatePath('/')
  redirect(`/reservations/series/${seriesId}`)
}

export async function cancelBookingSeriesAction(formData: FormData): Promise<void> {
  await requireStaff()
  const seriesId = String(formData.get('seriesId') ?? '')
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seriesId)) return
  const cancelled = await withTenant(currentTenantId(), (tx) => cancelFutureSeries(tx, seriesId))
  after(() => syncBookingsToGoogleCalendar(cancelled.map((booking) => booking.id)))
  revalidatePath('/reservations', 'layout')
  revalidatePath('/')
}
