import Link from 'next/link'
import { notFound } from 'next/navigation'

import { FlashNotice } from '../../../../components/ui/flash-notice.tsx'
import { requirePermission } from '../../../../lib/auth/staff.ts'
import { formatDateTime, formatIsoMonth, toIsoDate, todayIsoDate } from '../../../../lib/dates.ts'
import { currentTimeZone } from '../../../../lib/tenant.ts'
import { withdrawMailAction } from '../../../../modules/courrier/actions.ts'
import { MailRequestsSection } from '../../../../modules/courrier/demandes-centre.tsx'
import { listRequestsForMail } from '../../../../modules/courrier/demandes-queries.ts'
import { EnvelopeForm } from '../../../../modules/courrier/enveloppe-form.tsx'
import { SenderDatalist, SenderForm } from '../../../../modules/courrier/expediteur-form.tsx'
import { senderListId, suggestionsFor } from '../../../../modules/courrier/expediteurs.ts'
import { findSenderSuggestions } from '../../../../modules/courrier/expediteurs-queries.ts'
import { EnvelopeZoom } from '../../../../modules/courrier/enveloppe-zoom.tsx'
import { spotLabel } from '../../../../modules/courrier/reperage.ts'
import {
  mailKindLabels,
  mailScanSideLabels,
  mailStatusLabels,
  mailStatusStyles,
  openingOriginLabels,
} from '../../../../modules/courrier/labels.ts'
import { OpenForm } from '../../../../modules/courrier/open-form.tsx'
import { CorrectPagesForm } from '../../../../modules/courrier/pages-form.tsx'
import { findMail, findMailSpots } from '../../../../modules/courrier/queries.ts'
import { canCorrectPages, canOpen, openingOrigin, scanReportedAt } from '../../../../modules/courrier/regles.ts'

export const metadata = { title: 'Courrier' }

/** « 1,2 Mo », « 340 ko ». */
function formatBytes(bytes: number): string {
  const format = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 })
  return bytes >= 1024 * 1024
    ? `${format.format(bytes / 1024 / 1024)} Mo`
    : `${format.format(Math.max(1, Math.round(bytes / 1024)))} ko`
}

/** Confirmations, après le traitement d'une demande (`?fait=`). */
const notices: Record<string, string> = {
  'prise-en-charge': 'Demande prise en charge. Le client voit que le centre s’en occupe.',
  refus: 'Demande refusée. Le client lit le motif dans son espace ; il est prévenu par courriel.',
  annulation: 'Demande annulée à la demande du client, à votre nom.',
  numerisee: 'Numérisation déposée et demande faite. Le client est prévenu par courriel.',
  reexpediee: 'Réexpédition notée comme faite. Le client est prévenu par courriel.',
  envoi: 'Suivi et frais d’affranchissement enregistrés.',
  enveloppe: 'Photo de l’enveloppe ajoutée. Le client la voit dans son espace.',
}

/** « 1 page », « 12 pages ». */
const pagesLabel = (count: number) => `${count} page${count > 1 ? 's' : ''}`

