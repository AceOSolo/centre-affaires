import Link from 'next/link'

import { todayIsoDate } from '../../../../lib/dates.ts'
import { currentTimeZone } from '../../../../lib/tenant.ts'
import { BookingForm } from '../../../../modules/reservations/booking-form.tsx'
import { listBookableResources } from '../../../../modules/ressources/queries.ts'

export const metadata = { title: 'Nouvelle réservation' }

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const WALL_TIME = /^\d{2}:\d{2}$/

/**
 * Les valeurs par défaut viennent de l'endroit d'où l'on clique dans le
 * planning : le jour affiché, la colonne, et l'heure de la bande cliquée.
 */
export default async function NewBookingPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; resourceId?: string; start?: string }>
}) {
  const { date, resourceId, start } = await searchParams
  const timeZone = await currentTimeZone()
  const resources = await listBookableResources()

  const defaultDate = date && ISO_DATE.test(date) ? date : todayIsoDate(timeZone)
  const known = resources.some((resource) => resource.id === resourceId)

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href={`/reservations?date=${defaultDate}`}
          className="text-sm text-zinc-500 hover:underline dark:text-zinc-400"
        >
          ← Planning
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Nouvelle réservation</h1>
      </div>
      <BookingForm
        resources={resources}
        defaultDate={defaultDate}
        defaultResourceId={known ? resourceId : undefined}
        defaultStartTime={start && WALL_TIME.test(start) ? start : undefined}
      />
    </div>
  )
}
