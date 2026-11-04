import Link from 'next/link'

import { FlashNotice } from '../../../../components/ui/flash-notice.tsx'
import { requirePermission } from '../../../../lib/auth/staff.ts'
import { todayIsoDate } from '../../../../lib/dates.ts'
import { currentTimeZone } from '../../../../lib/tenant.ts'
import { isUuid } from '../../../../lib/uuid.ts'
import { findClient } from '../../../../modules/clients/queries.ts'
import { MailRequestQueue } from '../../../../modules/courrier/demandes-file.tsx'
import { countPendingMailRequests, listMailRequests } from '../../../../modules/courrier/demandes-queries.ts'
import {
  groupStartNotice,
  pageCount,
  readRequestFilters,
  REQUEST_PAGE_SIZE,
  requestFiltersQuery,
  requestKindSlugs,
  requestStateFilterLabels,
  requestStateFilters,
  type RequestKindSlug,
  type RequestStateFilter,
} from '../../../../modules/courrier/demandes-regles.ts'
import { mailRequestKindLabels } from '../../../../modules/courrier/labels.ts'
import { findMailSpots } from '../../../../modules/courrier/queries.ts'

export const metadata = { title: 'Demandes de courrier' }

/**
 * Vue filtrée de « Demandes » sur le courrier (R21, ADR 037, ADR 057) : ce
 * que les domiciliés attendent de l'accueil — ouvertures, numérisations,
 * réexpéditions —, par nature, par état et par client, historique compris.
 * « Demandes » (ADR 048) en montre les demandes à traiter ; ici se lisent
 * aussi celles déjà faites, refusées ou annulées. Pas d'entrée au menu :
 * « Demandes » y reste allumée.
 */
export default async function DemandesCourrierPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requirePermission('courrier.gerer')
  const params = await searchParams
  const filters = readRequestFilters(params)
  const clientParam = typeof params.client === 'string' && isUuid(params.client) ? params.client : undefined

  const [timeZone, result, counts, client] = await Promise.all([
    currentTimeZone(),
    listMailRequests(
      { statuses: filters.statuses, kind: filters.kind, clientId: clientParam },
      { number: filters.page, size: REQUEST_PAGE_SIZE },
    ),
    countPendingMailRequests(),
    clientParam ? findClient(clientParam) : undefined,
  ])
  const spots = await findMailSpots(
    result.rows.map((row) => row.mailItemId),
    timeZone,
  )
  const pages = pageCount(result.total, REQUEST_PAGE_SIZE)
  const notice = groupStartNotice(params)
  const link = (
    change: { state?: RequestStateFilter; kindSlug?: RequestKindSlug | null; clientId?: string },
    page = 1,
  ) =>
    `/courrier/demandes${requestFiltersQuery(
      {
        state: change.state ?? filters.state,
        kindSlug: change.kindSlug === null ? undefined : (change.kindSlug ?? filters.kindSlug),
        clientId: change.clientId ?? clientParam,
      },
      page,
    )}`

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/demandes?produit=domiciliation" className="text-sm text-muted-foreground hover:underline">
          ← Demandes
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Demandes de courrier</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {counts.total === 0
            ? 'Aucune demande à traiter.'
            : `${counts.total} demande${counts.total > 1 ? 's' : ''} à traiter : ${counts.open_and_scan} ouverture${counts.open_and_scan > 1 ? 's' : ''}, ${counts.scan} numérisation${counts.scan > 1 ? 's' : ''}, ${counts.forward} réexpédition${counts.forward > 1 ? 's' : ''}.`}{' '}
          Celles à traiter figurent aussi dans « Demandes » ; ici se retrouvent aussi celles déjà
          traitées. Une réexpédition se fait en dernier : le pli quitte le centre.
        </p>
      </div>

      {notice && <FlashNotice key={notice.done}>{notice.done}</FlashNotice>}
      {notice?.failure && (
        <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {notice.failure}
        </p>
      )}

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="État">
          {(Object.keys(requestStateFilters) as RequestStateFilter[]).map((state) => (
            <FilterLink key={state} href={link({ state })} active={filters.state === state}>
              {requestStateFilterLabels[state]}
            </FilterLink>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Nature">
          <FilterLink href={link({ kindSlug: null })} active={!filters.kindSlug}>
            Toutes natures
          </FilterLink>
          {(Object.keys(requestKindSlugs) as RequestKindSlug[]).map((slug) => (
            <FilterLink key={slug} href={link({ kindSlug: slug })} active={filters.kindSlug === slug}>
              {mailRequestKindLabels[requestKindSlugs[slug]]}
              {counts[requestKindSlugs[slug]] > 0 && (
                <span className="tabular"> ({counts[requestKindSlugs[slug]]} à traiter)</span>
              )}
            </FilterLink>
          ))}
          {client && (
            <span className="ml-2 inline-flex items-center gap-2 rounded-full bg-muted px-3 py-1 text-xs font-medium">
              Client : {client.name}
              <Link
                href={`/courrier/demandes${requestFiltersQuery({ state: filters.state, kindSlug: filters.kindSlug })}`}
                className="text-muted-foreground underline underline-offset-2 hover:text-foreground"
              >
                Tous les clients
              </Link>
            </span>
          )}
        </div>
      </div>

      {result.rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-white px-6 py-12 text-center">
          <p className="text-sm text-muted-foreground">
            {filters.state === 'a-traiter'
              ? 'Aucune demande à traiter : les clients ont tout ce qu’ils ont demandé.'
              : 'Aucune demande ne correspond à ces filtres.'}
          </p>
          <Link href="/courrier" className="mt-4 inline-block text-sm text-muted-foreground underline-offset-2 hover:underline">
            Voir le courrier reçu
          </Link>
        </div>
      ) : (
        <MailRequestQueue
          rows={result.rows}
          spots={spots}
          timeZone={timeZone}
          today={todayIsoDate(timeZone)}
          formId="prise-en-charge-groupee"
          hidden={{
            retour: '/courrier/demandes',
            etat: filters.state,
            nature: filters.kindSlug ?? '',
            page: String(filters.page),
            client: clientParam ?? '',
          }}
          caption={`Demandes de courrier — ${requestStateFilterLabels[filters.state].toLowerCase()}`}
          clientHref={(row) => link({ clientId: row.clientId })}
        />
      )}

      {pages > 1 && (
        <nav aria-label="Pages des demandes" className="flex items-center justify-between gap-2 text-sm">
          {filters.page > 1 ? (
            <Link href={link({}, filters.page - 1)} className="rounded-md border border-border bg-white px-3 py-1.5 hover:bg-muted">
              ← Précédentes
            </Link>
          ) : (
            <span />
          )}
          <span className="text-muted-foreground tabular">
            Page {Math.min(filters.page, pages)} sur {pages} · {result.total} demandes
          </span>
          {filters.page < pages ? (
            <Link href={link({}, filters.page + 1)} className="rounded-md border border-border bg-white px-3 py-1.5 hover:bg-muted">
              Suivantes →
            </Link>
          ) : (
            <span />
          )}
        </nav>
      )}
    </div>
  )
}

function FilterLink({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={`rounded-full border px-3 py-1 text-xs font-medium ${
        active ? 'border-primary bg-primary text-white' : 'border-border text-muted-foreground hover:border-primary hover:text-foreground'
      }`}
    >
      {children}
    </Link>
  )
}
