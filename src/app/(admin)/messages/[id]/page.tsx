import Link from 'next/link'
import { notFound } from 'next/navigation'

import { FlashNotice } from '../../../../components/ui/flash-notice.tsx'
import { CheckIcon, ClockIcon, TriangleAlertIcon, XIcon } from '../../../../components/ui/icons.tsx'
import { can } from '../../../../lib/auth/permissions.ts'
import { requirePermission } from '../../../../lib/auth/staff.ts'
import { formatDateTime } from '../../../../lib/dates.ts'
import { currentTenant } from '../../../../lib/tenant.ts'
import { isUuid } from '../../../../lib/uuid.ts'
import { resumeBroadcastAction } from '../../../../modules/notifications/diffusion-actions.ts'
import { RefreshWhileSending } from '../../../../modules/notifications/diffusion-avancement.tsx'
import { findBroadcast } from '../../../../modules/notifications/diffusion.ts'
import {
  BROADCAST_BATCH_SIZE,
  broadcastProgress,
  broadcastRecipientStatusLabels,
  broadcastTargetLabels,
  type BroadcastRecipientStatus,
} from '../../../../modules/notifications/diffusion-regles.ts'

export const metadata = { title: 'Message aux clients' }

/** L'issue se lit au texte et à l'icône ; la teinte ne fait que l'appuyer. */
const statusStyles: Record<BroadcastRecipientStatus, string> = {
  pending: 'bg-muted text-muted-foreground',
  sent: 'bg-primary/10 text-primary',
  failed: 'bg-destructive/10 text-destructive',
  not_configured: 'bg-muted text-muted-foreground',
  skipped: 'bg-muted text-muted-foreground',
}
const statusIcons: Record<BroadcastRecipientStatus, typeof CheckIcon> = {
  pending: ClockIcon,
  sent: CheckIcon,
  failed: TriangleAlertIcon,
  not_configured: XIcon,
  skipped: XIcon,
}

/**
 * Un message aux clients (ADR 060) : son texte, l'avancement de l'envoi par
 * paquets, et l'issue entreprise par entreprise — envoyé, échec, ou non
 * envoyé avec sa raison (préférence coupée, aucun accès).
 */
