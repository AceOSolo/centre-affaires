import Link from 'next/link'
import { notFound } from 'next/navigation'

import { FlashNotice } from '../../../../components/ui/flash-notice.tsx'
import { requirePermission } from '../../../../lib/auth/staff.ts'
import { formatDateTime } from '../../../../lib/dates.ts'
import { currentTimeZone } from '../../../../lib/tenant.ts'
import { withdrawMailAction } from '../../../../modules/courrier/actions.ts'
import { MailRequestsSection } from '../../../../modules/courrier/demandes-centre.tsx'
import { listRequestsForMail } from '../../../../modules/courrier/demandes-queries.ts'
import {
  mailKindLabels,
  mailScanSideLabels,
  mailStatusLabels,
  mailStatusStyles,
  openingOriginLabels,
} from '../../../../modules/courrier/labels.ts'
import { OpenForm } from '../../../../modules/courrier/open-form.tsx'
import { findMail } from '../../../../modules/courrier/queries.ts'
import { canOpen, openingOrigin } from '../../../../modules/courrier/regles.ts'

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
}

export default async function CourrierDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ fait?: string }>
}) {
  await requirePermission('courrier.gerer')
  const [{ id }, { fait }] = await Promise.all([params, searchParams])
  const [mail, timeZone, requests] = await Promise.all([
    findMail(id),
    currentTimeZone(),
    listRequestsForMail(id),
  ])
  if (!mail) notFound()

  const withdrawn = Boolean(mail.deletedAt)
  const forwarded = requests.find((request) => request.kind === 'forward' && request.status === 'done')
  const scanOrigin = new Map(requests.map((request) => [request.id, request]))

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

      <dl className="grid grid-cols-[11rem_1fr] gap-y-3 rounded-lg border border-border bg-white px-5 py-4 text-sm">
        <dt className="text-muted-foreground">Destinataire</dt>
        <dd>
          <Link href={`/clients/${mail.clientId}`} className="underline-offset-2 hover:underline">
            {mail.clientName}
          </Link>
        </dd>

        <dt className="text-muted-foreground">Reçu le</dt>
        <dd className="tabular">
          {formatDateTime(mail.receivedAt, timeZone)}
          {mail.registeredByName && (
            <span className="text-muted-foreground"> · enregistré par {mail.registeredByName}</span>
          )}
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
                    {formatDateTime(scan.createdAt, timeZone)} · {formatBytes(scan.byteSize)} · nouvel
                    onglet
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">
          Chaque consultation, par le centre comme par le client, est inscrite au journal ci-dessous.
        </p>
      </section>

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
