import Link from 'next/link'

import { MailIcon } from '../../../components/ui/icons.tsx'
import { requirePermission } from '../../../lib/auth/staff.ts'
import { formatDateTime } from '../../../lib/dates.ts'
import { currentTenant } from '../../../lib/tenant.ts'
import { listBroadcasts } from '../../../modules/notifications/diffusion.ts'
import { broadcastProgress, broadcastTargetLabels } from '../../../modules/notifications/diffusion-regles.ts'

export const metadata = { title: 'Messages aux domiciliés' }

const PAGE_SIZE = 50

const progressLabels = { done: 'Terminé', running: 'En cours', stalled: 'Interrompu' } as const

/**
 * Messages aux domiciliés (ADR 060), rayon Domiciliation : l'historique des
 * messages libres envoyés aux clients — date, auteur, destinataires, échecs
 * —, et l'accès au nouveau message.
 */
export default async function MessagesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requirePermission('notifications.diffuser')
  const params = await searchParams
  const page = Math.max(1, Number.parseInt(String(params.page ?? '1'), 10) || 1)
  const [tenant, { rows, total }] = await Promise.all([
    currentTenant(),
    listBroadcasts({ number: page, size: PAGE_SIZE }),
  ])
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const now = new Date()

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Messages aux domiciliés</h1>
          <p className="mt-1 max-w-[70ch] text-sm text-muted-foreground">
            Un message libre — fermeture, travaux, nouveau service — envoyé par courriel aux personnes de
            l’espace client de chaque entreprise : les domiciliés, les clients des bureaux, ou une
            sélection. Chaque envoi est inscrit au journal des messages ; les personnes qui ont décoché
            « Informations du centre » ne le reçoivent pas.
          </p>
        </div>
        <Link
          href="/messages/nouveau"
          className="inline-flex min-h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-white transition-colors duration-150 ease-out hover:bg-primary-hover"
        >
          <MailIcon size={20} />
          Nouveau message
        </Link>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-white px-6 py-12 text-center">
          <MailIcon size={24} className="mx-auto text-muted-foreground" />
          <p className="mt-3 text-sm text-muted-foreground">
            Aucun message envoyé pour l’instant. Prévenez tous les domiciliés d’une fermeture ou de
            travaux avec « Nouveau message » : l’aperçu dit à combien de personnes il partira avant
            l’envoi.
          </p>
        </div>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {total} message{total > 1 ? 's' : ''}, du plus récent au plus ancien.
          </p>
          <div className="overflow-x-auto rounded-lg border border-border bg-white">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Messages envoyés aux clients, du plus récent au plus ancien</caption>
              <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Date</th>
                  <th scope="col" className="px-4 py-3 font-medium">Objet</th>
                  <th scope="col" className="px-4 py-3 font-medium">Destinataires</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Entreprises</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Envoyés</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Échecs</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Non envoyés</th>
                  <th scope="col" className="px-4 py-3 font-medium">Auteur</th>
                  <th scope="col" className="px-4 py-3 font-medium">État</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border align-top">
                {rows.map((row) => {
                  const progress = broadcastProgress(row.tally, row.lastActivity, now)
                  return (
                    <tr key={row.id}>
                      <td className="whitespace-nowrap px-4 py-3 tabular text-muted-foreground">
                        {formatDateTime(row.createdAt, tenant.timezone)}
                      </td>
                      <td className="min-w-64 px-4 py-3">
                        <Link href={`/messages/${row.id}`} className="font-medium text-primary underline-offset-2 hover:underline">
                          {row.subject}
                        </Link>
                      </td>
                      <td className="px-4 py-3">{broadcastTargetLabels[row.target]}</td>
                      <td className="px-4 py-3 text-right tabular">{row.tally.companies}</td>
                      <td className="px-4 py-3 text-right tabular">{row.tally.sent}</td>
                      <td className="px-4 py-3 text-right tabular">
                        {row.tally.failed > 0 ? (
                          <span className="font-medium text-destructive">{row.tally.failed}</span>
                        ) : (
                          0
                        )}
                      </td>
                      <td className="px-4 py-3 text-right tabular">{row.tally.skipped + row.tally.notConfigured}</td>
                      <td className="px-4 py-3">{row.author}</td>
                      <td className="whitespace-nowrap px-4 py-3">
                        {progressLabels[progress]}
                        {progress !== 'done' && (
                          <span className="block text-xs text-muted-foreground tabular">
                            {row.tally.companies - row.tally.pending} sur {row.tally.companies}
                          </span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <nav aria-label="Pages de l’historique" className="flex items-center justify-between gap-2 text-sm">
              {page > 1 ? (
                <Link href={`/messages?page=${page - 1}`} className="rounded-md border border-border bg-white px-3 py-1.5 hover:bg-muted">
                  ← Plus récents
                </Link>
              ) : (
                <span />
              )}
              <span className="tabular text-muted-foreground">
                Page {Math.min(page, pages)} sur {pages}
              </span>
              {page < pages ? (
                <Link href={`/messages?page=${page + 1}`} className="rounded-md border border-border bg-white px-3 py-1.5 hover:bg-muted">
                  Plus anciens →
                </Link>
              ) : (
                <span />
              )}
            </nav>
          )}
        </>
      )}
    </div>
  )
}
