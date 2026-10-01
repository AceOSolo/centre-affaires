import Link from 'next/link'

import { addDaysToIsoDate, todayIsoDate } from '../../../../lib/dates.ts'
import { currentTimeZone } from '../../../../lib/tenant.ts'
import { listClients } from '../../../../modules/clients/queries.ts'
import { listContracts } from '../../../../modules/contrats/queries.ts'
import { occupiesResource } from '../../../../modules/reservations/availability.ts'
import { BookingForm } from '../../../../modules/reservations/booking-form.tsx'
import { loadWeekCalendar } from '../../../../modules/reservations/calendar-data.ts'
import { listBookingsBetween } from '../../../../modules/reservations/queries.ts'
import { weekDays, weekStart } from '../../../../modules/reservations/semaine.ts'
import { resourceTypeLabels } from '../../../../modules/ressources/labels.ts'
import { listBookableResources } from '../../../../modules/ressources/queries.ts'

export const metadata = { title: 'Nouvelle réservation' }

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const WALL_TIME = /^\d{2}:\d{2}$/

/**
 * Les valeurs par défaut viennent de l'endroit d'où l'on clique dans le
 * planning : le jour affiché, la colonne, et l'heure de la bande cliquée.
 *
 * Le calendrier de la semaine est chargé pour la ressource choisie — chacune a
 * son propre emploi du temps. Changer de ressource ou de semaine recharge la
 * page : un formulaire GET marche sans JavaScript et l'URL reste partageable.
 */
export default async function NewBookingPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; resourceId?: string; start?: string }>
}) {
  const { date, resourceId, start } = await searchParams
  const timeZone = await currentTimeZone()
  const today = todayIsoDate(timeZone)
  const resources = await listBookableResources()

  const defaultDate = date && ISO_DATE.test(date) ? date : today
  const resource = resources.find((candidate) => candidate.id === resourceId) ?? resources[0]

  if (!resource) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-2xl font-semibold tracking-tight">Nouvelle réservation</h1>
        <p className="rounded-lg border border-dashed border-border bg-white px-6 py-12 text-center text-sm text-muted-foreground">
          Aucune ressource en service.{' '}
          <Link href="/ressources/nouvelle" className="underline underline-offset-2">
            Déclarer une ressource
          </Link>{' '}
          avant de réserver.
        </p>
      </div>
    )
  }

  const jours = weekDays(defaultDate)
  const [days, bookings, clients, activeContracts] = await Promise.all([
    loadWeekCalendar({ resourceId: resource.id, anchor: defaultDate, timeZone }),
    listBookingsBetween(jours[0], jours[6], timeZone),
    listClients(),
    // Contrats proposés au rattachement (R05) : seuls les actifs le peuvent.
    listContracts({ status: 'active' }),
  ])

  // Le détail des réservations ne sort pas du back-office : le portail public
  // reçoit des cases occupées, jamais un titre ni un nom.
  const busy = bookings
    .filter((booking) => booking.resourceId === resource.id && occupiesResource(booking.status))
    .map((booking) => ({
      id: booking.id,
      title: booking.title,
      kind: booking.kind,
      startsAt: booking.startsAt,
      endsAt: booking.endsAt,
    }))

  const lundi = weekStart(defaultDate)

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href={`/reservations?date=${defaultDate}`}
          className="text-sm text-muted-foreground hover:underline"
        >
          ← Planning
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Nouvelle réservation</h1>
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
          <input type="hidden" name="date" value={defaultDate} />
          {start && WALL_TIME.test(start) && <input type="hidden" name="start" value={start} />}
          <button
            type="submit"
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
          >
            Afficher
          </button>
        </form>

        <nav aria-label="Semaine" className="flex items-center gap-2">
          <SemaineLink
            date={addDaysToIsoDate(lundi, -7)}
            resourceId={resource.id}
            label="← Semaine précédente"
          />
          <SemaineLink
            date={today}
            resourceId={resource.id}
            label="Cette semaine"
            active={weekStart(today) === lundi}
          />
          <SemaineLink
            date={addDaysToIsoDate(lundi, 7)}
            resourceId={resource.id}
            label="Semaine suivante →"
          />
        </nav>
      </div>

      <BookingForm
        resource={resource}
        resources={resources}
        days={days}
        busy={busy}
        timeZone={timeZone}
        today={today}
        defaultDate={defaultDate}
        defaultStartTime={start && WALL_TIME.test(start) ? start : undefined}
        clients={clients.map((client) => ({ id: client.id, name: client.name }))}
        contracts={activeContracts.map((contract) => ({
          id: contract.id,
          reference: contract.reference,
          clientId: contract.clientId,
          status: contract.status,
          deletedAt: contract.deletedAt,
          startsOn: contract.startsOn,
          endsOn: contract.endsOn,
          terminatedOn: contract.terminatedOn,
        }))}
      />
    </div>
  )
}

function SemaineLink({
  date,
  resourceId,
  label,
  active,
}: {
  date: string
  resourceId: string
  label: string
  active?: boolean
}) {
  return (
    <Link
      href={`/reservations/nouvelle?date=${date}&resourceId=${resourceId}`}
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
