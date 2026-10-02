import Link from 'next/link'

import { can, type Permission } from '../../../lib/auth/permissions.ts'
import { requirePermission } from '../../../lib/auth/staff.ts'
import { emailEnabled } from '../../../lib/courriel.ts'
import { formatDateTime } from '../../../lib/dates.ts'
import { currentTenant } from '../../../lib/tenant.ts'
import {
  notificationAudienceLabels,
  notificationDeliveryStatusLabels,
  notificationEventLabels,
  notificationRelatedTypeLabels,
} from '../../../modules/notifications/catalogue.ts'
import { journalHref, parseJournalFilters } from '../../../modules/notifications/journal-filtres.ts'
import { listDeliveries, type DeliveryRow } from '../../../modules/notifications/queries.ts'
import {
  notificationDeliveryStatuses,
  notificationEvents,
  type NotificationDeliveryStatus,
} from '../../../modules/notifications/schema.ts'

export const metadata = { title: 'Messages envoyés' }

const fieldClass =
  'mt-1 w-full rounded-sm border border-border bg-white px-3 py-1.5 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/40 aria-[invalid=true]:border-destructive'

/**
 * Statut d'un envoi : toujours écrit en toutes lettres, la teinte ne fait que
 * l'appuyer. Un échec est un état anormal (rouge désaturé de la charte), un
 * message non envoyé ne l'est pas forcément.
 */
const statusStyles: Record<NotificationDeliveryStatus, string> = {
  sent: 'bg-primary/10 text-primary',
  failed: 'bg-destructive/10 text-destructive',
  not_configured: 'bg-muted text-muted-foreground',
  skipped: 'bg-muted text-muted-foreground',
}

/** Où mène l'entité d'un message, et le droit qu'il faut pour l'ouvrir. */
function relatedLink(row: DeliveryRow): { href: string; permission: Permission } | undefined {
  if (!row.relatedId) return undefined
  switch (row.relatedType) {
    case 'booking':
      return { href: `/reservations/${row.relatedId}`, permission: 'reservations.gerer' }
    case 'invoice':
      return { href: `/factures/${row.relatedId}`, permission: 'facturation.consulter' }
    case 'contract':
      return { href: `/contrats/${row.relatedId}`, permission: 'contrats.consulter' }
    case 'mail_item':
      return { href: `/courrier/${row.relatedId}`, permission: 'courrier.gerer' }
    case 'offer':
      return { href: `/offres/${row.relatedId}`, permission: 'services.gerer' }
    case 'client_member':
      return row.clientId ? { href: `/clients/${row.clientId}`, permission: 'clients.gerer' } : undefined
    default:
      return undefined
  }
}

function countLabel(total: number, filtered: boolean): string {
  const plural = total > 1 ? 's' : ''
  return `${total} message${plural}${filtered ? ` correspondant${plural} aux filtres` : ''}`
}

/**
 * Journal des messages envoyés (R26, ADR 038) : à qui, quand, quoi (l'objet,
 * jamais le corps), et ce qu'il en est advenu. Pour répondre à « le client
 * a-t-il été prévenu ? ».
 */
