import { formatDateTime } from '../../lib/dates.ts'
import { centsToInput, formatCents } from '../facturation/tarifs.ts'
import type { StaffMailRequestRow } from './demandes-queries.ts'
import { forwardAddressLines, staffRequestActions } from './demandes-regles.ts'
import {
  CancelForClientButton,
  CompleteForwardForm,
  CompleteScanForm,
  RefuseRequestForm,
  ShippingForm,
  StartRequestButton,
} from './demandes-traitement.tsx'
import { mailRequestKindIcons, mailRequestStatusIcons } from './icones.tsx'
import { mailRequestKindLabels, mailRequestStatusLabels, mailRequestStatusStyles } from './labels.ts'

/**
 * Les demandes d'un pli, sur sa page du back-office (R21, ADR 037) : chacune
 * avec ses étapes, leurs dates et leurs auteurs, et ce que l'accueil peut en
 * faire maintenant. L'ouverture demandée se fait par le formulaire
 * d'ouverture du pli, qui la clôt.
 */
export function MailRequestsSection({
  requests,
  timeZone,
  withdrawn,
}: {
  requests: StaffMailRequestRow[]
  timeZone: string
  withdrawn: boolean
}) {
  return (
    <section aria-labelledby="demandes" className="flex flex-col gap-3">
      <h2 id="demandes" className="text-sm font-semibold tracking-tight">
        Demandes du client{' '}
        <span className="font-normal text-muted-foreground">({requests.length})</span>
      </h2>
      {requests.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Aucune demande sur ce pli. Le client peut demander son ouverture, une numérisation ou sa
          réexpédition depuis son espace.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {requests.map((request) => (
            <li key={request.id}>
              <RequestEntry request={request} timeZone={timeZone} withdrawn={withdrawn} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function RequestEntry({
  request,
  timeZone,
  withdrawn,
}: {
  request: StaffMailRequestRow
  timeZone: string
  withdrawn: boolean
}) {
  const KindIcon = mailRequestKindIcons[request.kind]
  const StatusIcon = mailRequestStatusIcons[request.status]
  const actions = staffRequestActions(request, {
    otherPending: request.otherPending,
    withdrawn,
    billed: request.billed,
  })
  const subject = mailRequestKindLabels[request.kind].toLowerCase()
  const at = (date: Date) => formatDateTime(date, timeZone)
  const steps: { label: string; at: Date; by: string | null; detail?: string }[] = [
    {
      label: 'Demandée',
      at: request.requestedAt,
      by: request.requestedByStaff
        ? `${request.requestedByName ?? 'le centre'}, sur consigne du client`
        : request.requestedByName,
    },
  ]
  if (request.startedAt) steps.push({ label: 'Prise en charge', at: request.startedAt, by: request.startedByName })
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

  return (
    <article
      id={`demande-${request.id}`}
      aria-labelledby={`demande-${request.id}-titre`}
      className="flex scroll-mt-24 flex-col gap-3 rounded-lg border border-border bg-white px-5 py-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={`demande-${request.id}-titre`} className="inline-flex items-center gap-1.5 text-sm font-semibold">
          <KindIcon size={16} className="text-primary" />
          {mailRequestKindLabels[request.kind]}
        </h3>
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${mailRequestStatusStyles[request.status]}`}
        >
          <StatusIcon size={14} />
          {mailRequestStatusLabels[request.status]}
        </span>
        {request.billed && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-foreground">Facturée</span>
        )}
      </div>

      <ol className="flex flex-col gap-0.5 border-l-2 border-border pl-3 text-sm">
        {steps.map((step) => (
          <li key={step.label} className="tabular">
            <span className="font-medium">{step.label}</span> le {at(step.at)}
            {step.by && <span className="text-muted-foreground"> · {step.by}</span>}
            {step.detail && <span className="block">Motif : {step.detail}</span>}
          </li>
        ))}
      </ol>

      {request.clientNote && (
        <p className="whitespace-pre-line rounded-md bg-muted px-3 py-2 text-sm">
          <span className="font-medium">Consigne du client : </span>
          {request.clientNote}
        </p>
      )}

      {request.forwardAddress && (
        <div className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <p className="font-medium">Adresse de réexpédition</p>
            <address className="not-italic">
              {forwardAddressLines(request.forwardAddress).map((line, index) => (
                <span key={index} className="block">
                  {line}
                </span>
              ))}
            </address>
          </div>
          {(request.forwardTrackingNumber || request.postageCents !== null) && (
            <dl className="grid grid-cols-[9rem_1fr] gap-y-1 tabular">
              {request.forwardTrackingNumber && (
                <>
                  <dt className="text-muted-foreground">Suivi</dt>
                  <dd>{request.forwardTrackingNumber}</dd>
                </>
              )}
              {request.postageCents !== null && request.postageCurrency && (
                <>
                  <dt className="text-muted-foreground">Affranchissement</dt>
                  <dd>{formatCents(request.postageCents, request.postageCurrency)}</dd>
                </>
              )}
            </dl>
          )}
        </div>
      )}

      {request.contentScanId && (
        <p>
          <a
            href={`/courrier/scans/${request.contentScanId}`}
            target="_blank"
            rel="noopener"
            className="text-sm font-medium underline underline-offset-2"
          >
            Numérisation produite par cette demande (nouvel onglet)
          </a>
        </p>
      )}

      {actions.complete === 'open' && (
        <p className="text-sm text-muted-foreground">
          Ouvrez le pli avec le formulaire « Ouvrir et numériser » : l’ouverture clôt cette demande et
          le contenu lui est rattaché.
        </p>
      )}
      {actions.complete === 'scan' && <CompleteScanForm requestId={request.id} />}
      {actions.complete === 'forward' && <CompleteForwardForm requestId={request.id} />}
      {actions.blockedBy && <p className="text-sm text-foreground">{actions.blockedBy}</p>}
      {actions.editShipping && (
        <ShippingForm
          requestId={request.id}
          trackingNumber={request.forwardTrackingNumber ?? ''}
          postage={request.postageCents === null ? '' : centsToInput(request.postageCents)}
        />
      )}

      {(actions.start || actions.cancel) && (
        <div className="flex flex-wrap items-start gap-3">
          {actions.start && <StartRequestButton requestId={request.id} subject={subject} />}
          {actions.cancel && <CancelForClientButton requestId={request.id} subject={subject} />}
        </div>
      )}
      {actions.refuse && <RefuseRequestForm requestId={request.id} subject={subject} />}
    </article>
  )
}
