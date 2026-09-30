import Image from 'next/image'
import Link from 'next/link'

import { requireStaff } from '../../lib/auth/staff.ts'
import { currentTenant } from '../../lib/tenant.ts'
import { countOpeningRequests } from '../../modules/courrier/queries.ts'
import { listPendingBookings } from '../../modules/reservations/queries.ts'
import { SignOutButton } from '../(auth)/sign-out-button.tsx'
import { Nav } from './nav.tsx'

/**
 * Rien n'est prérendu au build dans le back-office.
 *
 * Sans cette ligne, une page sans `searchParams` est figée à la compilation :
 * elle interroge la base au build et sert ensuite un instantané. Les écrans
 * d'administration montrent des données qui changent en dehors de l'application
 * — un import, une reprise manuelle — et le jour du multi-centres un
 * instantané serait de toute façon celui du mauvais centre.
 */
export const dynamic = 'force-dynamic'

/**
 * Coque du back-office. Les six domaines viendront s'ajouter à la navigation au
 * fil des tranches ; seuls ceux qui ont un écran y figurent.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // Premier verrou du back-office : sans membre d'équipe, on ne rend rien.
  // Les actions serveur rappellent `requireStaff()` de leur côté — elles ne
  // passent pas par cette coque (ADR 008).
  const { member } = await requireStaff()
  const [tenant, pending, mailRequests] = await Promise.all([
    currentTenant(),
    listPendingBookings(),
    countOpeningRequests(),
  ])

  return (
    <div className="flex min-h-screen flex-col bg-muted font-sans text-foreground">
      <header className="border-b border-border bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-6 py-3">
          <Link href="/reservations" className="flex items-center">
            {tenant.logoPath ? (
              <Image
                src={tenant.logoPath}
                alt={tenant.name}
                width={600}
                height={191}
                priority
                className="h-7 w-auto"
              />
            ) : (
              <span className="text-sm font-semibold tracking-tight">{tenant.name}</span>
            )}
          </Link>
          <Nav pendingCount={pending.length} mailRequestCount={mailRequests} />
          <div className="ml-auto flex items-center gap-4">
            <span className="hidden text-xs text-muted-foreground sm:block">
              {/* Le fuseau est affiché : toutes les heures de l'écran sont les
                  siennes, alors que la base est en UTC (décision 4). */}
              Heures affichées en {tenant.timezone}
            </span>
            <span className="text-xs text-muted-foreground">
              {member.fullName ?? member.email}
            </span>
            <SignOutButton className="rounded-md border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted" />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">{children}</main>
    </div>
  )
}
