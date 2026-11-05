import { sql } from 'drizzle-orm'

import { tenantContext } from '../../db/contexte.ts'
import type { Transaction } from '../../db/index.ts'
import type { Permission } from '../../lib/auth/permissions.ts'
import { currentTenantId, currentTimeZone } from '../../lib/tenant.ts'
import { listMailRequests } from '../courrier/demandes-queries.ts'
import { pendingRequestStatuses } from '../courrier/demandes-regles.ts'
import { listOfferRequests } from '../facturation/offres-portail.ts'
import { listProposals } from '../facturation/propositions-queries.ts'
import { listPendingRequests } from '../reservations/demandes-queries.ts'
import { STAFF_NOTIFICATION_PANEL_LIMIT, type InboxFeed } from './cloche.ts'
import { buildInboxFeed } from './cloche-liste.ts'

/**
 * La cloche de l'équipe en base (ADR 070) : ce qui reste à traiter, lu dans
 * les files de « Demandes », pour le centre en cours. Chaque file porte son
 * filtre `tenant_id` (décision 1).
 */

/**
 * Ce que la cloche du membre affiche, d'après les droits de son rôle
 * (`permissionsOf`) : réservations, devis et offres avec `demandes.traiter`,
 * courrier avec `courrier.gerer` — les droits des sections de « Demandes ».
 */
export async function inboxFeed(allowed: readonly Permission[], options: { now?: Date } = {}): Promise<InboxFeed> {
  const handlesRequests = allowed.includes('demandes.traiter')
  const handlesMail = allowed.includes('courrier.gerer')
  const [bookings, proposals, offers, mail, timeZone] = await Promise.all([
    handlesRequests ? listPendingRequests() : [],
    handlesRequests ? listProposals({ statuses: ['draft', 'ready'] }) : [],
    handlesRequests ? listOfferRequests() : [],
    handlesMail
      ? listMailRequests(
          { statuses: pendingRequestStatuses },
          { number: 1, size: STAFF_NOTIFICATION_PANEL_LIMIT, newestFirst: true },
        )
      : { rows: [], total: 0 },
    currentTimeZone(),
  ])
  return buildInboxFeed({ bookings, proposals, offers, mail }, timeZone, options.now)
}

/**
 * Purge des notifications de l'ancienne cloche (ADR 059) au terme du journal
 * des messages (`tenants.notification_log_retention_months`, tâche de nuit).
 * Plus rien ne les écrit depuis l'ADR 070 : la tâche vide peu à peu les
 * tables `staff_notifications` et `staff_notification_reads`, en sommeil.
 * Leurs « lu » partent avec elles (clé étrangère en cascade). Rend le nombre
 * de notifications purgées.
 */
export async function purgeExpiredStaffNotifications(tx: Transaction): Promise<number> {
  // Le centre de la transaction en cours, celui de `withTenant()`.
  const tenantId = tenantContext.getStore() ?? currentTenantId()
  const [result] = (await tx.execute(sql`
    delete n from staff_notifications as n
      join tenants as t on t.id = n.tenant_id
     where t.id = ${tenantId}
       and n.created_at < timestampadd(month, -t.notification_log_retention_months, current_timestamp(3))`)) as unknown as [
    { affectedRows?: number },
  ]
  return Number(result?.affectedRows ?? 0)
}
