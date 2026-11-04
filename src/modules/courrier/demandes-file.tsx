import Link from 'next/link'

import { formatDateTime } from '../../lib/dates.ts'
import { startMailRequestsAction } from './demandes-actions.ts'
import type { StaffMailRequestRow } from './demandes-queries.ts'
import { PendingSubmit, SelectAllRequests, StartRequestButton } from './demandes-traitement.tsx'
import { EnvelopeZoom } from './enveloppe-zoom.tsx'
import { mailRequestKindIcons, mailRequestStatusIcons } from './icones.tsx'
import { mailKindLabels, mailRequestKindLabels, mailRequestStatusLabels, mailRequestStatusStyles } from './labels.ts'
import { spotLabel, type MailSpot } from './reperage.ts'

/**
 * La file des demandes de courrier, côté équipe (R21, ADR 037, ADR 057) :
 * dans « Demandes », la seule boîte de réception (ADR 048), et dans sa vue
 * filtrée `/courrier/demandes`, historique compris.
 *
 * Chaque ligne dit de quoi retrouver le pli : la photo de l'enveloppe,
 * agrandissable, l'entreprise, le type, l'expéditeur, la date de réception et
 * le rang du pli dans sa journée (« pli 3 sur 5 du 04/11 »). « Prendre en
 * charge » se fait ligne par ligne ou en groupe ; le reste du traitement se
 * fait sur la fiche du pli.
 *
 * Le formulaire de l'action groupée est à part, au-dessus du tableau : chaque
 * ligne a le sien pour « Prendre en charge », et les cases à cocher sont
 * rattachées au groupe par l'attribut `form` (pas de formulaires imbriqués).
 */
export function MailRequestQueue({
  rows,
  spots,
  timeZone,
  today,
  formId,
  hidden,
  caption,
  clientHref,
}: {
  rows: readonly StaffMailRequestRow[]
  spots: ReadonlyMap<string, MailSpot>
  timeZone: string
  /** Jour du centre, pour le repère (`todayIsoDate`). */
  today: string
  /** Identifiant du formulaire de l'action groupée : unique sur la page. */
  formId: string
  /** Champs cachés de l'action groupée : où revenir, filtres à garder. */
  hidden: Record<string, string>
  caption: string
  /** Lien du nom de l'entreprise : sa fiche, ou la file filtrée sur elle. */
  clientHref: (row: StaffMailRequestRow) => string
}) {
  const selectable = rows.filter((row) => row.status === 'requested').length

  return (
    <div className="flex flex-col gap-3">
      <form
        id={formId}
        action={startMailRequestsAction}
        className={selectable > 0 ? 'flex flex-wrap items-center gap-3' : 'hidden'}
      >
        {Object.entries(hidden).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        {selectable > 0 && (
          <>
            <PendingSubmit label="Prendre en charge la sélection" pendingLabel="Prise en charge…" />
            <p className="text-xs text-muted-foreground">
              Le client voit que le centre s’en occupe ; il ne peut plus l’annuler.
            </p>
          </>
        )}
      </form>

      {/* `relative` : les libellés `sr-only` (absolus) restent dans la zone qui défile, pas dans la page. */}
      <div className="relative overflow-x-auto rounded-lg border border-border bg-white">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th scope="col" className="w-10 px-4 py-3 font-medium">
                {selectable > 0 && (
                  <SelectAllRequests form={formId} label="Sélectionner toutes les demandes pas encore prises en charge" />
                )}
              </th>
              <th scope="col" className="px-4 py-3 font-medium">Pli</th>
              <th scope="col" className="px-4 py-3 font-medium">Client</th>
              <th scope="col" className="px-4 py-3 font-medium">Demande</th>
              <th scope="col" className="px-4 py-3 font-medium">État</th>
              <th scope="col" className="px-4 py-3 font-medium">
                <span className="sr-only">Action</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((row) => {
              const KindIcon = mailRequestKindIcons[row.kind]
              const StatusIcon = mailRequestStatusIcons[row.status]
              const lastStep = row.completedAt ?? row.refusedAt ?? row.cancelledAt ?? row.startedAt
              const pending = row.status === 'requested' || row.status === 'in_progress'
              const subject = `${mailRequestKindLabels[row.kind].toLowerCase()} de ${row.clientName}`
              const spot = spots.get(row.mailItemId)
              const received = formatDateTime(row.mailReceivedAt, timeZone)
              const details = [
                mailKindLabels[row.mailKind],
                row.mailSender ? `de ${row.mailSender}` : 'expéditeur non précisé',
                ...(spot ? [spotLabel(spot, today)] : []),
              ]
              return (
                <tr key={row.id} className="align-top">
                  <td className="px-4 py-3">
                    {row.status === 'requested' && (
                      <input
                        type="checkbox"
                        form={formId}
                        name="ids"
                        value={row.id}
                        aria-label={`Sélectionner la demande de ${subject} du ${formatDateTime(row.requestedAt, timeZone)}`}
                        className="size-4 accent-[var(--primary)]"
                      />
                    )}
                  </td>
                  <td className="min-w-[19rem] px-4 py-3">
                    <div className="flex items-start gap-3">
                      <EnvelopeZoom
                        scanId={row.envelopeScanId}
                        contentType={row.envelopeContentType}
                        label={`Enveloppe du pli de ${row.clientName}, reçu le ${received}`}
                        details={details}
                      />
                      <div className="min-w-0">
                        <p className="font-medium">{mailKindLabels[row.mailKind]}</p>
                        <p className="text-muted-foreground">
                          {row.mailSender ? `de ${row.mailSender}` : 'expéditeur non précisé'}
                        </p>
                        <p className="whitespace-nowrap text-xs text-muted-foreground tabular">reçu le {received}</p>
                        {spot && (
                          <p className="whitespace-nowrap text-xs font-medium text-primary tabular">{spotLabel(spot, today)}</p>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <Link href={clientHref(row)} className="underline-offset-2 hover:underline">
                      {row.clientName}
                    </Link>
                  </td>
                  <td className="min-w-[15rem] px-4 py-3">
                    <span className="inline-flex items-center gap-1.5 font-medium">
                      <KindIcon size={16} className="text-primary" />
                      {mailRequestKindLabels[row.kind]}
                    </span>
                    {row.clientNote && <span className="block text-xs text-muted-foreground">« {row.clientNote} »</span>}
                    <span className="block text-xs text-muted-foreground tabular">
                      demandée le {formatDateTime(row.requestedAt, timeZone)}
                      {row.requestedByName && ` par ${row.requestedByName}`}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${mailRequestStatusStyles[row.status]}`}
                    >
                      <StatusIcon size={14} />
                      {mailRequestStatusLabels[row.status]}
                    </span>
                    {lastStep && row.status !== 'requested' && (
                      <span className="block whitespace-nowrap text-xs text-muted-foreground tabular">
                        le {formatDateTime(lastStep, timeZone)}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-col items-start gap-2">
                      {row.status === 'requested' && !row.mailDeletedAt && (
                        <StartRequestButton requestId={row.id} subject={subject} />
                      )}
                      <Link
                        href={`/courrier/${row.mailItemId}#demande-${row.id}`}
                        aria-label={`${pending ? 'Traiter' : 'Voir'} la demande de ${subject}`}
                        className="whitespace-nowrap rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                      >
                        {pending ? 'Traiter sur la fiche du pli' : 'Voir la fiche du pli'}
                      </Link>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
