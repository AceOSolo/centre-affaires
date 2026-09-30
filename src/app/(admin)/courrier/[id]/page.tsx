import Link from 'next/link'
import { notFound } from 'next/navigation'

import { formatDateTime } from '../../../../lib/dates.ts'
import { currentTimeZone } from '../../../../lib/tenant.ts'
import { withdrawMailAction } from '../../../../modules/courrier/actions.ts'
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

export default async function CourrierDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const [mail, timeZone] = await Promise.all([findMail(id), currentTimeZone()])
  if (!mail) notFound()

  const withdrawn = Boolean(mail.deletedAt)

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
        </div>
        {withdrawn && (
          <p className="mt-2 text-sm text-muted-foreground">
            Ce courrier a été retiré le {formatDateTime(mail.deletedAt as Date, timeZone)}. Le client
            ne le voit plus et il ne figure plus au relevé des ouvertures.
          </p>
        )}
      </div>

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
                  <span className="text-xs font-normal text-muted-foreground">
                    {formatBytes(scan.byteSize)} · nouvel onglet
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

      {!withdrawn && canOpen(mail.status) && (
        <OpenForm mailItemId={mail.id} requested={mail.status === 'opening_requested'} />
      )}

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
