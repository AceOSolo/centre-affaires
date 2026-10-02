import Link from 'next/link'

import { formatDateTime } from '../../lib/dates.ts'
import { formatCents } from '../facturation/tarifs.ts'
import { CancelMailRequestButton } from './demandes-compte-forms.tsx'
import type { MailRequestRow } from './demandes-queries.ts'
import { canClientCancelRequest, forwardAddressLines, requestSteps } from './demandes-regles.ts'
import { mailRequestKindIcons, mailRequestStatusIcons } from './icones.tsx'
import {
  mailKindLabels,
  mailRequestKindLabels,
  mailRequestStatusClientLabels,
  mailRequestStatusStyles,
} from './labels.ts'

/**
 * Une demande telle que le client la suit (R21, R24) : sa nature, son état —
 * libellé et icône, jamais la couleur seule —, chaque étape datée dans le
 * fuseau du centre, et ce qu'elle a produit. Annulable tant que le centre ne
 * l'a pas prise en charge.
 */
export function ClientRequestCard({
  request,
  timeZone,
  from,
  showMail,
  showClient,
}: {
  request: MailRequestRow
  timeZone: string
  from: 'pli' | 'demandes'
  /** Rappeler le pli concerné, dans l'historique de toutes les demandes. */
  showMail: boolean
  showClient: boolean
}) {
  const KindIcon = mailRequestKindIcons[request.kind]
  const StatusIcon = mailRequestStatusIcons[request.status]
  const steps = requestSteps(request)
  const headingId = `demande-${request.id}`

  return (
    <article aria-labelledby={headingId} className="flex flex-col gap-3 rounded-lg border border-border bg-white p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium ${mailRequestStatusStyles[request.status]}`}
        >
          <StatusIcon size={16} />
          {mailRequestStatusClientLabels[request.status]}
        </span>
        {showClient && <span className="text-muted-foreground">{request.clientName}</span>}
      </div>

      <div>
        <h3 id={headingId} className="flex items-center gap-2 text-base font-semibold">
          <KindIcon size={20} className="text-primary" />
          {mailRequestKindLabels[request.kind]}
        </h3>
        {showMail && (
          <p className="text-sm text-muted-foreground">
            <Link href={`/compte/courrier/${request.mailItemId}`} className="inline-flex min-h-11 items-center underline underline-offset-2 hover:text-primary sm:min-h-0">
              {mailKindLabels[request.mailKind]} — {request.mailSender ?? 'expéditeur non précisé'}, reçu le{' '}
              {formatDateTime(request.mailReceivedAt, timeZone)}
            </Link>
          </p>
        )}
      </div>

      <ol className="flex flex-col gap-1 border-l-2 border-border pl-3 text-sm">
        {steps.map((step) => (
          <li key={step.status} className="tabular">
            <span className="font-medium">{step.label}</span> le {formatDateTime(step.at, timeZone)}
            {step.by && <span className="text-muted-foreground"> · par {step.by}</span>}
            {step.detail && <span className="block text-foreground">Motif : {step.detail}</span>}
          </li>
        ))}
      </ol>

      {request.clientNote && (
        <p className="whitespace-pre-line rounded-md bg-muted px-3 py-2 text-sm">
          <span className="font-medium">Précisions : </span>
          {request.clientNote}
        </p>
      )}

      {request.forwardAddress && (
        <div className="text-sm">
          <p className="font-medium">Adresse de réexpédition</p>
          <address className="not-italic text-muted-foreground">
            {forwardAddressLines(request.forwardAddress).map((line, index) => (
              <span key={index} className="block">
                {line}
              </span>
            ))}
          </address>
          {request.forwardTrackingNumber && (
            <p className="mt-1 tabular">
              Numéro de suivi : <span className="font-medium">{request.forwardTrackingNumber}</span>
            </p>
          )}
          {request.postageCents !== null && request.postageCurrency && (
            <p className="tabular">
              Frais d’affranchissement : {formatCents(request.postageCents, request.postageCurrency)}
            </p>
          )}
        </div>
      )}

      {(request.contentScanId || canClientCancelRequest(request.status)) && (
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-start">
          {request.contentScanId && (
            <a
              href={`/compte/scans/${request.contentScanId}`}
              className="press inline-flex min-h-11 items-center justify-center rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover"
            >
              Lire la numérisation
            </a>
          )}
          {canClientCancelRequest(request.status) && (
            <CancelMailRequestButton
              requestId={request.id}
              mailItemId={request.mailItemId}
              from={from}
              label={`Annuler la demande de ${mailRequestKindLabels[request.kind].toLowerCase()} du ${formatDateTime(request.requestedAt, timeZone)}`}
            />
          )}
        </div>
      )}
    </article>
  )
}
