import Link from 'next/link'

import { FlashNotice } from '../../../../components/ui/flash-notice.tsx'
import { requirePermission } from '../../../../lib/auth/staff.ts'
import { formatDateTime } from '../../../../lib/dates.ts'
import { currentTimeZone } from '../../../../lib/tenant.ts'
import { isUuid } from '../../../../lib/uuid.ts'
import { findClient } from '../../../../modules/clients/queries.ts'
import { startMailRequestsAction } from '../../../../modules/courrier/demandes-actions.ts'
import { countPendingMailRequests, listMailRequests } from '../../../../modules/courrier/demandes-queries.ts'
import {
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
import { PendingSubmit, SelectAllRequests } from '../../../../modules/courrier/demandes-traitement.tsx'
import { mailRequestKindIcons, mailRequestStatusIcons } from '../../../../modules/courrier/icones.tsx'
import {
  mailKindLabels,
  mailRequestKindLabels,
  mailRequestStatusLabels,
  mailRequestStatusStyles,
} from '../../../../modules/courrier/labels.ts'

export const metadata = { title: 'Demandes de courrier' }

/**
 * File des demandes de courrier (R21, ADR 037) : ce que les clients attendent
 * de l'accueil — ouvertures, numérisations, réexpéditions —, par nature et par
 * état. Les demandes à traiter se lisent dans l'ordre d'arrivée ; chacune se
 * traite sur la page de son pli.
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
  const pages = pageCount(result.total, REQUEST_PAGE_SIZE)
  const selectable = result.rows.filter((row) => row.status === 'requested').length
  const started = Number(typeof params.prises === 'string' ? params.prises : NaN)
  const skipped = Number(typeof params.ignorees === 'string' ? params.ignorees : 0)
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
        <Link href="/courrier" className="text-sm text-muted-foreground hover:underline">
          ← Courrier
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Demandes de courrier</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {counts.total === 0
            ? 'Aucune demande à traiter.'
            : `${counts.total} demande${counts.total > 1 ? 's' : ''} à traiter : ${counts.open_and_scan} ouverture${counts.open_and_scan > 1 ? 's' : ''}, ${counts.scan} numérisation${counts.scan > 1 ? 's' : ''}, ${counts.forward} réexpédition${counts.forward > 1 ? 's' : ''}.`}{' '}
          Une réexpédition se fait en dernier : le pli quitte le centre.
        </p>
      </div>

      {Number.isInteger(started) && started >= 0 && (
        <FlashNotice key={`${started}-${skipped}`}>
          {started === 0
            ? 'Aucune demande prise en charge.'
            : `${started} demande${started > 1 ? 's' : ''} prise${started > 1 ? 's' : ''} en charge.`}
          {Number.isInteger(skipped) && skipped > 0 &&
            ` ${skipped} ignorée${skipped > 1 ? 's' : ''} : déjà prise${skipped > 1 ? 's' : ''} en charge, faite${skipped > 1 ? 's' : ''} ou annulée${skipped > 1 ? 's' : ''} entre-temps.`}
        </FlashNotice>
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
        // Une seule action se répète d'une ligne à l'autre sans pièce à joindre :
        // la prise en charge. Elle se fait aussi en groupe (`CLAUDE.md`).
        <form action={startMailRequestsAction} className="flex flex-col gap-3">
          <input type="hidden" name="etat" value={filters.state} />
          <input type="hidden" name="nature" value={filters.kindSlug ?? ''} />
          <input type="hidden" name="page" value={String(filters.page)} />
          <input type="hidden" name="client" value={clientParam ?? ''} />
          {selectable > 0 && (
            <div className="flex flex-wrap items-center gap-3">
              <PendingSubmit label="Prendre en charge la sélection" pendingLabel="Prise en charge…" />
              <p className="text-xs text-muted-foreground">
                Le client voit que le centre s’en occupe ; il ne peut plus l’annuler.
              </p>
            </div>
          )}
        <div className="overflow-x-auto rounded-lg border border-border bg-white">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">
              Demandes de courrier — {requestStateFilterLabels[filters.state].toLowerCase()}
            </caption>
            <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th scope="col" className="w-10 px-4 py-3 font-medium">
                  {selectable > 0 && <SelectAllRequests label="Sélectionner toutes les demandes pas encore prises en charge" />}
                </th>
                <th scope="col" className="px-4 py-3 font-medium">Demandée le</th>
                <th scope="col" className="px-4 py-3 font-medium">Nature</th>
                <th scope="col" className="px-4 py-3 font-medium">Client</th>
                <th scope="col" className="px-4 py-3 font-medium">Pli</th>
                <th scope="col" className="px-4 py-3 font-medium">Par</th>
                <th scope="col" className="px-4 py-3 font-medium">État</th>
                <th scope="col" className="px-4 py-3 font-medium">
                  <span className="sr-only">Action</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {result.rows.map((row) => {
                const KindIcon = mailRequestKindIcons[row.kind]
                const StatusIcon = mailRequestStatusIcons[row.status]
                const lastStep = row.completedAt ?? row.refusedAt ?? row.cancelledAt ?? row.startedAt
                return (
                  <tr key={row.id}>
                    <td className="px-4 py-3">
                      {row.status === 'requested' && (
                        <input
                          type="checkbox"
                          name="ids"
                          value={row.id}
                          aria-label={`Sélectionner la demande de ${mailRequestKindLabels[row.kind].toLowerCase()} de ${row.clientName} du ${formatDateTime(row.requestedAt, timeZone)}`}
                          className="size-4 accent-[var(--primary)]"
                        />
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 tabular">{formatDateTime(row.requestedAt, timeZone)}</td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1.5">
                        <KindIcon size={16} className="text-primary" />
                        {mailRequestKindLabels[row.kind]}
                      </span>
                      {row.clientNote && <span className="block text-xs text-muted-foreground">« {row.clientNote} »</span>}
                    </td>
                    <td className="px-4 py-3">
                      <Link href={link({ clientId: row.clientId })} className="underline-offset-2 hover:underline">
                        {row.clientName}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {mailKindLabels[row.mailKind]} — {row.mailSender ?? 'expéditeur non précisé'}
                      <span className="block text-xs tabular">reçu le {formatDateTime(row.mailReceivedAt, timeZone)}</span>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{row.requestedByName ?? '—'}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${mailRequestStatusStyles[row.status]}`}
                      >
                        <StatusIcon size={14} />
                        {mailRequestStatusLabels[row.status]}
                      </span>
                      {lastStep && row.status !== 'requested' && (
                        <span className="block text-xs text-muted-foreground tabular">
                          le {formatDateTime(lastStep, timeZone)}
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <Link
                        href={`/courrier/${row.mailItemId}#demande-${row.id}`}
                        aria-label={`${row.status === 'requested' || row.status === 'in_progress' ? 'Traiter' : 'Voir'} la demande de ${mailRequestKindLabels[row.kind].toLowerCase()} de ${row.clientName}`}
                        className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted"
                      >
                        {row.status === 'requested' || row.status === 'in_progress' ? 'Traiter' : 'Voir'}
                      </Link>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        </form>
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