export default async function CourrierDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ fait?: string; pages?: string }>
}) {
  await requirePermission('courrier.gerer')
  const [{ id }, { fait, pages }] = await Promise.all([params, searchParams])
  const timeZone = await currentTimeZone()
  const [mail, requests, spots] = await Promise.all([
    findMail(id),
    listRequestsForMail(id),
    findMailSpots([id], timeZone),
  ])
  if (!mail) notFound()

  const withdrawn = Boolean(mail.deletedAt)
  // L'expéditeur se précise après coup (ADR 058), sauf pli retiré ou expéditeur anonymisé (ADR 040).
  const senderEditable = !withdrawn && !mail.senderAnonymizedAt
  const suggestions = senderEditable ? await findSenderSuggestions([mail.clientId]) : undefined
  const forwarded = requests.find((request) => request.kind === 'forward' && request.status === 'done')
  const scanOrigin = new Map(requests.map((request) => [request.id, request]))
  // La plus récente : une enveloppe ajoutée après coup remplace la première à l'écran.
  const envelope = mail.scans.filter((scan) => scan.side === 'envelope').at(-1)
  const hasEnvelope = Boolean(envelope)
  const now = new Date()
  const spot = spots.get(mail.id)
  const spotText = spot ? spotLabel(spot, todayIsoDate(timeZone, now)) : null
  const received = formatDateTime(mail.receivedAt, timeZone)

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <div>
        <Link href="/courrier" className="text-sm text-muted-foreground hover:underline">
          ← Courrier
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            {mailKindLabels[mail.kind]} — {mail.sender ?? 'expéditeur non précisé'}
          </h1>
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${mailStatusStyles[mail.status]}`}
          >
            {mailStatusLabels[mail.status]}
          </span>
          {withdrawn && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-foreground">
              Retiré
            </span>
          )}
          {forwarded && (
            <span className="rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground">
              Réexpédié
            </span>
          )}
        </div>
        {withdrawn && (
          <p className="mt-2 text-sm text-muted-foreground">
            Ce courrier a été retiré le {formatDateTime(mail.deletedAt as Date, timeZone)}. Le client
            ne le voit plus et il ne figure plus au relevé des ouvertures.
          </p>
        )}
      </div>

      {fait && notices[fait] && <FlashNotice key={fait}>{notices[fait]}</FlashNotice>}
      {pages === 'corrigees' && (
        <FlashNotice key="pages">Nombre de pages corrigé. Le relevé du mois en tient compte.</FlashNotice>
      )}

      {/* De quoi retrouver le pli dans la pile de l'entreprise (ADR 057). */}
      <div className="flex flex-col gap-4 rounded-lg border border-border bg-white px-5 py-4 sm:flex-row sm:items-start">
        <div className="sm:w-64 sm:shrink-0">
          <EnvelopeZoom
            scanId={envelope?.id ?? null}
            contentType={envelope?.contentType ?? null}
            label={`Enveloppe du pli de ${mail.clientName}, reçu le ${received}`}
            details={[
              mailKindLabels[mail.kind],
              mail.sender ? `de ${mail.sender}` : 'expéditeur non précisé',
              ...(spotText ? [spotText] : []),
            ]}
            size="large"
          />
        </div>
      <dl className="grid flex-1 grid-cols-[11rem_1fr] gap-y-3 text-sm">
        <dt className="text-muted-foreground">Destinataire</dt>
        <dd>
          <Link href={`/clients/${mail.clientId}`} className="underline-offset-2 hover:underline">
            {mail.clientName}
          </Link>
        </dd>

        <dt className="text-muted-foreground">Type</dt>
        <dd>{mailKindLabels[mail.kind]}</dd>

        <dt className="text-muted-foreground">Expéditeur</dt>
        <dd>
          {mail.sender ?? (
            <span className="text-muted-foreground">
              {mail.senderAnonymizedAt ? 'effacé avec les données du client' : 'non précisé'}
            </span>
          )}
          {senderEditable && (
            <a
              href="#expediteur"
              className="ml-2 text-xs font-medium text-primary underline-offset-2 hover:underline"
            >
              {mail.sender ? 'Corriger' : 'Préciser'}
            </a>
          )}
        </dd>

        <dt className="text-muted-foreground">Reçu le</dt>
        <dd className="tabular">
          {received}
          {mail.registeredByName && (
            <span className="text-muted-foreground"> · enregistré par {mail.registeredByName}</span>
          )}
        </dd>

        <dt className="text-muted-foreground">Repère</dt>
        <dd className="tabular">
          {spotText ? (
            <span className="font-medium text-primary">{spotText}</span>
          ) : (
            <span className="text-muted-foreground">— (pli retiré)</span>
          )}
          <span className="block text-xs text-muted-foreground">
            Rang du pli parmi ceux de l’entreprise reçus ce jour-là, dans l’ordre d’enregistrement.
          </span>
        </dd>

        {mail.note && (
          <>
            <dt className="text-muted-foreground">Précision pour le client</dt>
            <dd className="whitespace-pre-line">{mail.note}</dd>
          </>
        )}

        <dt className="text-muted-foreground">Demande d’ouverture</dt>
        <dd className="tabular">
          {mail.openingRequestedAt
            ? `${formatDateTime(mail.openingRequestedAt, timeZone)} par ${mail.requestedBy ?? '—'}`
            : '—'}
        </dd>

        <dt className="text-muted-foreground">Ouverture</dt>
        <dd className="tabular">
          {mail.openedAt ? (
            <>
              {formatDateTime(mail.openedAt, timeZone)} par {mail.openedByName ?? '—'}
              <span className="text-muted-foreground">
                {' '}
                · {openingOriginLabels[openingOrigin(mail)]}
              </span>
            </>
          ) : (
            '—'
          )}
        </dd>
      </dl>
      </div>

      {senderEditable && suggestions && (
        <section
          id="expediteur"
          aria-labelledby="expediteur-titre"
          className="flex flex-col gap-2 rounded-lg border border-border bg-white px-5 py-4"
        >
          <h2 id="expediteur-titre" className="text-sm font-semibold tracking-tight">
            {mail.sender ? 'Corriger l’expéditeur' : 'Préciser l’expéditeur'}
          </h2>
          <SenderDatalist
            id={senderListId(mail.clientId)}
            senders={suggestionsFor(suggestions, mail.clientId)}
          />
          <SenderForm mailItemId={mail.id} sender={mail.sender} listId={senderListId(mail.clientId)} layout="fiche" />
        </section>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold tracking-tight">Numérisations</h2>
        {mail.scans.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Aucune numérisation. Le client voit le pli dans sa liste, sans image.
          </p>
        ) : (
          <ul className="flex flex-wrap gap-3">
            {mail.scans.map((scan) => (
              <li key={scan.id}>
                <a
                  href={`/courrier/scans/${scan.id}`}
                  target="_blank"
                  rel="noopener"
                  className="inline-flex items-center gap-2 rounded-md border border-border bg-white px-4 py-2 text-sm font-medium hover:bg-muted"
                >
                  {mailScanSideLabels[scan.side]}
                  {scan.mailRequestId && scanOrigin.get(scan.mailRequestId)?.kind === 'scan' && (
                    <span className="font-normal"> — numérisation demandée</span>
                  )}
                  <span className="text-xs font-normal text-muted-foreground tabular">
                    {formatDateTime(scan.createdAt, timeZone)} · {formatBytes(scan.byteSize)}
                    {scan.pageCount !== null && ` · ${pagesLabel(scan.pageCount)}`} · nouvel onglet
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
        {mail.scans
          .filter((scan) => scan.side === 'content' && scan.pageCount !== null)
          .map((scan) => {
            const label = `contenu du ${formatDateTime(scan.createdAt, timeZone)}`
            const reportedAt = scanReportedAt(
              scan.mailRequestId ? scanOrigin.get(scan.mailRequestId) : null,
              mail.openedAt,
            )
            // Mois du relevé terminé : il a pu être reporté dans Dolibarr (ADR 046).
            return reportedAt && !canCorrectPages(reportedAt, now, timeZone) ? (
              <p key={scan.id} className="text-sm text-muted-foreground">
                Nombre de pages — {label} : le relevé de{' '}
                {formatIsoMonth(toIsoDate(reportedAt, timeZone).slice(0, 7))} est clos, une erreur se
                corrige dans Dolibarr.
              </p>
            ) : (
              <CorrectPagesForm
                key={scan.id}
                mailItemId={mail.id}
                scanId={scan.id}
                pages={scan.pageCount as number}
                label={label}
              />
            )
          })}
        <p className="text-xs text-muted-foreground">
          Chaque consultation, par le centre comme par le client, est inscrite au journal ci-dessous.
        </p>
      </section>

      {/* Enveloppe à photographier après coup : saisie groupée, pli enregistré sans photo (ADR 055). */}
      {!withdrawn && !hasEnvelope && <EnvelopeForm mailItemId={mail.id} />}

      {/* Un pli réexpédié a quitté le centre : il ne s'ouvre plus ici. */}
      {!withdrawn && !forwarded && canOpen(mail.status) && (
        <OpenForm mailItemId={mail.id} requested={mail.status === 'opening_requested'} />
      )}

      <MailRequestsSection requests={requests} timeZone={timeZone} withdrawn={withdrawn} />

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold tracking-tight">
          Journal des consultations{' '}
          <span className="font-normal text-muted-foreground">({mail.views.length})</span>
        </h2>
        {mail.views.length === 0 ? (
          <p className="text-sm text-muted-foreground">Personne n’a encore consulté ce courrier.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-white">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">Date</th>
                  <th className="px-4 py-3 font-medium">Personne</th>
                  <th className="px-4 py-3 font-medium">Côté</th>
                  <th className="px-4 py-3 font-medium">Numérisation</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {mail.views.map((view) => (
                  <tr key={view.id}>
                    <td className="whitespace-nowrap px-4 py-3 tabular">
                      {formatDateTime(view.viewedAt, timeZone)}
                    </td>
                    <td className="px-4 py-3">{view.name ?? '—'}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {view.viewer === 'staff' ? 'Centre' : 'Client'}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {mailScanSideLabels[view.side]}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {!withdrawn && (
        <form action={withdrawMailAction} className="rounded-lg border border-border bg-white px-5 py-4">
          <input type="hidden" name="id" value={mail.id} />
          <p className="text-sm font-medium text-foreground">Retirer ce courrier</p>
          {/* Suppression logique : la ligne et le journal restent (décision 6). */}
          <p className="mt-1 text-xs text-muted-foreground">
            Pour un pli enregistré par erreur, au mauvais destinataire par exemple. Il disparaît de
            l’espace du client et du relevé des ouvertures ; rien n’est effacé.
          </p>
          <button
            type="submit"
            className="mt-3 rounded-md border border-destructive/30 px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/5"
          >
            Retirer
          </button>
        </form>
      )}
    </div>
  )
}
