import { eq } from 'drizzle-orm'

import { withTenant } from '../../db/index.ts'
import { appUrl } from '../../lib/courriel.ts'
import { formatCalendarDate } from '../../lib/dates.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { clients } from '../clients/schema.ts'
import { invoices } from '../facturation/schema-factures.ts'
import { formatCents } from '../facturation/tarifs.ts'
import { notify, type NotificationOutcome, type NotifyOptions } from './moteur.ts'

/**
 * Déclencheurs de la facturation (ADR 026, ADR 030, ADR 038).
 *
 * La facture n'est **jamais** jointe : le message dit qu'elle est disponible
 * et mène à l'espace client, où elle se consulte (ADR 015).
 */

/**
 * Facture ou avoir émis : aux personnes de l'espace du client. Rien pour un
 * brouillon (l'émission a échoué ou n'a pas eu lieu).
 */
export async function notifyInvoiceIssued(
  invoiceId: string,
  options: NotifyOptions = {},
): Promise<NotificationOutcome | null> {
  try {
    const [row] = await withTenant(
      options.tenantId ?? currentTenantId(),
      (tx) =>
        tx
          .select({
            id: invoices.id,
            kind: invoices.kind,
            status: invoices.status,
            number: invoices.number,
            clientId: invoices.clientId,
            clientName: clients.name,
            issueDate: invoices.issueDate,
            dueDate: invoices.dueDate,
            totalInclTaxCents: invoices.totalInclTaxCents,
            currency: invoices.currency,
            deletedAt: invoices.deletedAt,
          })
          .from(invoices)
          .innerJoin(clients, eq(clients.id, invoices.clientId))
          .where(eq(invoices.id, invoiceId)),
      options.database,
    )
    if (!row || row.deletedAt || row.status === 'draft' || !row.number || !row.issueDate) return null
    const creditNote = row.kind !== 'invoice'
    return notify(
      {
        event: 'invoice_issued',
        clientId: row.clientId,
        related: { type: 'invoice', id: row.id },
        values: {
          client: row.clientName,
          document: creditNote ? 'avoir' : 'facture',
          numero: row.number,
          montant: formatCents(row.totalInclTaxCents, row.currency),
          date: formatCalendarDate(row.issueDate),
          // Un avoir ne s'acquitte pas : pas d'échéance à annoncer.
          echeance: !creditNote && row.dueDate ? formatCalendarDate(row.dueDate) : null,
          lien: appUrl('/compte/factures'),
        },
      },
      options,
    )
  } catch (error) {
    console.error('Notification d’émission de facture impossible', error)
    return null
  }
}

/** Ce qu'une relance par courriel envoie : la lettre telle que la facturation l'a écrite. */
export type ReminderMessage = {
  invoiceId: string
  invoiceNumber: string
  clientId: string
  clientName: string
  /** Contacts « destinataire des factures », ou l'adresse de la fiche. */
  recipients: readonly string[]
  amountDueCents: number
  currency: string
  /** Échéance dépassée, jour ISO. */
  dueDate: string
  subject: string
  letter: string
}

/**
 * Relance d'impayé par courriel, par le moteur : modèle du centre autour de
 * la lettre, journal des envois. Les destinataires sont les contacts
 * « factures » du client, pas des accès de l'espace : une relance ne se
 * refuse pas par les préférences. L'issue rendue dit qui l'a reçue — la
 * facturation n'inscrit au journal des relances que ce qui est parti.
 */
export async function sendInvoiceReminder(
  reminder: ReminderMessage,
  options: NotifyOptions = {},
): Promise<NotificationOutcome> {
  return notify(
    {
      event: 'invoice_reminder',
      clientId: reminder.clientId,
      related: { type: 'invoice', id: reminder.invoiceId },
      recipients: { addresses: reminder.recipients.map((email) => ({ email })) },
      values: {
        client: reminder.clientName,
        numero: reminder.invoiceNumber,
        montant: formatCents(reminder.amountDueCents, reminder.currency),
        echeance: formatCalendarDate(reminder.dueDate),
        objet: reminder.subject,
        lettre: reminder.letter,
      },
    },
    options,
  )
}
