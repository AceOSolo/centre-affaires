import Link from 'next/link'
import { notFound } from 'next/navigation'

import { LienRetour } from '../../../../../components/ui/lien-retour.tsx'
import { FlashNotice } from '../../../../../components/ui/flash-notice.tsx'
import { requirePermission } from '../../../../../lib/auth/staff.ts'
import { formatDateTime, todayIsoDate } from '../../../../../lib/dates.ts'
import { currentTimeZone } from '../../../../../lib/tenant.ts'
import { centsToInput, formatCents } from '../../../../../modules/facturation/tarifs.ts'
import { DraftReview } from '../../../../../modules/courrier/depot-a-valider.tsx'
import { findContentDrafts } from '../../../../../modules/courrier/depots.ts'
import { DepositForm } from '../../../../../modules/courrier/depots-forms.tsx'
import { RequestBadges, RequestSteps } from '../../../../../modules/courrier/demandes-centre.tsx'
import { findMailRequest } from '../../../../../modules/courrier/demandes-queries.ts'
import { forwardAddressLines, staffRequestActions } from '../../../../../modules/courrier/demandes-regles.ts'
import {
  CancelForClientButton,
  CompleteForwardForm,
  RefuseRequestForm,
  ShippingForm,
  StartRequestButton,
} from '../../../../../modules/courrier/demandes-traitement.tsx'
import { EnvelopeZoom } from '../../../../../modules/courrier/enveloppe-zoom.tsx'
import { mailRequestKindIcons } from '../../../../../modules/courrier/icones.tsx'
import { mailKindLabels, mailRequestKindLabels } from '../../../../../modules/courrier/labels.ts'
import { findMailSpots } from '../../../../../modules/courrier/queries.ts'
import { spotLabel } from '../../../../../modules/courrier/reperage.ts'

export const metadata = { title: 'Traiter une demande de courrier' }

/** Confirmations, après une étape (`?fait=`). */
const notices: Record<string, string> = {
  validee: 'Demande validée. Le client voit que le centre s’en occupe ; il ne peut plus l’annuler.',
  deposee: 'Contenu déposé. Relisez l’aperçu, puis validez : le client ne le voit pas encore.',
  ouverte: 'Ouverture validée. Le client voit le contenu dans son espace et en est prévenu par courriel.',
  numerisee: 'Numérisation validée, demande faite. Le client la voit dans son espace et en est prévenu par courriel.',
  abandon: 'Dépôt abandonné : rien n’a été publié. La demande reste à traiter.',
  refus: 'Demande refusée. Le client lit le motif dans son espace ; il est prévenu par courriel.',
  annulation: 'Demande annulée à la demande du client, à votre nom.',
  reexpediee: 'Réexpédition notée comme faite. Le client est prévenu par courriel.',
  envoi: 'Suivi et frais d’affranchissement enregistrés.',
}

/**
 * Écran de traitement d'une demande de courrier (ADR 079) : on y arrive par
 * « Valider » ou « Traiter la demande », depuis « Demandes », la file du
 * courrier ou la fiche du pli. Il ne montre **que ce qui sert à la demande** :
 *
 * - toujours, de quoi retrouver le pli — la photo de l'enveloppe et son
 *   repère du jour (ADR 057) —, la consigne du client et les étapes ;
 * - une réexpédition : l'adresse figée et l'envoi (suivi, affranchissement),
 *   pas de numérisation ;
 * - une ouverture ou une numérisation : le dépôt du contenu, son aperçu et
 *   « Valider et prévenir le client », pas de réexpédition.
 *
 * Le reste du pli (journal des consultations, retrait, autres demandes) est
 * sur sa fiche, à un lien.
 */
