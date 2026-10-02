import Link from 'next/link'
import { notFound } from 'next/navigation'

import { can } from '../../../../../../lib/auth/permissions.ts'
import { requirePermission } from '../../../../../../lib/auth/staff.ts'
import { emailEnabled } from '../../../../../../lib/courriel.ts'
import { formatDateTime, todayIsoDate } from '../../../../../../lib/dates.ts'
import { currentTimeZone } from '../../../../../../lib/tenant.ts'
import { isUuid } from '../../../../../../lib/uuid.ts'
import { amountDueCents } from '../../../../../../modules/facturation/montants.ts'
import { dunningLevelLabels, type DunningLevel } from '../../../../../../modules/facturation/paiements-regles.ts'
import { PostalReminderButton } from '../../../../../../modules/facturation/postal-reminder-button.tsx'
import { PrintButton } from '../../../../../../modules/facturation/print-button.tsx'
import { reminderChannelLabels } from '../../../../../../modules/facturation/reglements-labels.ts'
import { findReminderContexts, reminderDraft } from '../../../../../../modules/facturation/reglements.ts'
import { listInvoiceReminders } from '../../../../../../modules/facturation/relances.ts'
import { SendReminderButton } from '../../../../../../modules/facturation/send-reminder-button.tsx'
import { formatCents } from '../../../../../../modules/facturation/tarifs.ts'

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
  const [[context], reminders, timeZone] = await Promise.all([
    findReminderContexts([id]),
    listInvoiceReminders(id),
    currentTimeZone(),
  ])
  if (!context || context.invoice.status === 'draft') notFound()

  const today = todayIsoDate(timeZone)
  const { invoice, tenant, recipients } = context
  const draft = reminderDraft(context, today)
  const back = (
    <Link href={`/paiements/factures/${invoice.id}`} className="text-sm text-muted-foreground hover:underline print:hidden">
      ← Règlement de la facture {invoice.number}
    </Link>
  )

  if (!draft) {
    return (
      <div className="flex flex-col gap-4">
        {back}
        <h1 className="text-2xl font-semibold tracking-tight">Relance de la facture {invoice.number}</h1>
        <p className="rounded-lg border border-dashed border-border bg-white px-5 py-4 text-sm text-muted-foreground">
          {amountDueCents(invoice) <= 0
            ? 'Cette facture ne laisse rien à régler : il n’y a pas de relance à faire.'
            : 'Cette facture n’est pas encore échue : la relance se prépare à partir du lendemain de son échéance.'}
        </p>
      </div>
    )
  }

  const canSend = can(member.role, 'paiements.gerer')

  return (
    <div className="flex flex-col gap-6">
      <style>{printStyles}</style>
      <div className="flex flex-col gap-2 print:hidden">
        {back}
        <h1 className="text-2xl font-semibold tracking-tight">Relance de la facture {invoice.number}</h1>
        <p className="text-sm text-muted-foreground">
          {dunningLevelLabels[draft.level]} · datée du jour · à imprimer, ou à envoyer par courriel{' '}
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
          {canSend && <PostalReminderButton invoiceId={invoice.id} />}
        </div>
        {canSend && !emailEnabled() && (
          <p className="text-sm text-muted-foreground">
            L’envoi de courriels n’est pas configuré sur ce serveur : imprimez la lettre.
          </p>
        )}
      </div>

      <section aria-labelledby="relances-titre" className="flex flex-col gap-2 print:hidden">
        <h2 id="relances-titre" className="text-sm font-semibold tracking-tight">
          Relances déjà faites
        </h2>
        {reminders.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Aucune relance inscrite pour cette facture. Un courriel envoyé d’ici s’inscrit seul ; une
            lettre imprimée, notez-la avec « Noter l’envoi par courrier ».
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-white">
            <table aria-labelledby="relances-titre" className="w-full text-left text-sm">
              <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Le</th>
                  <th scope="col" className="px-4 py-3 font-medium">Palier</th>
                  <th scope="col" className="px-4 py-3 font-medium">Envoi</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Reste dû réclamé</th>
                  <th scope="col" className="px-4 py-3 font-medium">Par</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {reminders.map((reminder) => (
                  <tr key={reminder.id}>
                    <td className="whitespace-nowrap px-4 py-3 tabular">{formatDateTime(reminder.sentAt, timeZone)}</td>
                    <td className="px-4 py-3">{dunningLevelLabels[reminder.level as DunningLevel]}</td>
                    <td className="px-4 py-3">
                      {reminderChannelLabels[reminder.channel]}
                      {reminder.recipients.length > 0 && (
                        <span className="block text-xs text-muted-foreground">{reminder.recipients.join(', ')}</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right tabular">
                      {formatCents(reminder.amountDueCents, reminder.currency)}
                    </td>
                    <td className="px-4 py-3">{reminder.sentByName}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <article
        id="lettre-relance"
        aria-labelledby="lettre-objet"
        className="max-w-3xl rounded-2xl border border-border bg-white px-8 py-8 text-sm leading-relaxed"
      >
        <p className="font-semibold">{tenant.legalName ?? tenant.name}</p>
        <h2 id="lettre-objet" className="mt-6 font-semibold">
          Objet : {draft.subject}
        </h2>
        <p className="mt-4 whitespace-pre-line">{draft.text}</p>
      </article>
    </div>
  )
}
