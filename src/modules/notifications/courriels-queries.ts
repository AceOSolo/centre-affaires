import { and, desc, eq } from 'drizzle-orm'

import { withTenant, type Database } from '../../db/index.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { notificationDeliveries, type NotificationEvent } from './schema.ts'

/** Échecs montrés par l'encart « Courriels » de Réglages (ADR 059) ; le journal a le reste. */
export const RECENT_FAILURES_LIMIT = 5

export type RecentFailure = {
  id: string
  event: NotificationEvent
  subject: string
  error: string | null
  failedCount: number
  sentAt: Date
}

/**
 * Derniers envois en échec du journal des messages (ADR 038) : ce que le
 * serveur SMTP a refusé, avec sa cause lisible (`explainSmtpError`). Jamais
 * les adresses : l'encart dit combien, le journal dit qui.
 */
export async function listRecentFailures(
  options: { database?: Database; tenantId?: string; limit?: number } = {},
): Promise<RecentFailure[]> {
  const tenantId = options.tenantId ?? currentTenantId()
  const rows = await withTenant(
    tenantId,
    (tx) =>
      tx
        .select({
          id: notificationDeliveries.id,
          event: notificationDeliveries.event,
          subject: notificationDeliveries.subject,
          error: notificationDeliveries.error,
          failedRecipients: notificationDeliveries.failedRecipients,
          sentAt: notificationDeliveries.sentAt,
        })
        .from(notificationDeliveries)
        .where(and(eq(notificationDeliveries.tenantId, tenantId), eq(notificationDeliveries.status, 'failed')))
        .orderBy(desc(notificationDeliveries.sentAt), desc(notificationDeliveries.id))
        .limit(options.limit ?? RECENT_FAILURES_LIMIT),
    options.database,
  )
  return rows.map(({ failedRecipients, ...row }) => ({ ...row, failedCount: failedRecipients.length }))
}
