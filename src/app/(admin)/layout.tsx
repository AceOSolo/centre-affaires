import Image from 'next/image'
import Link from 'next/link'

import { withTenant } from '../../db/index.ts'
import { staffRoleLabels } from '../../db/staff.ts'
import { permissionsOf } from '../../lib/auth/permissions.ts'
import { requireStaff } from '../../lib/auth/staff.ts'
import { currentTenant, currentTenantId } from '../../lib/tenant.ts'
import { staffHasClientSpace } from '../../modules/comptes/espace-equipe.ts'
import { openStaffClientSpaceAction } from '../../modules/comptes/espace-equipe-actions.ts'
import { countPendingMailRequests } from '../../modules/courrier/demandes-queries.ts'
import { listPendingBookings } from '../../modules/reservations/queries.ts'
import { SignOutButton } from '../(auth)/sign-out-button.tsx'
import { MobileMenu } from './mobile-menu.tsx'
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
 * Coque du back-office : barre latérale rangée par catégories sur grand écran,
 * menu dépliant sur écran étroit. La navigation ne montre que les droits du rôle.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // Premier verrou du back-office : sans membre d'équipe, on ne rend rien.
  // Les pages et les actions serveur vérifient le droit de leur rôle par
  // `requirePermission()` — les actions ne passent pas par cette coque
  // (ADR 008, ADR 019).
  const { user, member } = await requireStaff()
  const [tenant, pending, mailRequests, hasClientSpace] = await Promise.all([
    currentTenant(),
    listPendingBookings(),
    // Demandes de courrier à traiter, toutes natures (ADR 037).
    countPendingMailRequests().then((counts) => counts.total),
    withTenant(currentTenantId(), (tx) => staffHasClientSpace(tx, user)),
  ])

  const logo = (
    <Link
      href="/reservations"
      className="flex items-center rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
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
  )

  const nav = (
    <Nav pendingCount={pending.length} mailRequestCount={mailRequests} allowed={permissionsOf(member.role)} />
  )

  const account = (
    <div className="flex flex-col gap-2 text-xs text-muted-foreground">
      <p>
        <span className="block font-medium text-foreground">{member.fullName ?? member.email}</span>
        {staffRoleLabels[member.role]}
      </p>
      {/* Le fuseau est affiché : toutes les heures de l'écran sont les
          siennes, alors que la base est en UTC (décision 4). */}
      <p>Heures affichées en {tenant.timezone}</p>
      {/* Le même compte peut aussi être client du centre. Un formulaire et non
          un lien : la première fois, l'action crée la fiche. */}
      <form action={openStaffClientSpaceAction}>
        <button
          type="submit"
          className="font-medium text-primary underline-offset-2 transition-colors duration-150 ease-out hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {hasClientSpace ? 'Mon espace client' : 'Créer mon espace client'}
        </button>
      </form>
      <SignOutButton
        redirectTo="/auth/equipe"
        className="self-start rounded-md border border-border bg-white px-3 py-1.5 text-xs font-medium text-foreground transition-colors duration-150 ease-out hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" />
    </div>
  )

  // Une barre latérale rangée par catégories plutôt qu'une rangée d'onglets :
  // à vingt entrées, la rangée passait sur plusieurs lignes et mangeait la
  // hauteur de chaque écran.
  return (
    <div className="min-h-screen bg-muted font-sans text-foreground lg:flex">
      {/* Vingt liens précèdent le contenu : au clavier, on les saute. */}
      <a
        href="#contenu"
        className="sr-only z-30 rounded-md bg-primary px-4 py-2 text-sm font-medium text-white focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        Aller au contenu
      </a>

      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-border bg-white lg:flex">
        <div className="px-6 pb-4 pt-5">{logo}</div>
        <div className="flex-1 overflow-y-auto px-3 pb-6">{nav}</div>
        <div className="border-t border-border px-6 py-4">{account}</div>
      </aside>

      <header className="relative flex items-center justify-between gap-4 border-b border-border bg-white px-4 py-2 lg:hidden">
        {logo}
        <MobileMenu>
          <div className="flex flex-col gap-6">
            {nav}
            <div className="border-t border-border px-3 pt-4">{account}</div>
          </div>
        </MobileMenu>
      </header>

      <main id="contenu" className="mx-auto w-full min-w-0 max-w-6xl flex-1 px-6 py-8">
        {children}
      </main>
    </div>
  )
}
