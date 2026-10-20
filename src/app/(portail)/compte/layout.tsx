import Link from 'next/link'

import { staffAccess } from '../../../lib/auth/staff.ts'
import { requireClientAccount } from '../../../modules/clients/session.ts'
import { SignOutButton } from '../../(auth)/sign-out-button.tsx'
import { CompteNav } from './compte-nav.tsx'
import { loadClientSpace } from './espace.ts'

export const metadata = { title: 'Espace client' }

const secondaryLink = 'inline-flex min-h-11 items-center rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-primary'

/**
 * Espace client, dans la coque du site public (ADR 015).
 *
 * Premier verrou : sans compte rattaché à une entreprise, on ne rend rien. Les
 * pages, les routes et les actions revérifient chacune de leur côté — elles ne
 * passent pas toutes par cette coque (ADR 008).
 *
 * Les onglets sont ceux que l'entreprise utilise (`clientSections`) ; ce qui
 * se consulte rarement — historique, préférences de notification — passe en
 * liens discrets à côté du compte.
 */
export default async function CompteLayout({ children }: { children: React.ReactNode }) {
  const [{ user, accounts, sections }, staff] = await Promise.all([
    requireClientAccount().then(loadClientSpace),
    // Un membre de l'équipe peut aussi être client : il retrouve le back-office.
    staffAccess(),
  ])

  return (
    <div className="mx-auto w-full max-w-[1200px] px-5 py-8 sm:px-8 sm:py-10">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">Espace client</p>
          <p className="mt-0.5 text-xl font-semibold tracking-tight text-primary">
            {accounts.map((account) => account.clientName).join(', ')}
          </p>
          <p className="mt-0.5 truncate text-sm text-muted-foreground">{user.email}</p>
        </div>
        <div className="-mx-3 flex flex-wrap items-center gap-1 sm:mx-0">
          <Link href="/compte/historique" className={secondaryLink}>Historique</Link>
          <Link href="/compte/preferences" className={secondaryLink}>Préférences</Link>
          {staff.status === 'membre' && (
            <Link href="/reservations" className={secondaryLink}>Back-office</Link>
          )}
          <SignOutButton className="inline-flex min-h-11 items-center rounded-md border border-border bg-white px-4 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-60" />
        </div>
      </div>
      <div className="mt-6">
        <CompteNav sections={sections} />
      </div>
      <div className="mt-8">{children}</div>
    </div>
  )
}