export default async function NotificationsJournalPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { member } = await requirePermission('notifications.consulter')
  const tenant = await currentTenant()
  const { filters, values, errors } = parseJournalFilters(await searchParams)
  const { rows, total, pageCount } = await listDeliveries(filters, tenant.timezone)
  const page = Math.min(filters.page, pageCount)
  const filtered = Object.values(values).some(Boolean)
  const describedBy = (name: keyof typeof errors) => (errors[name] ? `${name}-error` : undefined)

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Messages envoyés</h1>
          <p className="mt-1 max-w-[70ch] text-sm text-muted-foreground">
            Chaque message prévu par l’application, à un client ou au centre : à qui, quand, son
            objet et son issue. Le texte des messages n’est pas conservé. Le journal est gardé{' '}
            {tenant.notificationLogRetentionMonths} mois, puis effacé chaque nuit.
          </p>
        </div>
        {can(member.role, 'notifications.gerer') && (
          <Link
            href="/notifications/modeles"
            className="rounded-md border border-border bg-white px-4 py-2 text-sm font-medium hover:bg-muted"
          >
            Modèles des messages
          </Link>
        )}
      </div>

      {!emailEnabled() && (
        <p className="rounded-md border border-border bg-white px-4 py-3 text-sm">
          L’envoi de courriels n’est pas configuré sur ce serveur : aucun message ne part, chacun est
          inscrit « {notificationDeliveryStatusLabels.not_configured} ».
        </p>
      )}

      {/* Formulaire GET : les filtres restent dans l'adresse, la liste se partage. */}
      <form
        aria-label="Filtrer les messages"
        className="flex flex-wrap items-start gap-3 rounded-lg border border-border bg-white px-4 py-3"
      >
        <div className="min-w-56">
          <label htmlFor="evenement" className="block text-xs font-medium text-muted-foreground">
            Message
          </label>
          <select
            id="evenement"
            name="evenement"
            defaultValue={filters.event ?? ''}
            aria-invalid={errors.evenement ? true : undefined}
            aria-describedby={describedBy('evenement')}
            className={fieldClass}
          >
            <option value="">Tous les messages</option>
            {notificationEvents.map((event) => (
              <option key={event} value={event}>
                {notificationEventLabels[event]}
              </option>
            ))}
          </select>
          {errors.evenement && (
            <p id="evenement-error" role="alert" className="mt-1 text-xs text-destructive">
              {errors.evenement}
            </p>
          )}
        </div>
        <div>
          <label htmlFor="statut" className="block text-xs font-medium text-muted-foreground">
            Issue
          </label>
          <select
            id="statut"
            name="statut"
            defaultValue={filters.status ?? ''}
            aria-invalid={errors.statut ? true : undefined}
            aria-describedby={describedBy('statut')}
            className={fieldClass}
          >
            <option value="">Toutes</option>
            {notificationDeliveryStatuses.map((status) => (
              <option key={status} value={status}>
                {notificationDeliveryStatusLabels[status]}
              </option>
            ))}
          </select>
          {errors.statut && (
            <p id="statut-error" role="alert" className="mt-1 text-xs text-destructive">
              {errors.statut}
            </p>
          )}
        </div>
        <div>
          <label htmlFor="du" className="block text-xs font-medium text-muted-foreground">
            Du
          </label>
          <input
            id="du"
            name="du"
            type="date"
            defaultValue={values.du}
            aria-invalid={errors.du ? true : undefined}
            aria-describedby={describedBy('du')}
            className={fieldClass}
          />
          {errors.du && (
            <p id="du-error" role="alert" className="mt-1 text-xs text-destructive">
              {errors.du}
            </p>
          )}
        </div>
        <div>
          <label htmlFor="au" className="block text-xs font-medium text-muted-foreground">
            Au
          </label>
          <input
            id="au"
            name="au"
            type="date"
            defaultValue={values.au}
            aria-invalid={errors.au ? true : undefined}
            aria-describedby={describedBy('au')}
            className={fieldClass}
          />
          {errors.au && (
            <p id="au-error" role="alert" className="mt-1 text-xs text-destructive">
              {errors.au}
            </p>
          )}
        </div>
        <div className="min-w-56">
          <label htmlFor="destinataire" className="block text-xs font-medium text-muted-foreground">
            Destinataire (adresse ou partie d’adresse)
          </label>
          <input
            id="destinataire"
            name="destinataire"
            type="search"
            defaultValue={values.destinataire}
            autoComplete="off"
            aria-invalid={errors.destinataire ? true : undefined}
            aria-describedby={describedBy('destinataire')}
            className={fieldClass}
          />
          {errors.destinataire && (
            <p id="destinataire-error" role="alert" className="mt-1 text-xs text-destructive">
              {errors.destinataire}
            </p>
          )}
        </div>
        <div className="flex items-center gap-3 self-end">
          <button
            type="submit"
            className="rounded-md border border-border bg-white px-3 py-1.5 text-sm font-medium hover:bg-muted"
          >
            Filtrer
          </button>
          {filtered && (
            <Link href="/notifications" className="py-1.5 text-sm text-muted-foreground underline underline-offset-2">
              Tout afficher
            </Link>
          )}
        </div>
      </form>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-white px-6 py-12 text-center">
          <p className="text-sm text-muted-foreground">
            {filtered
              ? 'Aucun message ne correspond à ces filtres. Élargissez la période ou retirez un filtre.'
              : 'Aucun message pour l’instant : ils s’inscrivent ici dès qu’un courrier arrive, qu’une facture est émise ou qu’une demande est traitée.'}
          </p>
          {filtered && (
            <Link href="/notifications" className="mt-4 inline-block text-sm underline underline-offset-2">
              Tout afficher
            </Link>
          )}
        </div>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {countLabel(total, filtered)}, du plus récent au plus ancien.
          </p>
          <div className="overflow-x-auto rounded-lg border border-border bg-white">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Messages envoyés, du plus récent au plus ancien</caption>
              <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Date</th>
                  <th scope="col" className="px-4 py-3 font-medium">Message</th>
                  <th scope="col" className="px-4 py-3 font-medium">Destinataires</th>
                  <th scope="col" className="px-4 py-3 font-medium">Objet</th>
                  <th scope="col" className="px-4 py-3 font-medium">Issue</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border align-top">
                {rows.map((row) => {
                  const link = relatedLink(row)
                  const failed = new Set(row.failedRecipients)
                  return (
                    <tr key={row.id}>
                      <td className="whitespace-nowrap px-4 py-3 tabular text-muted-foreground">
                        {formatDateTime(row.sentAt, tenant.timezone)}
                      </td>
                      <td className="px-4 py-3">
                        <p className="font-medium">{notificationEventLabels[row.event]}</p>
                        <p className="text-xs text-muted-foreground">
                          {notificationAudienceLabels[row.audience]}
                          {row.clientName && (
                            <>
                              {' · '}
                              {can(member.role, 'clients.gerer') && row.clientId ? (
                                <Link href={`/clients/${row.clientId}`} className="underline underline-offset-2">
                                  {row.clientName}
                                </Link>
                              ) : (
                                row.clientName
                              )}
                            </>
                          )}
                        </p>
                        {row.relatedType && (
                          <p className="text-xs text-muted-foreground">
                            {link && can(member.role, link.permission) ? (
                              <Link href={link.href} className="underline underline-offset-2">
                                {notificationRelatedTypeLabels[row.relatedType]}
                              </Link>
                            ) : (
                              notificationRelatedTypeLabels[row.relatedType]
                            )}
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {row.recipients.length === 0 ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <ul className="flex flex-col gap-0.5">
                            {row.recipients.map((address) => (
                              <li key={address} className="break-all">
                                {address}
                                {failed.has(address) && (
                                  <span className="ml-1 text-xs font-medium text-destructive">(refusée)</span>
                                )}
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                      <td className="min-w-64 px-4 py-3">{row.subject}</td>
                      <td className="min-w-48 px-4 py-3">
                        <span
                          className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${statusStyles[row.status]}`}
                        >
                          {notificationDeliveryStatusLabels[row.status]}
                        </span>
                        {row.error && <p className="mt-1 text-xs text-muted-foreground">{row.error}</p>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {pageCount > 1 && (
            <nav aria-label="Pages du journal" className="flex flex-wrap items-center gap-4 text-sm">
              {page > 1 ? (
                <Link href={journalHref(values, page - 1)} className="underline underline-offset-2">
                  Plus récents
                </Link>
              ) : null}
              <span className="text-muted-foreground" aria-current="page">
                Page {page} sur {pageCount}
              </span>
              {page < pageCount ? (
                <Link href={journalHref(values, page + 1)} className="underline underline-offset-2">
                  Plus anciens
                </Link>
              ) : null}
            </nav>
          )}
        </>
      )}
    </div>
  )
}
