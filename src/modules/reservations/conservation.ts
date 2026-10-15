import { sql } from 'drizzle-orm'

import type { Transaction } from '../../db/index.ts'

/**
 * Conservation des coordonnées des demandeurs de la page publique (B4,
 * ADR 005, ADR 020).
 *
 * Au terme de la durée du centre (`tenants.public_request_retention_months`),
 * comptée depuis la fin du créneau ou l'annulation si elle précède,
 * `anonymize_expired_public_requests()` (`src/db/regles/20-reservations.sql`)
 * efface le nom, l'adresse et le téléphone du demandeur. La réservation
 * reste : on anonymise, on ne supprime pas (décision 6).
 *
 * Comme pour le journal du courrier, l'application déclenche et la procédure
 * seule choisit quoi effacer, pour le centre courant uniquement. Rend le
 * nombre de demandes anonymisées (par un paramètre `OUT`, lu dans la même
 * connexion : la transaction).
 */
export async function anonymizeExpiredPublicRequests(tx: Transaction): Promise<number> {
  await tx.execute(sql`call anonymize_expired_public_requests(@anonymized_public_requests)`)
  const [rows] = (await tx.execute(sql`select @anonymized_public_requests as anonymized`)) as unknown as [
    { anonymized: number | string | null }[],
  ]
  return Number(rows[0]?.anonymized ?? 0)
}
