import Link from 'next/link'
import { redirect } from 'next/navigation'

import { can } from '../../../lib/auth/permissions.ts'
import { requirePermission } from '../../../lib/auth/staff.ts'
import { formatDateTime } from '../../../lib/dates.ts'
import { currentTimeZone } from '../../../lib/tenant.ts'
import { isUuid } from '../../../lib/uuid.ts'
import { findClient } from '../../../modules/clients/queries.ts'
import {
  mailKindLabels,
  mailStatusLabels,
  mailStatusStyles,
} from '../../../modules/courrier/labels.ts'
import { countPendingMailRequests } from '../../../modules/courrier/demandes-queries.ts'
import { listMail } from '../../../modules/courrier/queries.ts'

export const metadata = { title: 'Courrier' }

/**
 * Courrier des entreprises domiciliées : tout ce qui a été enregistré. Les
 * plis à ouvrir sont une vue de la file des demandes (`/courrier/demandes`,
 * ADR 037), à côté des numérisations et des réexpéditions.
 */
export default async function CourrierPage({
  searchParams,
}: {
  searchParams: Promise<{ vue?: string; client?: string }>
}) {
  const { member } = await requirePermission('courrier.gerer')
  const { vue, client } = await searchParams
  const clientId = isUuid(client) ? client : undefined
  // L'ancienne vue « À ouvrir » : la file des demandes d'ouverture.
  if (vue === 'a-ouvrir') {
    redirect(`/courrier/demandes?nature=ouverture${clientId ? `&client=${clientId}` : ''}`)
  }

  const [timeZone, rows, pending, filteredClient] = await Promise.all([
    currentTimeZone(),
    listMail({ clientId }),
    countPendingMailRequests(),
    clientId ? findClient(clientId) : undefined,
  ])
  const requestCount = pending.total

  const suffix = clientId ? `?client=${clientId}` : ''

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Courrier</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Plis reçus pour les entreprises domiciliées. Chacune les retrouve dans son espace client.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          {can(member.role, 'courrier.releve') && (
            <Link
              href="/courrier/ouvertures"
              className="rounded-md border border-border bg-white px-4 py-2 text-sm font-medium hover:bg-muted"
            >
              Relevé des ouvertures
            </Link>
          )}
          <Link
            href={clientId ? `/courrier/nouveau?clientId=${clientId}` : '/courrier/nouveau'}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover"
          >
            Enregistrer un courrier
          </Link>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <FilterLink
          href={clientId ? `/courrier?client=${clientId}` : '/courrier'}
          label="Tous"
          active
        />
        <FilterLink
          href={`/courrier/demandes${suffix}`}
          label={`Demandes à traiter (${requestCount})`}
          active={false}
        />
        {filteredClient && (
          <span className="ml-2 inline-flex items-center gap-2 rounded-full bg-muted px-3 py-1 text-xs font-medium">
            Client : {filteredClient.name}
            <Link
              href="/courrier"
              className="text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              Tous les clients
            </Link>
          </span>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-white px-6 py-12 text-center">
          <p className="text-sm text-muted-foreground">
            Aucun courrier enregistré. Le client verra chaque pli dans son espace dès son enregistrement.
          </p>
          <Link
            href={clientId ? `/courrier/nouveau?clientId=${clientId}` : '/courrier/nouveau'}
            className="mt-4 inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover"
          >
            Enregistrer un courrier
          </Link>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">Reçu le</th>
                <th className="px-4 py-3 font-medium">Destinataire</th>
                <th className="px-4 py-3 font-medium">Expéditeur</th>
                <th className="px-4 py-3 font-medium">Type</th>
                <th className="px-4 py-3 font-medium">État</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="whitespace-nowrap px-4 py-3 tabular">
                    <Link
                      href={`/courrier/${row.id}`}
                      className="font-medium underline-offset-2 hover:underline"
                    >
                      {formatDateTime(row.receivedAt, timeZone)}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <Link
                      href={`/courrier?client=${row.clientId}`}
                      className="underline-offset-2 hover:underline"
                    >
                      {row.clientName}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{row.sender ?? '—'}</td>
                  <td className="px-4 py-3 text-muted-foreground">{mailKindLabels[row.kind]}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${mailStatusStyles[row.status]}`}
                    >
                      {mailStatusLabels[row.status]}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows.length === 200 && (
        <p className="text-xs text-muted-foreground">
          Les 200 plis les plus récents sont affichés. Filtrez par client pour remonter plus loin.
        </p>
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
        active
          ? 'border-primary bg-primary text-white'
          : 'border-border text-muted-foreground hover:border-border'
      }`}
    >
      {label}
    </Link>
  )
}
