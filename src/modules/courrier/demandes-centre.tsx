import Link from 'next/link'

import { formatDateTime } from '../../lib/dates.ts'
import type { StaffMailRequestRow } from './demandes-queries.ts'
import { isPendingRequest } from './demandes-regles.ts'
import { mailRequestKindIcons, mailRequestStatusIcons } from './icones.tsx'
import { mailRequestKindLabels, mailRequestStatusLabels, mailRequestStatusStyles } from './labels.ts'

/** Étapes d'une demande vue du centre : dates et auteurs. */
export function requestStaffSteps(request: StaffMailRequestRow) {
  const steps: { label: string; at: Date; by: string | null; detail?: string }[] = [
    {
      label: 'Demandée',
      at: request.requestedAt,
      by: request.requestedByStaff
        ? `${request.requestedByName ?? 'le centre'}, sur consigne du client`
        : request.requestedByName,
    },
  ]
  if (request.startedAt) steps.push({ label: 'Validée', at: request.startedAt, by: request.startedByName })
  if (request.completedAt) steps.push({ label: 'Faite', at: request.completedAt, by: request.completedByName })
  if (request.refusedAt) {
    steps.push({
      label: 'Refusée',
      at: request.refusedAt,
      by: request.refusedByName ?? 'refus automatique',
      detail: request.refusalReason ?? undefined,
    })
  }
  if (request.cancelledAt) steps.push({ label: 'Annulée', at: request.cancelledAt, by: request.cancelledByName })
  return steps
}

/** Les étapes, chacune avec sa date et son auteur. */
export function RequestSteps({ request, timeZone }: { request: StaffMailRequestRow; timeZone: string }) {
  return (
    <ol className="flex flex-col gap-0.5 border-l-2 border-border pl-3 text-sm">
      {requestStaffSteps(request).map((step) => (
        <li key={step.label} className="tabular">
          <span className="font-medium">{step.label}</span> le {formatDateTime(step.at, timeZone)}
          {step.by && <span className="text-muted-foreground"> · {step.by}</span>}
          {step.detail && <span className="block">Motif : {step.detail}</span>}
        </li>
      ))}
    </ol>
  )
}

/** Nature et état d'une demande : l'état se lit au texte et à l'icône, jamais à la seule couleur. */
export function RequestBadges({ request }: { request: StaffMailRequestRow }) {
  const StatusIcon = mailRequestStatusIcons[request.status]
  return (
    <>
      <span
        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${mailRequestStatusStyles[request.status]}`}
      >
        <StatusIcon size={14} />
        {mailRequestStatusLabels[request.status]}
      </span>
      {request.billed && (
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-foreground">Facturée</span>
      )}
    </>
  )
}

/**
 * Les demandes d'un pli, sur sa fiche (R21, ADR 037) : chacune avec ses
 * étapes, et le lien vers son écran de traitement, qui ne montre que ce qui
 * la sert (ADR 079) — l'adresse d'une réexpédition, le dépôt et l'aperçu
 * d'une numérisation ou d'une ouverture.
 */
export function MailRequestsSection({ requests, timeZone }: { requests: StaffMailRequestRow[]; timeZone: string }) {
  return (
    <section aria-labelledby="demandes" className="flex flex-col gap-3">
      <h2 id="demandes" className="text-sm font-semibold tracking-tight">
        Demandes du client <span className="font-normal text-muted-foreground">({requests.length})</span>
      </h2>
      {requests.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Aucune demande sur ce pli. Le client peut demander son ouverture, une numérisation ou sa réexpédition
          depuis son espace.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {requests.map((request) => {
            const KindIcon = mailRequestKindIcons[request.kind]
            const pending = isPendingRequest(request.status)
            const subject = mailRequestKindLabels[request.kind].toLowerCase()
            return (
              <li
                key={request.id}
                id={`demande-${request.id}`}
                className="flex scroll-mt-24 flex-col gap-3 rounded-lg border border-border bg-white px-5 py-4 sm:flex-row sm:items-start sm:justify-between"
              >
                <div className="flex flex-col gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="inline-flex items-center gap-1.5 text-sm font-semibold">
                      <KindIcon size={16} className="text-primary" />
                      {mailRequestKindLabels[request.kind]}
                    </h3>
                    <RequestBadges request={request} />
                  </div>
                  <RequestSteps request={request} timeZone={timeZone} />
                </div>
                <Link
                  href={`/courrier/demandes/${request.id}`}
                  aria-label={`${pending ? 'Traiter' : 'Voir'} la demande de ${subject}`}
                  className={`inline-flex min-h-10 shrink-0 items-center self-start whitespace-nowrap rounded-md px-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
                    pending ? 'bg-primary text-white hover:bg-primary-hover' : 'border border-border bg-white hover:bg-muted'
                  }`}
                >
                  {pending ? 'Traiter la demande' : 'Voir la demande'}
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
