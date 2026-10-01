import { and, eq, inArray, isNull, sql } from 'drizzle-orm'

import {
  PG_CHECK_VIOLATION,
  PG_COMMITMENT_LOCKED,
  PG_FOREIGN_KEY_VIOLATION,
  pgErrorCode,
} from '../../db/errors.ts'
import { withTenant, type Transaction } from '../../db/index.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { pgRefusalMessage } from './erreurs.ts'
import { sameLine, targetColumns, targetOf, type LineDraft } from './lignes.ts'
import { contractLines, contracts } from './schema.ts'

/**
 * Écriture des lignes d'un brouillon (R12, ADR 025) : celles de la version
 * initiale d'un contrat brouillon, ou celles d'un avenant brouillon.
 *
 * Le formulaire envoie l'état voulu, complet : chaque ligne connue est mise à
 * jour si elle a changé, chaque nouvelle est insérée, et celles qui manquent
 * sont retirées (`deleted_at`, jamais supprimées : décision 6). La base tient
 * le montant de la version égal à la somme de ses lignes récurrentes, et
 * refuse d'écrire hors brouillon (`CA004`).
 */

/** Le refus de la base, dit en français : brouillon engagé, ligne incohérente. */
export class ContractLinesRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ContractLinesRefusedError'
  }
}

/**
 * Aligne les lignes vivantes d'une version de brouillon sur `lines`, dans la
 * transaction de l'appelant. La position de chaque ligne est son rang.
 *
 * @throws ContractLinesRefusedError si une ligne inconnue est désignée.
 */
export async function writeDraftLines(
  tx: Transaction,
  target: { contractId: string; amendmentId: string | null },
  lines: readonly LineDraft[],
): Promise<void> {
  const existing = await tx
    .select()
    .from(contractLines)
    .where(
      and(
        eq(contractLines.contractId, target.contractId),
        target.amendmentId === null
          ? isNull(contractLines.amendmentId)
          : eq(contractLines.amendmentId, target.amendmentId),
        isNull(contractLines.deletedAt),
      ),
    )
  const byId = new Map(existing.map((line) => [line.id, line]))
  const kept = new Set(lines.flatMap((line) => (line.id ? [line.id] : [])))

  const removed = existing.filter((line) => !kept.has(line.id)).map((line) => line.id)
  if (removed.length > 0) {
    await tx
      .update(contractLines)
      .set({ deletedAt: sql`now()` })
      .where(inArray(contractLines.id, removed))
  }

  const inserts: (typeof contractLines.$inferInsert)[] = []
  for (const [position, line] of lines.entries()) {
    const values = {
      ...targetColumns(line.target),
      description: line.description,
      quantity: line.quantity,
      unit: line.unit,
      unitPriceCents: line.unitPriceCents,
      discountBp: line.discountBp,
      discountAmountCents: line.discountAmountCents,
      vatRateBp: line.vatRateBp,
      isRecurring: line.isRecurring,
      position,
    }
    if (!line.id) {
      inserts.push({
        ...values,
        contractId: target.contractId,
        amendmentId: target.amendmentId,
        offerItemId: line.offerItemId,
      })
      continue
    }
    const current = byId.get(line.id)
    if (!current) {
      throw new ContractLinesRefusedError(
        'Une ligne a été retirée entre-temps : rechargez la page avant de recommencer.',
      )
    }
    const unchanged =
      current.position === position && sameLine(line, { ...current, target: targetOf(current) })
    if (!unchanged) {
      await tx.update(contractLines).set(values).where(eq(contractLines.id, line.id))
    }
  }
  // Une seule instruction pour les nouvelles lignes.
  if (inserts.length > 0) await tx.insert(contractLines).values(inserts)
}

/** Traduit un refus de la base sur des lignes ; rend l'erreur intacte sinon. */
export function linesRefusal(error: unknown): unknown {
  const locked = pgRefusalMessage(error, [PG_COMMITMENT_LOCKED])
  if (locked) return new ContractLinesRefusedError(locked)
  if (pgErrorCode(error) === PG_FOREIGN_KEY_VIOLATION) {
    return new ContractLinesRefusedError(
      'Une ligne vise une ressource, un service ou une offre introuvable : choisissez son objet à nouveau.',
    )
  }
  if (pgErrorCode(error) === PG_CHECK_VIOLATION) {
    return new ContractLinesRefusedError(
      'Une ligne est incohérente : une remise ne peut pas dépasser le montant de la ligne.',
    )
  }
  return error
}

/**
 * Lignes de la version initiale d'un contrat brouillon (R12) : le montant du
 * contrat en découle. Rend `false` si le contrat n'est plus un brouillon non
 * archivé : le filtre est relu sous verrou, dans la transaction qui écrit.
 *
 * @throws ContractLinesRefusedError sur un refus de la base.
 */
export async function saveDraftContractLines(
  contractId: string,
  lines: readonly LineDraft[],
): Promise<boolean> {
  try {
    return await withTenant(currentTenantId(), async (tx) => {
      const [draft] = await tx
        .select({ id: contracts.id })
        .from(contracts)
        .where(
          and(
            eq(contracts.id, contractId),
            eq(contracts.status, 'draft'),
            isNull(contracts.deletedAt),
          ),
        )
        .for('no key update')
      if (!draft) return false
      await writeDraftLines(tx, { contractId, amendmentId: null }, lines)
      return true
    })
  } catch (error) {
    throw linesRefusal(error)
  }
}
