import Link from 'next/link'

import { withTenant } from '../../../db/index.ts'
import { staffRoleLabels } from '../../../db/staff.ts'
import { formatCalendarDate, toIsoDate, todayIsoDate } from '../../../lib/dates.ts'
import { requirePermission } from '../../../lib/auth/staff.ts'
import { currentTenantId, currentTimeZone } from '../../../lib/tenant.ts'
import { AccountsTable, type AccountTableRow } from '../../../modules/comptes/accounts-table.tsx'
import {
  ACCOUNT_LIST_LIMIT,
  listAccounts,
  type AccountStateFilter,
} from '../../../modules/comptes/comptes.ts'
import { accountStateLabel } from '../../../modules/comptes/regles.ts'

export const metadata = { title: 'Comptes' }

const stateFilters: { value: AccountStateFilter; label: string }[] = [
  { value: 'actif', label: 'Actifs' },
  { value: 'banni', label: 'Bannis' },
]

/**
 * Comptes créés sur le site (ADR 045) : inscriptions libres, clients invités,
 * équipe. L'exploitant y bannit, réactive, et rattache un compte à une
 * entreprise existante.
 */
export default async function ComptesPage({
  searchParams,
}: {
  searchParams: Promise<{ etat?: string; q?: string }>
}) {
  const { user } = await requirePermission('comptes.gerer')
  const { etat, q } = await searchParams
  const state = stateFilters.some((filter) => filter.value === etat)
    ? (etat as AccountStateFilter)
    : undefined
  const search = q?.trim() ?? ''
  const timeZone = await currentTimeZone()
  const { rows, truncated } = await withTenant(currentTenantId(), (tx) =>
    listAccounts(tx, { search, state }),
  )

  const tableRows: AccountTableRow[] = rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    emailVerified: row.emailVerified,
    createdOn: formatCalendarDate(toIsoDate(row.createdAt, timeZone)),
    staffRole: row.staffRole ? staffRoleLabels[row.staffRole] : null,
    companies: row.companies.map((company) => ({
      clientId: company.clientId,
      clientName: company.clientName,
      online: company.origin === 'inscription',
    })),
    banned: row.state.kind === 'banni',
    stateLabel: accountStateLabel(row.state, timeZone),
    locked:
      row.id === user.id
        ? 'Votre propre compte'
        : row.staffRole
          ? 'Membre de l’équipe : se gère depuis l’écran Équipe'
          : null,
  }))

  const filterHref = (value?: AccountStateFilter) => {
    const query = new URLSearchParams()
    if (value) query.set('etat', value)
    if (search) query.set('q', search)
    const encoded = query.toString()
    return encoded ? `/comptes?${encoded}` : '/comptes'
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Comptes</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Toute personne peut créer son compte sur le site. Une fois son adresse confirmée, elle
          reçoit sa propre fiche client, « inscrite en ligne », et n’y voit que ce qui la concerne.
          Ici, vous bannissez un compte, le réactivez, ou le rattachez à une entreprise existante.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <nav aria-label="Filtrer par état" className="flex flex-wrap items-center gap-2">
          <FilterLink href={filterHref()} label="Tous" active={!state} />
          {stateFilters.map((filter) => (
            <FilterLink
              key={filter.value}
              href={filterHref(filter.value)}
              label={filter.label}
              active={state === filter.value}
            />
          ))}
        </nav>
        <form role="search" className="ml-auto flex flex-wrap items-end gap-2">
          {state && <input type="hidden" name="etat" value={state} />}
          <div>
            <label htmlFor="q" className="block text-xs font-medium text-foreground">
              Rechercher
            </label>
            <input
              id="q"
              name="q"
              type="search"
              defaultValue={search}
              aria-describedby="q-hint"
              className="mt-1 w-64 rounded-sm border border-border bg-white px-3 py-1.5 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/40"
            />
          </div>
          <button
            type="submit"
            className="rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted"
          >
            Rechercher
          </button>
          <p id="q-hint" className="basis-full text-right text-xs text-muted-foreground">
            Nom ou adresse électronique.
          </p>
        </form>
      </div>

      {(search || state) && (
        <p role="status" className="-mt-2 text-sm text-muted-foreground">
          {rows.length === 0
            ? 'Aucun compte trouvé'
            : `${rows.length} compte${rows.length > 1 ? 's' : ''} trouvé${rows.length > 1 ? 's' : ''}`}
          {search && <> pour « {search} »</>}.{' '}
          <Link href="/comptes" className="text-primary underline underline-offset-2">
            Tout afficher
          </Link>
        </p>
      )}

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-white px-6 py-12 text-center">
          <p className="text-sm text-muted-foreground">
            {search || state
              ? 'Aucun compte ne correspond. Vérifiez l’orthographe de l’adresse, ou affichez tous les comptes.'
              : 'Aucun compte pour l’instant. Les personnes créent le leur depuis la page de connexion du site.'}
          </p>
        </div>
      ) : (
        <>
          <AccountsTable rows={tableRows} today={todayIsoDate(timeZone)} />
          {truncated && (
            <p className="text-sm text-muted-foreground">
              Seuls les {ACCOUNT_LIST_LIMIT} comptes les plus récents sont affichés : affinez avec la
              recherche.
            </p>
          )}
        </>
      )}
    </div>
  )
}

function FilterLink({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={`rounded-full border px-3 py-1 text-xs font-medium ${
        active ? 'border-primary bg-primary text-white' : 'border-border text-muted-foreground hover:border-border'
      }`}
    >
      {label}
    </Link>
  )
}
