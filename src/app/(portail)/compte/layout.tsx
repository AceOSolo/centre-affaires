import { requireClientAccount } from '../../../modules/clients/session.ts'
import { SignOutButton } from '../../(auth)/sign-out-button.tsx'
import { CompteNav } from './compte-nav.tsx'

export const metadata = { title: 'Espace client' }

/**
 * Espace client, dans la coque du site public (ADR 015).
 *
 * Premier verrou : sans compte rattaché à une entreprise, on ne rend rien. Les
 * pages, les routes et les actions revérifient chacune de leur côté — elles ne
 * passent pas toutes par cette coque (ADR 008).
 */
export default async function CompteLayout({ children }: { children: React.ReactNode }) {
  const { user, accounts } = await requireClientAccount()

  return (
    <div className="mx-auto w-full max-w-[1200px] px-5 py-8 sm:px-8 sm:py-12">
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-border bg-muted px-4 py-3 sm:px-5">
        <div className="min-w-0 text-sm">
          <p className="font-medium text-primary">
            Espace client — {accounts.map((account) => account.clientName).join(', ')}
          </p>
          <p className="truncate text-muted-foreground">Connecté avec {user.email}</p>
        </div>
        <SignOutButton className="inline-flex min-h-11 items-center rounded-md border border-border bg-white px-4 text-sm font-medium text-foreground transition-colors hover:bg-background disabled:opacity-60" />
      </div>
      <div className="mt-6">
        <CompteNav />
      </div>
      <div className="mt-8">{children}</div>
    </div>
  )
}
