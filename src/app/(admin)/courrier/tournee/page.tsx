import Link from 'next/link'

import { FlashNotice } from '../../../../components/ui/flash-notice.tsx'
import { requirePermission } from '../../../../lib/auth/staff.ts'
import { formatDateTime, formatLongDate, formatTime } from '../../../../lib/dates.ts'
import { currentTimeZone } from '../../../../lib/tenant.ts'
import { isUuid } from '../../../../lib/uuid.ts'
import { mailKindLabels } from '../../../../modules/courrier/labels.ts'
import { CloseBatchForm } from '../../../../modules/courrier/tournee-form.tsx'
import {
  batchRecipients,
  findOpenBatch,
  listRecentBatches,
  type BatchRecipients,
} from '../../../../modules/courrier/tournees.ts'

export const metadata = { title: 'Tournée du courrier' }

const plural = (count: number, singular: string, pluralForm = `${singular}s`) =>
  `${count} ${count > 1 ? pluralForm : singular}`

/**
 * Tournée du courrier (ADR 044) : ce qui a été enregistré depuis son
 * ouverture, qui sera prévenu et de quoi, puis la fin de tournée — un seul
 * geste, qui envoie un message à chaque domicilié.
 */
export default async function TourneePage({
  searchParams,
}: {
  searchParams: Promise<{ terminee?: string }>
}) {
  await requirePermission('courrier.gerer')
  const { terminee } = await searchParams
  const closedId = isUuid(terminee) ? terminee : undefined
  const [timeZone, open, recent] = await Promise.all([
    currentTimeZone(),
    findOpenBatch(),
    listRecentBatches(),
  ])
  const [preview, closed] = await Promise.all([
    batchRecipients(open?.id ?? null),
    closedId ? batchRecipients(closedId).catch(() => undefined) : undefined,
  ])

  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <div>
        <Link href="/courrier" className="text-sm text-muted-foreground hover:underline">
          ← Courrier
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Tournée du courrier</h1>
        <p className="mt-1 max-w-[70ch] text-sm text-muted-foreground">
          Enregistrez le courrier du jour, puis terminez la tournée : chaque entreprise reçoit alors
          un seul message, avec le nombre et la nature de ses plis, jamais l’expéditeur. Les
          domiciliés sans courrier en sont prévenus à la première tournée de la journée.
        </p>
      </div>

      {closed && (
        <FlashNotice key={closedId}>
          Tournée terminée. Les messages partent maintenant :{' '}
          {plural(closed.received.length, 'entreprise')} « courrier reçu »
          {closed.none.length > 0 && <>, {plural(closed.none.length, 'domicilié')} « pas de courrier »</>}.
          Le{' '}
          <Link href="/notifications" className="font-medium underline underline-offset-2">
            journal des envois
          </Link>{' '}
          dit ce qui est parti.
        </FlashNotice>
      )}

      {open ? (
        <section aria-labelledby="en-cours" className="flex flex-col gap-4">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 id="en-cours" className="text-base font-semibold tracking-tight">
              Tournée en cours depuis {formatTime(open.openedAt, timeZone)}
              {open.openedByName && (
                <span className="font-normal text-muted-foreground"> — ouverte par {open.openedByName}</span>
              )}
            </h2>
            <Link href="/courrier/nouveau" className="text-sm font-medium text-primary underline-offset-2 hover:underline">
              Enregistrer un autre courrier
            </Link>
          </div>

          {open.items.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border bg-white px-4 py-6 text-sm text-muted-foreground">
              Aucun pli dans cette tournée : les plis enregistrés par erreur en ont été retirés.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border bg-white">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">Plis de la tournée en cours</caption>
                <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-4 py-3 font-medium">Destinataire</th>
                    <th scope="col" className="px-4 py-3 font-medium">Type</th>
                    <th scope="col" className="px-4 py-3 font-medium">Reçu le</th>
                    <th scope="col" className="px-4 py-3 font-medium">Contenu</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {open.items.map((item) => (
                    <tr key={item.id}>
                      <td className="px-4 py-2">
                        <Link href={`/courrier/${item.id}`} className="font-medium underline-offset-2 hover:underline">
                          {item.clientName}
                        </Link>
                      </td>
                      <td className="px-4 py-2 text-muted-foreground">{mailKindLabels[item.kind]}</td>
                      <td className="whitespace-nowrap px-4 py-2 tabular">{formatDateTime(item.receivedAt, timeZone)}</td>
                      <td className="px-4 py-2 text-muted-foreground">
                        {item.opened ? 'Ouvert et numérisé' : 'Fermé'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <Recap preview={preview} timeZone={timeZone} />
          <CloseBatchForm batchId={open.id} label="Terminer la tournée et prévenir les domiciliés" />
        </section>
      ) : (
        <section aria-labelledby="sans-tournee" className="flex flex-col gap-4 rounded-lg border border-border bg-white px-5 py-4">
          <h2 id="sans-tournee" className="text-base font-semibold tracking-tight">
            Aucune tournée en cours
          </h2>
          <p className="max-w-[70ch] text-sm text-muted-foreground">
            Le premier courrier enregistré ouvre la tournée.{' '}
            <Link href="/courrier/nouveau" className="font-medium text-primary underline-offset-2 hover:underline">
              Enregistrer un courrier
            </Link>
            . Si rien n’est arrivé aujourd’hui, signalez-le : les domiciliés en sont prévenus.
          </p>
          <Recap preview={preview} timeZone={timeZone} />
          <CloseBatchForm batchId={null} label="Signaler qu’aucun courrier n’est arrivé" />
        </section>
      )}

      <section aria-labelledby="precedentes" className="flex flex-col gap-3">
        <h2 id="precedentes" className="text-base font-semibold tracking-tight">
          Dernières tournées
        </h2>
        {recent.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aucune tournée terminée pour l’instant.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-white">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Terminée le</th>
                  <th scope="col" className="px-4 py-3 font-medium">Par</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Plis</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Entreprises</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {recent.map((batch) => (
                  <tr key={batch.id}>
                    <td className="whitespace-nowrap px-4 py-2 tabular">
                      {batch.closedAt ? formatDateTime(batch.closedAt, timeZone) : '—'}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">{batch.closedByName ?? '—'}</td>
                    <td className="px-4 py-2 text-right tabular">
                      {batch.itemCount === 0 ? 'Aucun courrier' : batch.itemCount}
                    </td>
                    <td className="px-4 py-2 text-right tabular">{batch.clientCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

/** Ce qui partira à la fin de la tournée, dit avant le geste. */
function Recap({ preview, timeZone }: { preview: BatchRecipients; timeZone: string }) {
  const names = (ids: string[]) => ids.map((id) => preview.clientNames.get(id) ?? id)
  return (
    <div className="rounded-lg border border-border bg-muted px-4 py-3 text-sm">
      <p className="font-medium">À la fin de la tournée du {formatLongDate(preview.day, timeZone)} :</p>
      <ul className="mt-2 flex flex-col gap-1">
        <li>
          {preview.received.length === 0
            ? 'aucune entreprise ne reçoit « courrier reçu » ;'
            : `${plural(preview.received.length, 'entreprise')} ${preview.received.length > 1 ? 'reçoivent' : 'reçoit'} « courrier reçu », avec le nombre et la nature de ses plis ;`}
        </li>
        <li>
          {!preview.firstOfDay
            ? 'les domiciliés sans courrier ont déjà été prévenus par une tournée plus tôt aujourd’hui : rien ne leur est renvoyé.'
            : preview.none.length === 0
              ? 'aucun domicilié sans courrier à prévenir.'
              : `${plural(preview.none.length, 'domicilié')} sans courrier ${preview.none.length > 1 ? 'reçoivent' : 'reçoit'} « pas de courrier aujourd’hui ».`}
        </li>
      </ul>
      {preview.none.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-muted-foreground hover:underline">
            Voir les domiciliés sans courrier
          </summary>
          <p className="mt-1 text-muted-foreground">{names(preview.none).join(', ')}</p>
        </details>
      )}
      <p className="mt-2 text-xs text-muted-foreground">
        Une personne qui a renoncé à ces avis dans ses préférences ne les reçoit pas.
      </p>
    </div>
  )
}
