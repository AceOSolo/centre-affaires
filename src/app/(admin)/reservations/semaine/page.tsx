import Link from 'next/link'

import { addDaysToIsoDate, formatLongDate, todayIsoDate } from '../../../../lib/dates.ts'
import { currentTimeZone } from '../../../../lib/tenant.ts'
import { listBookingsBetween } from '../../../../modules/reservations/queries.ts'
import { weekColumns, weekDays, weekExtent, weekStart } from '../../../../modules/reservations/semaine.ts'
import { WeekPlanning } from '../../../../modules/reservations/week-planning.tsx'
import { loadOpeningContext } from '../../../../modules/ressources/ouverture-queries.ts'
import { openingWindows, type TimeRange } from '../../../../modules/ressources/ouverture.ts'
import { resourceTypeLabels } from '../../../../modules/ressources/labels.ts'
import { listBookableResources } from '../../../../modules/ressources/queries.ts'

export const metadata = { title: 'Semaine' }

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export default async function WeekPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; ressource?: string }>
}) {
  const { date, ressource } = await searchParams
  const timeZone = await currentTimeZone()
  const today = todayIsoDate(timeZone)
  const anchor = date && ISO_DATE.test(date) ? date : today

  const resources = await listBookableResources()
  const resource = resources.find((candidate) => candidate.id === ressource) ?? resources[0]

  if (!resource) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-2xl font-semibold tracking-tight">Semaine</h1>
        <div className="rounded-lg border border-dashed border-border bg-white px-6 py-12 text-center">
          <p className="text-sm text-muted-foreground">
            Aucune ressource en service : il n’y a pas de semaine à afficher.
          </p>
          <Link
            href="/ressources/nouvelle"
            className="mt-4 inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover"
          >
            Déclarer une ressource
          </Link>
        </div>
      </div>
    )
  }

  const jours = weekDays(anchor)
  const [bookings, contexte] = await Promise.all([
    listBookingsBetween(jours[0], jours[6], timeZone),
    loadOpeningContext(jours[0], jours[6]),
  ])

  // Les horaires sont résolus pour cette ressource : elle peut avoir les siens,
  // et une fermeture exceptionnelle peut ne viser qu'elle.
  const opening: Record<string, TimeRange[]> = Object.fromEntries(
    jours.map((jour) => [
      jour,
      openingWindows(jour, timeZone, {
        rules: contexte.rules,
        closures: contexte.closures,
        resourceId: resource.id,
      }),
    ]),
  )

  const extent = weekExtent(Object.values(opening).flat(), timeZone)
  const columns = weekColumns(anchor, timeZone, extent, opening)
  const lundi = weekStart(anchor)

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Semaine</h1>
          <p className="mt-1 text-sm capitalize text-muted-foreground">
            {formatLongDate(jours[0], timeZone)} → {formatLongDate(jours[6], timeZone)}
          </p>
        </div>
        <Link
          href={`/reservations?date=${anchor}`}
          className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-muted"
        >
          Vue jour
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <NavLink date={addDaysToIsoDate(lundi, -7)} resource={resource.id} label="← Semaine précédente" />
        <NavLink
          date={today}
          resource={resource.id}
          label="Cette semaine"
          active={weekStart(today) === lundi}
        />
        <NavLink date={addDaysToIsoDate(lundi, 7)} resource={resource.id} label="Semaine suivante →" />

        {/* Formulaire GET : le changement de ressource marche sans JavaScript. */}
        <form className="ml-auto flex items-center gap-2">
          <input type="hidden" name="date" value={anchor} />
          <label htmlFor="ressource" className="text-xs text-muted-foreground">
            Ressource
          </label>
          <select
            id="ressource"
            name="ressource"
            defaultValue={resource.id}
            className="rounded-md border border-border bg-white px-2 py-1 text-sm"
          >
            {resources.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.code} — {candidate.name} (
                {resourceTypeLabels[candidate.resourceType]})
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="rounded-md border border-border px-3 py-1 text-sm hover:bg-muted"
          >
            Afficher
          </button>
        </form>
      </div>

      <WeekPlanning
        resource={resource}
        timeZone={timeZone}
        columns={columns}
        bookings={bookings}
        opening={opening}
        today={today}
      />
    </div>
  )
}

function NavLink({
  date,
  resource,
  label,
  active,
}: {
  date: string
  resource: string
  label: string
  active?: boolean
}) {
  return (
    <Link
      href={`/reservations/semaine?date=${date}&ressource=${resource}`}
      aria-current={active ? 'date' : undefined}
      className={`rounded-md border px-3 py-1 text-sm ${
        active
          ? 'border-primary bg-primary text-white'
          : 'border-border text-muted-foreground hover:bg-muted'
      }`}
    >
      {label}
    </Link>
  )
}
