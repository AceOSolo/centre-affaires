import Link from 'next/link'
import { notFound } from 'next/navigation'

import { addDaysToIsoDate, formatTime, todayIsoDate, toIsoDate } from '../../../../../lib/dates.ts'
import { currentTimeZone } from '../../../../../lib/tenant.ts'
import { occupiesResource } from '../../../../../modules/reservations/availability.ts'
import { loadWeekCalendar } from '../../../../../modules/reservations/calendar-data.ts'
import { MoveForm } from '../../../../../modules/reservations/move-form.tsx'
import { findBooking, listBookingsBetween } from '../../../../../modules/reservations/queries.ts'
import { weekDays, weekStart } from '../../../../../modules/reservations/semaine.ts'
import { resourceTypeLabels } from '../../../../../modules/ressources/labels.ts'
import { listBookableResources } from '../../../../../modules/ressources/queries.ts'

export const metadata = { title: 'Déplacer la réservation' }

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Déplacement d'une réservation.
 *
 * La ressource affichée par le calendrier vient de l'URL et vaut par défaut
 * celle de la réservation : déplacer dans une autre salle est le cas le plus
 * courant après « une heure plus tard ».
 */
export default async function MoveBookingPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ date?: string; resourceId?: string }>
}) {
  const { id } = await params
  const { date, resourceId } = await searchParams
  const timeZone = await currentTimeZone()

  const booking = await findBooking(id)
  if (!booking) notFound()

  const origineIso = toIsoDate(booking.startsAt, timeZone)
  const today = todayIsoDate(timeZone)

  // Une réservation annulée ne se déplace pas : son créneau est libéré et sa
  // ligne ne subsiste que pour l'historique (décision 6).
  if (booking.status === 'cancelled') {
    return (
      <div className="flex flex-col gap-6">
        <Link href={`/reservations/${id}`} className="text-sm text-muted-foreground hover:underline">
          ← Réservation
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Déplacer la réservation</h1>
        <p className="rounded-lg border border-dashed border-border bg-white px-6 py-12 text-center text-sm text-muted-foreground">
          Cette réservation est annulée : son créneau est libre et elle ne peut plus être
          déplacée. Créez-en une nouvelle si le client revient.
        </p>
      </div>
    )
  }

  const resources = await listBookableResources()
  const resource =
    resources.find((candidate) => candidate.id === resourceId) ??
    resources.find((candidate) => candidate.id === booking.resourceId) ??
    booking.resource

  const anchor = date && ISO_DATE.test(date) ? date : origineIso
  const jours = weekDays(anchor)

  const [days, bookings] = await Promise.all([
    loadWeekCalendar({
      resourceId: resource.id,
      anchor,
      timeZone,
      excludeBookingId: booking.id,
    }),
    listBookingsBetween(jours[0], jours[6], timeZone),
  ])

  const busy = bookings
    .filter(
      (autre) =>
        autre.resourceId === resource.id &&
        autre.id !== booking.id &&
        occupiesResource(autre.status),
    )
    .map((autre) => ({
      id: autre.id,
      title: autre.title,
      startsAt: autre.startsAt,
      endsAt: autre.endsAt,
    }))

  const lundi = weekStart(anchor)

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href={`/reservations/${id}`} className="text-sm text-muted-foreground hover:underline">
          ← Réservation
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Déplacer la réservation</h1>
        <p className="mt-1 text-sm text-muted-foreground">« {booking.title} »</p>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-4">
        <form className="flex flex-wrap items-end gap-2">
          <div>
            <label htmlFor="resourceId" className="block text-xs text-muted-foreground">
              Ressource
            </label>
            <select
              id="resourceId"
              name="resourceId"
              defaultValue={resource.id}
              className="mt-1 rounded-sm border border-border bg-white px-2 py-1.5 text-sm"
            >
              {resources.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.code} — {candidate.name} (
                  {resourceTypeLabels[candidate.resourceType]})
                </option>
              ))}
            </select>
          </div>
          <input type="hidden" name="date" value={anchor} />
          <button
            type="submit"
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
          >
            Afficher
          </button>
        </form>

        <nav aria-label="Semaine" className="flex items-center gap-2">
          <SemaineLink
            id={id}
            date={addDaysToIsoDate(lundi, -7)}
            resourceId={resource.id}
            label="← Semaine précédente"
          />
          <SemaineLink
            id={id}
            date={origineIso}
            resourceId={resource.id}
            label="Semaine d’origine"
            active={weekStart(origineIso) === lundi}
          />
          <SemaineLink
            id={id}
            date={addDaysToIsoDate(lundi, 7)}
            resourceId={resource.id}
            label="Semaine suivante →"
          />
        </nav>
      </div>

      <MoveForm
        bookingId={booking.id}
        resource={resource}
        days={days}
        busy={busy}
        timeZone={timeZone}
        today={today}
        origin={{
          resourceId: booking.resourceId,
          resourceName: booking.resource.name,
          label: `${formatTime(booking.startsAt, timeZone)} – ${formatTime(booking.endsAt, timeZone)} le ${origineIso.slice(8, 10)}/${origineIso.slice(5, 7)}`,
        }}
        defaultDate={origineIso}
        defaultStartTime={formatTime(booking.startsAt, timeZone)}
        defaultEndTime={formatTime(booking.endsAt, timeZone)}
      />
    </div>
  )
}

function SemaineLink({
  id,
  date,
  resourceId,
  label,
  active,
}: {
  id: string
  date: string
  resourceId: string
  label: string
  active?: boolean
}) {
  return (
    <Link
      href={`/reservations/${id}/modifier?date=${date}&resourceId=${resourceId}`}
      aria-current={active ? 'date' : undefined}
      className={`rounded-md border px-3 py-1.5 text-sm ${
        active
          ? 'border-primary bg-primary text-white'
          : 'border-border text-muted-foreground hover:bg-muted'
      }`}
    >
      {label}
    </Link>
  )
}