export default async function TraiterDemandePage({
  params,
  searchParams,
}: {
  params: Promise<{ requestId: string }>
  searchParams: Promise<{ fait?: string }>
}) {
  await requirePermission('courrier.gerer')
  const [{ requestId }, { fait }] = await Promise.all([params, searchParams])
  const timeZone = await currentTimeZone()
  const request = await findMailRequest(requestId)
  if (!request) notFound()
  const [spots, drafts] = await Promise.all([
    findMailSpots([request.mailItemId], timeZone),
    request.kind === 'forward' ? [] : findContentDrafts(request.mailItemId),
  ])

  const withdrawn = Boolean(request.mailDeletedAt)
  const actions = staffRequestActions(request, {
    otherPending: request.otherPending,
    withdrawn,
    billed: request.billed,
  })
  // Le dépôt de la place de cette demande : sa numérisation, ou l'ouverture du pli.
  const draft = drafts.find((candidate) =>
    request.kind === 'scan' ? candidate.mailRequestId === request.id : candidate.purpose === 'opening',
  )
  const KindIcon = mailRequestKindIcons[request.kind]
  const subject = `${mailRequestKindLabels[request.kind].toLowerCase()} de ${request.clientName}`
  const received = formatDateTime(request.mailReceivedAt, timeZone)
  const spot = spots.get(request.mailItemId)
  const spotText = spot ? spotLabel(spot, todayIsoDate(timeZone)) : null
  const sender = request.mailSender ? `de ${request.mailSender}` : 'expéditeur non précisé'

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <LienRetour href="/demandes?produit=domiciliation#courrier" label="Demandes" className="hover:underline" />
          <Link href={`/courrier/${request.mailItemId}`} className="hover:underline">
            Fiche complète du pli
          </Link>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="inline-flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <KindIcon size={24} className="text-primary" />
            {mailRequestKindLabels[request.kind]} — {request.clientName}
          </h1>
          <RequestBadges request={request} />
        </div>
        <p className="mt-1 text-sm text-muted-foreground tabular">
          Demandée le {formatDateTime(request.requestedAt, timeZone)}
          {request.requestedByName && ` par ${request.requestedByName}`}
          {request.requestedByStaff && ', sur consigne du client'}
        </p>
      </div>

      {fait && notices[fait] && <FlashNotice key={fait}>{notices[fait]}</FlashNotice>}

      {/* De quoi retrouver le pli dans la pile de l'entreprise (ADR 057). */}
      <section
        aria-labelledby="pli"
        className="flex flex-col gap-4 rounded-lg border border-border bg-white px-5 py-4 sm:flex-row sm:items-start"
      >
        <div className="sm:w-56 sm:shrink-0">
          <EnvelopeZoom
            scanId={request.envelopeScanId}
            contentType={request.envelopeContentType}
            label={`Enveloppe du pli de ${request.clientName}, reçu le ${received}`}
            details={[mailKindLabels[request.mailKind], sender, ...(spotText ? [spotText] : [])]}
            size="large"
          />
        </div>
        <div className="flex flex-1 flex-col gap-2">
          <h2 id="pli" className="text-sm font-semibold tracking-tight">
            Le pli
          </h2>
          <dl className="grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
            <dt className="text-muted-foreground">Repère</dt>
            <dd className="tabular">
              {spotText ? (
                <span className="font-medium text-primary">{spotText}</span>
              ) : (
                <span className="text-muted-foreground">— (pli retiré)</span>
              )}
            </dd>
            <dt className="text-muted-foreground">Type</dt>
            <dd>{mailKindLabels[request.mailKind]}</dd>
            <dt className="text-muted-foreground">Expéditeur</dt>
            <dd>{request.mailSender ?? <span className="text-muted-foreground">non précisé</span>}</dd>
            <dt className="text-muted-foreground">Reçu le</dt>
            <dd className="tabular">{received}</dd>
            <dt className="text-muted-foreground">Entreprise</dt>
            <dd>
              <Link href={`/clients/${request.clientId}`} className="underline-offset-2 hover:underline">
                {request.clientName}
              </Link>
            </dd>
          </dl>
        </div>
      </section>

      {request.clientNote && (
        <p className="whitespace-pre-line rounded-md bg-muted px-4 py-3 text-sm">
          <span className="font-medium">Consigne du client : </span>
          {request.clientNote}
        </p>
      )}

      <section aria-labelledby="etapes" className="flex flex-col gap-2">
        <h2 id="etapes" className="text-sm font-semibold tracking-tight">
          Étapes
        </h2>
        <RequestSteps request={request} timeZone={timeZone} />
      </section>

      {withdrawn && (
        <p className="rounded-md border border-border bg-muted px-4 py-3 text-sm">
          Ce pli a été retiré le {formatDateTime(request.mailDeletedAt as Date, timeZone)} : ses demandes en cours ont été
          refusées, il n’y a plus rien à faire ici.
        </p>
      )}

      {/* Valider d'abord : le client voit que le centre s'en occupe et ne l'annule plus. */}
      {(actions.start || actions.cancel) && (
        <section aria-labelledby="valider" className="flex flex-col gap-3 rounded-lg border border-border bg-white px-5 py-4">
          <h2 id="valider" className="text-sm font-semibold tracking-tight">
            Valider la demande
          </h2>
          <p className="max-w-[70ch] text-sm text-muted-foreground">
            Le client voit que le centre s’en occupe et ne peut plus l’annuler. Vous pouvez aussi la faire tout de suite :
            {request.kind === 'forward' ? ' noter l’envoi ci-dessous la valide.' : ' déposer le contenu ci-dessous la valide.'}
          </p>
          <div className="flex flex-wrap items-start gap-3">
            {actions.start && <StartRequestButton requestId={request.id} subject={subject} primary />}
            {actions.cancel && <CancelForClientButton requestId={request.id} subject={subject} />}
          </div>
        </section>
      )}

      {request.kind === 'forward' && request.forwardAddress && (
        <section aria-labelledby="reexpedition" className="flex flex-col gap-4 rounded-lg border border-border bg-white px-5 py-4">
          <h2 id="reexpedition" className="text-sm font-semibold tracking-tight">
            Réexpédition
          </h2>
          <div className="grid gap-4 text-sm sm:grid-cols-2">
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
          {actions.blockedBy && <p className="text-sm text-foreground">{actions.blockedBy}</p>}
          {actions.complete === 'forward' && <CompleteForwardForm requestId={request.id} />}
          {actions.editShipping && (
            <ShippingForm
              requestId={request.id}
              trackingNumber={request.forwardTrackingNumber ?? ''}
              postage={request.postageCents === null ? '' : centsToInput(request.postageCents)}
            />
          )}
        </section>
      )}

      {(actions.complete === 'open' || actions.complete === 'scan') &&
        (draft ? (
          <DraftReview draft={draft} timeZone={timeZone} back="demande" />
        ) : (
          <section aria-labelledby="depot" className="flex flex-col gap-3 rounded-lg border border-border bg-white px-5 py-4">
            <div>
              <h2 id="depot" className="text-sm font-semibold tracking-tight">
                {actions.complete === 'open' ? 'Ouvrir et numériser' : 'Numériser'}
              </h2>
              <p className="mt-1 max-w-[70ch] text-xs text-muted-foreground">
                {actions.complete === 'open'
                  ? 'Ouvrez le pli, photographiez ou déposez son contenu. Vous le relirez avant de le valider : le client n’est prévenu qu’à la validation.'
                  : 'Numérisez les pages demandées. Vous les relirez avant de valider : le client n’est prévenu qu’à la validation.'}
              </p>
            </div>
            <DepositForm
              mailItemId={request.mailItemId}
              requestId={request.id}
              purpose={actions.complete === 'scan' ? 'scan' : 'opening'}
            />
          </section>
        ))}

      {request.status === 'done' && request.kind !== 'forward' && request.contentScanId && (
        <p>
          <a
            href={`/courrier/scans/${request.contentScanId}`}
            target="_blank"
            rel="noopener"
            className="text-sm font-medium underline underline-offset-2"
          >
            Numérisation envoyée au client (nouvel onglet)
          </a>
        </p>
      )}

      {actions.refuse && <RefuseRequestForm requestId={request.id} subject={subject} />}
    </div>
  )
}
