import { and, eq, inArray, ne } from 'drizzle-orm'

import type { Database } from '../../db/index.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { isUuid } from '../../lib/uuid.ts'
import { inClientSpace, type ClientAccount } from '../clients/comptes.ts'
import { clientBroadcastRecipients, clientBroadcasts } from './schema-diffusion.ts'

/**
 * Un message du centre (ADR 060), lu depuis l'espace client : la cloche y
 * mène (ADR 077). Le courriel ne fait que le porter ; le texte, le même pour
 * tous, est gardé dans `client_broadcasts`.
 *
 * Seulement si l'une des entreprises du compte en est destinataire et que son
 * envoi a eu lieu (tout état sauf « en attente ») : une entreprise ajoutée
 * après coup, ou un message pas encore parti, ne se lit pas.
 */
export async function findBroadcastForAccounts(
  id: string,
  accounts: readonly ClientAccount[],
  database?: Database,
): Promise<{ id: string; subject: string; body: string; sentAt: Date } | undefined> {
  if (accounts.length === 0 || !isUuid(id)) return undefined
  const [row] = await inClientSpace(
    accounts,
    (tx) =>
      tx
        .select({
          id: clientBroadcasts.id,
          subject: clientBroadcasts.subject,
          body: clientBroadcasts.body,
          sentAt: clientBroadcastRecipients.processedAt,
          createdAt: clientBroadcasts.createdAt,
        })
        .from(clientBroadcasts)
        .innerJoin(
          clientBroadcastRecipients,
          and(
            eq(clientBroadcastRecipients.tenantId, clientBroadcasts.tenantId),
            eq(clientBroadcastRecipients.broadcastId, clientBroadcasts.id),
          ),
        )
        .where(
          and(
            eq(clientBroadcasts.tenantId, currentTenantId()),
            eq(clientBroadcasts.id, id),
            inArray(
              clientBroadcastRecipients.clientId,
              accounts.map((account) => account.clientId),
            ),
            ne(clientBroadcastRecipients.status, 'pending'),
          ),
        )
        .limit(1),
    database,
  )
  return row ? { id: row.id, subject: row.subject, body: row.body, sentAt: row.sentAt ?? row.createdAt } : undefined
}
