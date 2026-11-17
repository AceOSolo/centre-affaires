import Link from 'next/link'
import { notFound } from 'next/navigation'

import { formatDateTime } from '../../../../../lib/dates.ts'
import { currentTenant } from '../../../../../lib/tenant.ts'
import { requireClientAccount } from '../../../../../modules/clients/session.ts'
import { findBroadcastForAccounts } from '../../../../../modules/notifications/diffusion-compte-queries.ts'

export const metadata = { title: 'Message du centre' }

/**
 * Un message de l'équipe à ses clients (ADR 060), lu depuis l'espace : la
 * cloche y mène (ADR 077). Le texte est celui envoyé par courriel, tel quel,
 * sans mise en forme ; seules les entreprises destinataires le lisent.
 */
export default async function MessageDuCentrePage({ params }: { params: Promise<{ id: string }> }) {
  const { accounts } = await requireClientAccount()
  const { id } = await params
  const [message, tenant] = await Promise.all([findBroadcastForAccounts(id, accounts), currentTenant()])
  if (!message) notFound()

  return (
    <article className="flex max-w-[65ch] flex-col gap-4">
      <Link href="/compte" className="inline-flex min-h-11 items-center self-start text-sm text-muted-foreground hover:underline">
        ← Mon espace
      </Link>
      <div>
        <p className="text-sm text-muted-foreground">Message de {tenant.name}</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-primary sm:text-3xl">{message.subject}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Envoyé le <time dateTime={message.sentAt.toISOString()}>{formatDateTime(message.sentAt, tenant.timezone)}</time>
        </p>
      </div>
      <div className="whitespace-pre-line rounded-2xl border border-border bg-white p-4 text-base leading-relaxed sm:p-6">
        {message.body}
      </div>
      <p className="text-sm text-muted-foreground">
        Pour ne plus recevoir ces messages par courriel, décochez « Informations du centre » dans{' '}
        <Link href="/compte/preferences" className="font-medium text-primary underline-offset-2 hover:underline">
          vos notifications
        </Link>
        .
      </p>
    </article>
  )
}