export default async function MessagePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { member } = await requirePermission('notifications.diffuser')
  const [{ id }, query] = await Promise.all([params, searchParams])
  if (!isUuid(id)) notFound()
  const [broadcast, tenant] = await Promise.all([findBroadcast(id), currentTenant()])
  if (!broadcast) notFound()
  const { tally } = broadcast
  const progress = broadcastProgress(tally, broadcast.lastActivity, new Date())
  const served = tally.companies - tally.pending
  const linkClients = can(member.role, 'clients.gerer')

  return (
    <div className="flex flex-col gap-6">
      <RefreshWhileSending active={progress === 'running'} />
      <div>
        <Link href="/messages" className="text-sm text-muted-foreground underline-offset-2 hover:underline">
          Messages aux domiciliés
        </Link>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight break-words">{broadcast.subject}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {broadcastTargetLabels[broadcast.target]} · envoyé le{' '}
          <span className="tabular">{formatDateTime(broadcast.createdAt, tenant.timezone)}</span> par{' '}
          {broadcast.author}
        </p>
      </div>

      {query.envoi === 'lance' && (
        <FlashNotice>
          Envoi lancé vers {tally.companies} entreprise{tally.companies > 1 ? 's' : ''}, par paquets de{' '}
          {BROADCAST_BATCH_SIZE} : cette page suit son avancement.
        </FlashNotice>
      )}
      {query.envoi === 'repris' && <FlashNotice>Envoi repris : les entreprises déjà servies ne reçoivent rien de plus.</FlashNotice>}

      <section aria-labelledby="avancement" className="flex flex-col gap-3 rounded-lg border border-border bg-white px-5 py-4">
        <h2 id="avancement" className="text-base font-semibold tracking-tight">
          Avancement
        </h2>
        <p aria-live="polite" className="flex items-start gap-2 text-sm">
          {progress === 'done' ? (
            <>
              <CheckIcon size={20} className="shrink-0 text-primary" />
              <span>
                Terminé
                {broadcast.completedAt && (
                  <> le <span className="tabular">{formatDateTime(broadcast.completedAt, tenant.timezone)}</span></>
                )}
                {' '}: {tally.companies} entreprise{tally.companies > 1 ? 's' : ''} traitée{tally.companies > 1 ? 's' : ''}.
              </span>
            </>
          ) : progress === 'running' ? (
            <>
              <ClockIcon size={20} className="shrink-0 text-primary" />
              <span>
                En cours : <span className="tabular">{served}</span> entreprise{served > 1 ? 's' : ''} sur{' '}
                <span className="tabular">{tally.companies}</span>. La page se met à jour d’elle-même.
              </span>
            </>
          ) : (
            <>
              <TriangleAlertIcon size={20} className="shrink-0 text-primary" />
              <span>
                Interrompu : <span className="tabular">{served}</span> entreprise{served > 1 ? 's' : ''} sur{' '}
                <span className="tabular">{tally.companies}</span>, rien n’a bougé depuis plusieurs minutes (le
                serveur a pu redémarrer). Reprenez l’envoi : celles déjà servies ne recevront rien de plus.
              </span>
            </>
          )}
        </p>
        {progress === 'stalled' && (
          <form action={resumeBroadcastAction}>
            <input type="hidden" name="id" value={broadcast.id} />
            <button
              type="submit"
              className="inline-flex min-h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-white transition-colors duration-150 ease-out hover:bg-primary-hover"
            >
              Reprendre l’envoi
            </button>
          </form>
        )}
        <dl className="grid gap-3 text-sm sm:grid-cols-3 lg:grid-cols-6">
          <Figure label="Entreprises" value={tally.companies} />
          <Figure label="Envoyés" value={tally.sent} />
          <Figure label="Échecs" value={tally.failed} />
          <Figure label="Non envoyés" value={tally.skipped + tally.notConfigured} />
          <Figure label="Adresses servies" value={tally.addresses} />
          <Figure label="Adresses refusées" value={tally.failedAddresses} />
        </dl>
        <p className="text-xs text-muted-foreground">
          Chaque envoi est aussi au{' '}
          <Link href="/notifications?evenement=client_broadcast" className="underline underline-offset-2">
            journal des messages
          </Link>
          , avec ses adresses.
        </p>
      </section>

      <section aria-labelledby="texte" className="rounded-lg border border-border bg-white px-5 py-4">
        <h2 id="texte" className="text-base font-semibold tracking-tight">
          Texte saisi
        </h2>
        <p className="mt-2 max-w-[75ch] whitespace-pre-wrap break-words rounded-md bg-muted px-3 py-2 text-sm leading-relaxed">
          {broadcast.body}
        </p>
      </section>

      <section aria-labelledby="entreprises" className="flex flex-col gap-3">
        <h2 id="entreprises" className="text-base font-semibold tracking-tight">
          Entreprise par entreprise
        </h2>
        <div className="overflow-x-auto rounded-lg border border-border bg-white">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Issue de l’envoi pour chaque entreprise</caption>
            <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">Entreprise</th>
                <th scope="col" className="px-4 py-3 font-medium">Issue</th>
                <th scope="col" className="px-4 py-3 text-right font-medium">Adresses</th>
                <th scope="col" className="px-4 py-3 font-medium">Raison</th>
                <th scope="col" className="px-4 py-3 font-medium">Heure</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border align-top">
              {broadcast.recipients.map((recipient) => {
                const Icon = statusIcons[recipient.status]
                return (
                  <tr key={recipient.clientId}>
                    <td className="px-4 py-3 font-medium">
                      {linkClients ? (
                        <Link href={`/clients/${recipient.clientId}`} className="underline-offset-2 hover:underline">
                          {recipient.clientName}
                        </Link>
                      ) : (
                        recipient.clientName
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <span
                        className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${statusStyles[recipient.status]}`}
                      >
                        <Icon size={16} />
                        {broadcastRecipientStatusLabels[recipient.status]}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right tabular">
                      {recipient.status === 'pending' ? '—' : recipient.addressCount}
                      {recipient.failedCount > 0 && (
                        <span className="block text-xs text-destructive">dont {recipient.failedCount} refusée{recipient.failedCount > 1 ? 's' : ''}</span>
                      )}
                    </td>
                    <td className="min-w-64 px-4 py-3 text-muted-foreground">{recipient.error ?? '—'}</td>
                    <td className="whitespace-nowrap px-4 py-3 tabular text-muted-foreground">
                      {recipient.processedAt ? formatDateTime(recipient.processedAt, tenant.timezone) : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

function Figure({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md bg-muted px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold tabular">{value}</dd>
    </div>
  )
}
