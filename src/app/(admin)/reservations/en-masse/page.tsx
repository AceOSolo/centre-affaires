import Link from 'next/link'
import { requireStaff } from '../../../../lib/auth/staff.ts'
import { todayIsoDate } from '../../../../lib/dates.ts'
import { currentTimeZone } from '../../../../lib/tenant.ts'
import { BulkBookingForm } from '../../../../modules/reservations/bulk-form.tsx'
import { listBookableResources } from '../../../../modules/ressources/queries.ts'

export const metadata = { title: 'Réservations en masse' }

export default async function BulkBookingPage({ searchParams }: { searchParams: Promise<{ type?: string }> }) {
  await requireStaff()
  const [timeZone, resources, params] = await Promise.all([currentTimeZone(), listBookableResources(), searchParams])
  return <div className="mx-auto flex max-w-3xl flex-col gap-6">
    <div>
      <Link href="/reservations" className="text-sm text-muted-foreground hover:underline">← Planning</Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Réservations en masse</h1>
      <p className="mt-2 text-sm text-muted-foreground">Réservez des créneaux réguliers ou bloquez des indisponibilités récurrentes sur une période. Chaque occurrence reste modifiable depuis le planning.</p>
    </div>
    <BulkBookingForm resources={resources.map(({ id, name, code }) => ({ id, name, code }))} today={todayIsoDate(timeZone)} timeZone={timeZone} defaultKind={params.type === 'indisponibilite' ? 'unavailability' : 'booking'} />
  </div>
}
