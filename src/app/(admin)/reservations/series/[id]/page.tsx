import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requirePermission } from '../../../../../lib/auth/staff.ts'
import { formatLongDate, formatTime, toIsoDate } from '../../../../../lib/dates.ts'
import { currentTimeZone } from '../../../../../lib/tenant.ts'
import { cancelBookingSeriesAction } from '../../../../../modules/reservations/bulk-actions.ts'
import { listBookingSeries } from '../../../../../modules/reservations/bulk-queries.ts'
import { bookingStatusLabels } from '../../../../../modules/reservations/labels.ts'

export const metadata = { title: 'Série de réservations' }

export default async function BookingSeriesPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission('reservations.gerer')
  const { id } = await params
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) notFound()
  const [bookings, timeZone] = await Promise.all([listBookingSeries(id), currentTimeZone()])
  if (!bookings.length) notFound()
  const now = new Date()
  const future = bookings.filter((booking) => booking.status !== 'cancelled' && booking.startsAt > now)
  return <div className="flex flex-col gap-6">
    <div>
      <Link href="/reservations" className="text-sm text-muted-foreground hover:underline">← Planning</Link>
      <h1 className="mt-2 text-2xl font-semibold">{bookings[0].title}</h1>
      <p className="mt-1 text-sm text-muted-foreground">Série enregistrée · {bookings.length} occurrences · {future.length} à venir</p>
    </div>
    <div className="overflow-x-auto rounded-lg border border-border bg-white">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-border"><tr><th className="p-3">Date</th><th className="p-3">Horaires</th><th className="p-3">Ressource</th><th className="p-3">État</th><th className="p-3"><span className="sr-only">Actions</span></th></tr></thead>
        <tbody className="divide-y divide-border">{bookings.map((booking) => <tr key={booking.id}>
          <td className="p-3 capitalize">{formatLongDate(toIsoDate(booking.startsAt, timeZone), timeZone)}</td>
          <td className="whitespace-nowrap p-3">{formatTime(booking.startsAt, timeZone)} – {formatTime(booking.endsAt, timeZone)}</td>
          <td className="p-3">{booking.resource.name}</td><td className="p-3">{bookingStatusLabels[booking.status]}</td>
          <td className="p-3"><Link href={`/reservations/${booking.id}`} className="text-primary underline underline-offset-2">Consulter</Link></td>
        </tr>)}</tbody>
      </table>
    </div>
    {future.length > 0 && <form action={cancelBookingSeriesAction} className="rounded-lg border border-border bg-white p-5">
      <input type="hidden" name="seriesId" value={id} />
      <p className="mb-3 text-sm text-muted-foreground">Libère toutes les occurrences qui n’ont pas encore commencé. Les occurrences passées ou en cours sont conservées.</p>
      <button className="rounded-md border border-destructive/30 px-4 py-2 text-sm text-destructive hover:bg-destructive/5">Annuler les {future.length} occurrences à venir</button>
    </form>}
  </div>
}
