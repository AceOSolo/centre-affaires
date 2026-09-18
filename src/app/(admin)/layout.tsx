import Link from 'next/link'

import { currentTenant } from '../../lib/tenant.ts'
import { Nav } from './nav.tsx'

/**
 * Coque du back-office. Les six domaines viendront s'ajouter à la navigation au
 * fil des tranches ; seuls ceux qui ont un écran y figurent.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const tenant = await currentTenant()

  return (
    <div className="flex min-h-screen flex-col bg-zinc-50 font-sans text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <header className="border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-6 py-3">
          <Link href="/reservations" className="text-sm font-semibold tracking-tight">
            {tenant.name}
          </Link>
          <Nav />
          <span className="ml-auto text-xs text-zinc-500 dark:text-zinc-400">
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
