import Link from 'next/link'

import { currentTenant } from '../../lib/tenant.ts'
import { listPendingBookings } from '../../modules/reservations/queries.ts'
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
  const [tenant, pending] = await Promise.all([currentTenant(), listPendingBookings()])

  return (
    <div className="flex min-h-screen flex-col bg-muted font-sans text-foreground">
      <header className="border-b border-border bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-6 py-3">
          <Link href="/reservations" className="text-sm font-semibold tracking-tight">
            {tenant.name}
          </Link>
          <Nav pendingCount={pending.length} />
          <span className="ml-auto text-xs text-muted-foreground">
            {/* Le fuseau est affiché : toutes les heures de l'écran sont les
                siennes, alors que la base est en UTC (décision 4). */}
            Heures affichées en {tenant.timezone}
          </span>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">{children}</main>
    </div>
  )
}
