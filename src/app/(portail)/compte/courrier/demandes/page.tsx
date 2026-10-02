import Link from 'next/link'

import { FlashNotice } from '../../../../../components/ui/flash-notice.tsx'
import { currentTenant } from '../../../../../lib/tenant.ts'
import { requireClientAccount } from '../../../../../modules/clients/session.ts'
import { ClientRequestCard } from '../../../../../modules/courrier/demande-carte.tsx'
import { listRequestsForAccounts } from '../../../../../modules/courrier/demandes-queries.ts'
import {
  pageCount,
  readRequestFilters,
  REQUEST_PAGE_SIZE,
  requestFiltersQuery,
  requestKindSlugs,
  requestStateFilters,
  type RequestKindSlug,
  type RequestStateFilter,
} from '../../../../../modules/courrier/demandes-regles.ts'
import { mailRequestKindLabels } from '../../../../../modules/courrier/labels.ts'

export const metadata = { title: 'Mes demandes de courrier' }

/** Vu du client : les états qu'il suit. */
const stateLabels: Partial<Record<RequestStateFilter, string>> = {
  toutes: 'Toutes',
  'a-traiter': 'En cours',
  faite: 'Faites',
  refusee: 'Refusées',
  annulee: 'Annulées',
}

const fieldClass =
  'mt-1 block min-h-11 w-full rounded-sm border border-border bg-white px-3 py-2 text-base outline-none focus:border-accent focus:ring-2 focus:ring-accent/40 sm:text-sm'

/**
 * Historique des demandes de courrier de l'entreprise (R21, R24) : chacune
 * avec son état et ses dates, y compris celles annulées ou refusées — une
 * annulation ne l'efface plus (ADR 037).
 */
export default async function MesDemandesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { accounts } = await requireClientAccount()
  const params = await searchParams
  const filters = readRequestFilters(params, 'toutes')
  // Côté client, « en cours » réunit déposée et prise en charge.
  const state = stateLabels[filters.state] ? filters.state : 'toutes'
  const statuses = requestStateFilters[state]
  const [tenant, result] = await Promise.all([
    currentTenant(),
    listRequestsForAccounts(
      accounts,
      { statuses, kind: filters.kind },
      { number: filters.page, size: REQUEST_PAGE_SIZE },
    ),
  ])
  const pages = pageCount(result.total, REQUEST_PAGE_SIZE)
  const fait = typeof params.fait === 'string' ? params.fait : undefined
  const query = (page: number) => requestFiltersQuery({ state, kindSlug: filters.kindSlug }, page)

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div>
        <Link
          href="/compte/courrier"
          className="inline-flex min-h-11 items-center text-sm text-muted-foreground underline-offset-2 hover:underline"
        >
          ← Ma boîte aux lettres
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-primary sm:text-3xl">
          Mes demandes de courrier
        </h1>
        <p className="mt-2 max-w-prose text-muted-foreground">
          Ouvertures, numérisations et réexpéditions demandées au centre, avec leur état et leurs
          dates. Une demande s’annule tant que le centre ne l’a pas prise en charge.
        </p>
      </div>

      {fait === 'annulation' && (
        <FlashNotice key={fait}>Demande annulée. Elle reste dans votre historique, à votre nom.</FlashNotice>
      )}

      <form className="grid gap-3 rounded-lg border border-border bg-muted p-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end" aria-label="Filtrer les demandes">
        <div>
          <label htmlFor="etat" className="block text-sm font-medium">
            État
          </label>
          <select id="etat" name="etat" defaultValue={state} className={fieldClass}>
            {(Object.keys(stateLabels) as RequestStateFilter[]).map((value) => (
              <option key={value} value={value}>
                {stateLabels[value]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="nature" className="block text-sm font-medium">
            Nature
          </label>
          <select id="nature" name="nature" defaultValue={filters.kindSlug ?? ''} className={fieldClass}>
            <option value="">Toutes</option>
            {(Object.keys(requestKindSlugs) as RequestKindSlug[]).map((slug) => (
              <option key={slug} value={slug}>
                {mailRequestKindLabels[requestKindSlugs[slug]]}
              </option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          className="press inline-flex min-h-11 items-center justify-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
        >
          Filtrer
        </button>
      </form>

      <p className="text-sm text-muted-foreground" aria-live="polite">
        {result.total === 0
          ? 'Aucune demande.'
          : `${result.total} demande${result.total > 1 ? 's' : ''}${pages > 1 ? ` — page ${Math.min(filters.page, pages)} sur ${pages}` : ''}.`}
      </p>

      {result.rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-6 py-12 text-center">
          <p className="text-muted-foreground">
            {state === 'toutes' && !filters.kind
              ? 'Vous n’avez encore rien demandé. Depuis votre boîte aux lettres, demandez l’ouverture, la numérisation ou la réexpédition d’un pli.'
              : 'Aucune demande ne correspond à ces filtres.'}
          </p>
          <Link
            href="/compte/courrier"
            className="mt-4 inline-flex min-h-11 items-center rounded-md border border-border bg-white px-5 text-sm font-medium text-primary hover:bg-muted"
          >
            Voir ma boîte aux lettres
          </Link>
        </div>
      ) : (
        <ul className="flex flex-col gap-4">
          {result.rows.map((request) => (
            <li key={request.id}>
              <ClientRequestCard
                request={request}
                timeZone={tenant.timezone}
                from="demandes"
                showMail
                showClient={accounts.length > 1}
              />
            </li>
          ))}
        </ul>
      )}

      {pages > 1 && (
        <nav aria-label="Pages des demandes" className="flex flex-wrap items-center justify-between gap-2">
          {filters.page > 1 ? (
            <Link
              href={`/compte/courrier/demandes${query(filters.page - 1)}`}
              className="inline-flex min-h-11 items-center rounded-md border border-border bg-white px-4 text-sm font-medium hover:bg-muted"
            >
              ← Plus récentes
            </Link>
          ) : (
            <span />
          )}
          <span className="text-sm text-muted-foreground tabular">
            Page {Math.min(filters.page, pages)} sur {pages}
          </span>
          {filters.page < pages ? (
            <Link
              href={`/compte/courrier/demandes${query(filters.page + 1)}`}
              className="inline-flex min-h-11 items-center rounded-md border border-border bg-white px-4 text-sm font-medium hover:bg-muted"
            >
              Plus anciennes →
            </Link>
          ) : (
            <span />
          )}
        </nav>
      )}
    </div>
  )
}
