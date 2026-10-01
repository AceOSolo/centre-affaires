import { sql } from 'drizzle-orm'

import type { Transaction } from '../../db/index.ts'

/**
 * Conservation des coordonnées des demandeurs de la page publique (B4,
 * ADR 005, ADR 020).
 *
 * Au terme de la durée du centre (`tenants.public_request_retention_months`),
 * comptée depuis la fin du créneau ou l'annulation si elle précède,
 * `anonymize_expired_public_requests()` (migration 0026) efface le nom,
 * l'adresse et le téléphone du demandeur. La réservation reste : on anonymise,
 * on ne supprime pas (décision 6).
 *
 * Comme pour le journal du courrier, l'application déclenche et la fonction
 * seule choisit quoi effacer, pour le centre courant uniquement. Rend le
 * nombre de demandes anonymisées.
 */
export async function anonymizeExpiredPublicRequests(tx: Transaction): Promise<number> {
  const [row] = await tx.execute<{ anonymized: number }>(
    sql`select anonymize_expired_public_requests() as anonymized`,
  )
  return Number(row?.anonymized ?? 0)
}
