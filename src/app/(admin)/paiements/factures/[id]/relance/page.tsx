import Link from 'next/link'
import { notFound } from 'next/navigation'

import { can } from '../../../../../../lib/auth/permissions.ts'
import { requirePermission } from '../../../../../../lib/auth/staff.ts'
import { emailEnabled } from '../../../../../../lib/courriel.ts'
import { todayIsoDate } from '../../../../../../lib/dates.ts'
import { currentTimeZone } from '../../../../../../lib/tenant.ts'
import { isUuid } from '../../../../../../lib/uuid.ts'
import { amountDueCents } from '../../../../../../modules/facturation/montants.ts'
import {
  dunningLevel,
  dunningLevelLabels,
  reminderMessage,
} from '../../../../../../modules/facturation/paiements-regles.ts'
import { PrintButton } from '../../../../../../modules/facturation/print-button.tsx'
import { findReminderContexts } from '../../../../../../modules/facturation/reglements.ts'
import { SendReminderButton } from '../../../../../../modules/facturation/send-reminder-button.tsx'

export const metadata = { title: 'Relance' }

/**
 * Feuille d'impression : seule la lettre sort sur papier, sans la coque du
 * back-office. Une vue imprimable, pas un PDF généré (ADR 026).
 */
const printStyles = `
@media print {
  body * { visibility: hidden; }
  #lettre-relance, #lettre-relance * { visibility: visible; }
  #lettre-relance { position: absolute; inset: 0 auto auto 0; width: 100%; border: 0; padding: 0; }
}
`

/**
 * Relance d'une facture échue (R16, ADR 030) : la lettre au palier que le
 * retard atteint, à imprimer ou à envoyer par courriel. Rien ne part sans ce
 * geste.
 */
export default async function ReminderPage({ params }: { params: Promise<{ id: string }> }) {
  const { member } = await requirePermission('facturation.consulter')
  const { id } = await params
  if (!isUuid(id)) notFound()
  const [context] = await findReminderContexts([id])
  if (!context || context.invoice.status === 'draft') notFound()

  const today = todayIsoDate(await currentTimeZone())
  const { invoice, client, tenant, recipients } = context
  const due = amountDueCents(invoice)
  const level = invoice.dueDate ? dunningLevel(invoice.dueDate, today) : 0
  const back = (
    <Link href={`/paiements/factures/${invoice.id}`} className="text-sm text-muted-foreground hover:underline print:hidden">
      ← Règlement de la facture {invoice.number}
    </Link>
  )

  if (due <= 0 || level === 0 || !invoice.issueDate || !invoice.dueDate) {
    return (
      <div className="flex flex-col gap-4">
        {back}
        <h1 className="text-2xl font-semibold tracking-tight">Relance de la facture {invoice.number}</h1>
        <p className="rounded-lg border border-dashed border-border bg-white px-5 py-4 text-sm text-muted-foreground">
          {due <= 0
            ? 'Cette facture ne laisse rien à régler : il n’y a pas de relance à faire.'
            : 'Cette facture n’est pas encore échue : la relance se prépare à partir du lendemain de son échéance.'}
        </p>
      </div>
    )
  }

  const message = reminderMessage({
    sellerName: tenant.legalName ?? tenant.name,
    clientName: client.name,
    invoiceNumber: invoice.number as string,
    issueDate: invoice.issueDate,
    dueDate: invoice.dueDate,
    today,
    amountDueCents: due,
    currency: invoice.currency,
    level,
    expectedPaymentMethod: invoice.expectedPaymentMethod,
    bankIban: tenant.bankIban,
    bankBic: tenant.bankBic,
    latePaymentPenaltyText: invoice.legalMentions?.latePaymentPenaltyText ?? tenant.latePaymentPenaltyText,
    recoveryIndemnityCents: invoice.legalMentions?.recoveryIndemnityCents ?? tenant.recoveryIndemnityCents,
  })
  const canSend = can(member.role, 'paiements.gerer')

  return (
    <div className="flex flex-col gap-6">
      <style>{printStyles}</style>
      <div className="flex flex-col gap-2 print:hidden">
        {back}
        <h1 className="text-2xl font-semibold tracking-tight">Relance de la facture {invoice.number}</h1>
        <p className="text-sm text-muted-foreground">
          {dunningLevelLabels[level]} · datée du jour · à imprimer, ou à envoyer par courriel{' '}
          {recipients.length > 0
            ? `à ${recipients.join(', ')}`
            : '(aucune adresse : ni contact « destinataire des factures », ni courriel sur la fiche)'}
          .
        </p>
        <div className="flex flex-wrap items-start gap-3 pt-1">
          <PrintButton label="Imprimer la lettre" />
          {canSend && emailEnabled() && recipients.length > 0 && (
            <SendReminderButton invoiceId={invoice.id} recipients={recipients} />
          )}
        </div>
        {canSend && !emailEnabled() && (
          <p className="text-sm text-muted-foreground">
            L’envoi de courriels n’est pas configuré sur ce serveur : imprimez la lettre.
          </p>
        )}
      </div>

      <article
        id="lettre-relance"
        aria-labelledby="lettre-objet"
        className="max-w-3xl rounded-2xl border border-border bg-white px-8 py-8 text-sm leading-relaxed"
      >
        <p className="font-semibold">{tenant.legalName ?? tenant.name}</p>
        <h2 id="lettre-objet" className="mt-6 font-semibold">
          Objet : {message.subject}
        </h2>
        <p className="mt-4 whitespace-pre-line">{message.text}</p>
      </article>
    </div>
  )
}
