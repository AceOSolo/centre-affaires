import { asc, desc, eq, inArray, sql } from 'drizzle-orm'

import { withTenant, type Transaction } from '../../db/index.ts'
import { staffMembers } from '../../db/staff.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { isUuid } from '../../lib/uuid.ts'
import type { DunningLevel } from './paiements-regles.ts'
import { invoiceReminders, type InvoiceReminder, type ReminderChannel } from './schema-factures.ts'

/**
 * Journal des relances d'impayés (R16, ADR 030, ADR 034) : chaque relance
 * faite par l'équipe y est inscrite — par courriel, dans la transaction de son
 * envoi ; par courrier, quand l'équipe note qu'elle est partie. Il dit, sur la
 * liste des impayés et sur la lettre, ce qui a déjà été réclamé, quand, et à
 * qui.
 */

export type ReminderInput = {
  invoiceId: string
  level: Exclude<DunningLevel, 0>
  channel: ReminderChannel
  /** Adresses de courriel ; vide pour un courrier. */
  recipients: readonly string[]
  amountDueCents: number
  currency: string
  /** Objet et texte de la lettre, tels qu'ils partent. */
  subject: string
  body: string
  sentBy: string
}

/**
 * Inscrit une relance. À appeler dans la transaction de l'envoi : un courriel
 * qui ne part pas n'est pas inscrit.
 */
export async function recordReminder(tx: Transaction, input: ReminderInput): Promise<InvoiceReminder> {
  const [row] = await tx
    .insert(invoiceReminders)
    .values({ ...input, recipients: [...input.recipients] })
    .returning()
  return row
}

export type ReminderEntry = InvoiceReminder & { sentByName: string }

/** Relances d'une facture, la plus ancienne d'abord, avec le nom de qui les a faites. */
export async function listInvoiceReminders(invoiceId: string): Promise<ReminderEntry[]> {
  if (!isUuid(invoiceId)) return []
  const rows = await withTenant(currentTenantId(), (tx) =>
    tx
      .select({
        reminder: invoiceReminders,
        name: sql<string>`coalesce(${staffMembers.fullName}, ${staffMembers.email})`,
      })
      .from(invoiceReminders)
      .innerJoin(staffMembers, eq(staffMembers.id, invoiceReminders.sentBy))
      .where(eq(invoiceReminders.invoiceId, invoiceId))
      .orderBy(asc(invoiceReminders.sentAt), asc(invoiceReminders.id)),
  )
  return rows.map(({ reminder, name }) => ({ ...reminder, sentByName: name }))
}

export type LastReminder = Pick<InvoiceReminder, 'level' | 'channel' | 'sentAt'>

/** Dernière relance de chaque facture citée ; absente : aucune. */
export async function lastRemindersFor(invoiceIds: readonly string[]): Promise<Map<string, LastReminder>> {
  const ids = [...new Set(invoiceIds.filter(isUuid))]
  if (ids.length === 0) return new Map()
  const rows = await withTenant(currentTenantId(), (tx) =>
    tx
      .selectDistinctOn([invoiceReminders.invoiceId], {
        invoiceId: invoiceReminders.invoiceId,
        level: invoiceReminders.level,
        channel: invoiceReminders.channel,
        sentAt: invoiceReminders.sentAt,
      })
      .from(invoiceReminders)
      .where(inArray(invoiceReminders.invoiceId, ids))
      .orderBy(invoiceReminders.invoiceId, desc(invoiceReminders.sentAt), desc(invoiceReminders.id)),
  )
  return new Map(rows.map(({ invoiceId, ...last }) => [invoiceId, last]))
}
