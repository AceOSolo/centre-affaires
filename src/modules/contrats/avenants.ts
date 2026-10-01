import { and, asc, eq, isNull, sql } from 'drizzle-orm'

import {
  PG_AMENDMENT_INVALID,
  PG_COMMITMENT_LOCKED,
  PG_EXCLUSION_VIOLATION,
  pgErrorCode,
} from '../../db/errors.ts'
import { withTenant } from '../../db/index.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { resources, type Resource } from '../ressources/schema.ts'
import { archiveContractDocument } from './documents.ts'
import { pgRefusalMessage } from './erreurs.ts'
import type { LineDraft } from './lignes.ts'
import { linesRefusal, writeDraftLines } from './lignes-queries.ts'
import { ContractOccupationConflictError, selectOccupationConflicts } from './queries.ts'
import { contractAmendments, contracts, type ContractAmendment } from './schema.ts'
import { selectContractLines, type ContractLineWithTarget } from './versions.ts'

/**
 * Avenants d'un contrat en cours (R12, ADR 025) : un prix ou une ressource qui
 * change à une date d'effet, sans réécrire le contrat.
 *
 * Un avenant naît brouillon, se modifie, puis se signe — ou s'abandonne. La
 * base tient les règles : création sur un contrat en cours seulement, date
 * d'effet après le début et après le dernier avenant signé, avenant qui change
 * quelque chose (`CA005`) ; signé, il est figé (`CA004`). La signature d'un
 * avenant de ressource recalcule l'occupation par segments ; si la nouvelle
 * ressource est prise, la contrainte d'exclusion refuse (`23P01`) et l'avenant
 * reste brouillon.
 *
 * À la signature, le document de l'avenant est archivé dans la même
 * transaction (`contract_documents`).
 */

/** Ce que change le prix d'un avenant. */
export const amendmentPriceModes = ['unchanged', 'amount', 'lines'] as const
export type AmendmentPriceMode = (typeof amendmentPriceModes)[number]

export type AmendmentInput = {
  /** Premier jour de la nouvelle version, jour du centre. */
  effectiveOn: string
  reason: string | null
  /**
   * - `unchanged` : le prix ne change pas ;
   * - `amount` : un nouveau montant par période, sans ligne ;
   * - `lines` : de nouvelles lignes, qui remplacent toutes les précédentes.
   */
  priceMode: AmendmentPriceMode
  amountCents: number | null
  lines: readonly LineDraft[]
  changesResource: boolean
  /** Nouvelle ressource ; nulle avec `changesResource` : la ressource est retirée. */
  resourceId: string | null
}

/** Refus de la base, dit en français : il est affiché tel quel. */
export class AmendmentRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AmendmentRefusedError'
  }
}

function amendmentRefusal(error: unknown): unknown {
  const message = pgRefusalMessage(error, [PG_AMENDMENT_INVALID, PG_COMMITMENT_LOCKED])
  if (message) return new AmendmentRefusedError(message)
  const lines = linesRefusal(error)
  if (lines !== error) return lines
  return error
}

function amendmentColumns(input: AmendmentInput) {
  return {
    effectiveOn: input.effectiveOn,
    reason: input.reason,
    changesResource: input.changesResource,
    resourceId: input.changesResource ? input.resourceId : null,
    // Avec des lignes, la base tient le montant égal à leur somme.
    amountCents: input.priceMode === 'amount' ? input.amountCents : null,
  }
}

/**
 * Établit un avenant brouillon sur un contrat en cours, avec ses lignes.
 *
 * @throws AmendmentRefusedError si le contrat n'est pas en cours (`CA005`).
 */
export async function createAmendment(
  contractId: string,
  input: AmendmentInput,
): Promise<ContractAmendment> {
  try {
    return await withTenant(currentTenantId(), async (tx) => {
      const [created] = await tx
        .insert(contractAmendments)
        .values({ contractId, ...amendmentColumns(input) })
        .returning()
      if (input.priceMode === 'lines') {
        await writeDraftLines(tx, { contractId, amendmentId: created.id }, input.lines)
      }
      const [amendment] = await tx
        .select()
        .from(contractAmendments)
        .where(eq(contractAmendments.id, created.id))
      return amendment
    })
  } catch (error) {
    throw amendmentRefusal(error)
  }
}

/**
 * Modifie un avenant brouillon : date, objet, ressource, prix et lignes.
 * Rend `false` s'il n'est plus un brouillon vivant.
 *
 * Passer des lignes à un montant (ou à « inchangé ») retire les lignes ; le
 * montant écrit ensuite tient, la base ne le recalcule que depuis des lignes.
 */
export async function updateDraftAmendment(
  contractId: string,
  amendmentId: string,
  input: AmendmentInput,
): Promise<boolean> {
  try {
    return await withTenant(currentTenantId(), async (tx) => {
      const [draft] = await tx
        .select({ id: contractAmendments.id })
        .from(contractAmendments)
        .where(
          and(
            eq(contractAmendments.id, amendmentId),
            eq(contractAmendments.contractId, contractId),
            eq(contractAmendments.status, 'draft'),
            isNull(contractAmendments.deletedAt),
          ),
        )
        .for('no key update')
      if (!draft) return false
      await writeDraftLines(
        tx,
        { contractId, amendmentId },
        input.priceMode === 'lines' ? input.lines : [],
      )
      await tx
        .update(contractAmendments)
        .set(amendmentColumns(input))
        .where(eq(contractAmendments.id, amendmentId))
      return true
    })
  } catch (error) {
    throw amendmentRefusal(error)
  }
}

/**
 * Signe un avenant brouillon et archive son document, dans une transaction.
 * Rend la version du document, ou `false` si l'avenant n'est plus un
 * brouillon vivant.
 *
 * @throws AmendmentRefusedError sur une règle de la base (date d'effet,
 * contrat qui n'est plus en cours, avenant qui ne change rien).
 * @throws ContractOccupationConflictError si la nouvelle ressource est prise à
 * partir de la date d'effet : l'avenant reste brouillon.
 */
export async function signAmendment(
  contractId: string,
  amendmentId: string,
  signedBy: string | null,
): Promise<{ documentVersion: number } | false> {
  try {
    return await withTenant(currentTenantId(), async (tx) => {
      const signed = await tx
        .update(contractAmendments)
        .set({ status: 'signed' })
        .where(
          and(
            eq(contractAmendments.id, amendmentId),
            eq(contractAmendments.contractId, contractId),
            eq(contractAmendments.status, 'draft'),
            isNull(contractAmendments.deletedAt),
          ),
        )
        .returning({ id: contractAmendments.id })
      if (signed.length === 0) return false
      const document = await archiveContractDocument(tx, {
        contractId,
        amendmentId,
        generatedBy: signedBy,
      })
      return { documentVersion: document.version }
    })
  } catch (error) {
    if (pgErrorCode(error) === PG_EXCLUSION_VIOLATION) {
      throw await occupationConflict(contractId, amendmentId)
    }
    throw amendmentRefusal(error)
  }
}

/**
 * Ce qui occupe la nouvelle ressource d'un avenant, de sa date d'effet au
 * dernier jour du contrat : la signature a été refusée, l'écran le nomme.
 */
async function occupationConflict(
  contractId: string,
  amendmentId: string,
): Promise<ContractOccupationConflictError> {
  return withTenant(currentTenantId(), async (tx) => {
    const [row] = await tx
      .select({ amendment: contractAmendments, contract: contracts })
      .from(contractAmendments)
      .innerJoin(contracts, eq(contracts.id, contractAmendments.contractId))
      .where(eq(contractAmendments.id, amendmentId))
    const resourceId = row?.amendment.resourceId ?? null
    if (!row || !resourceId) return new ContractOccupationConflictError(resourceId, [])
    const conflicts = await selectOccupationConflicts(tx, contractId, {
      startsOn: row.amendment.effectiveOn,
      endsOn: row.contract.endsOn,
      terminatedOn: row.contract.terminatedOn,
      resourceId,
    })
    return new ContractOccupationConflictError(resourceId, conflicts)
  })
}

/** Abandonne un avenant brouillon (`deleted_at`) : il ne compte plus, et reste lisible. */
export async function abandonAmendment(contractId: string, amendmentId: string): Promise<boolean> {
  const abandoned = await withTenant(currentTenantId(), (tx) =>
    tx
      .update(contractAmendments)
      .set({ deletedAt: sql`now()` })
      .where(
        and(
          eq(contractAmendments.id, amendmentId),
          eq(contractAmendments.contractId, contractId),
          eq(contractAmendments.status, 'draft'),
          isNull(contractAmendments.deletedAt),
        ),
      )
      .returning({ id: contractAmendments.id }),
  )
  return abandoned.length > 0
}

export type AmendmentWithDetails = ContractAmendment & {
  resource: Pick<Resource, 'id' | 'code' | 'name' | 'resourceType'> | null
  lines: ContractLineWithTarget[]
}

/** Avenants d'un contrat, abandonnés compris, par numéro, avec leur ressource et leurs lignes. */
export async function listAmendments(contractId: string): Promise<AmendmentWithDetails[]> {
  return withTenant(currentTenantId(), async (tx) => {
    const rows = await tx
      .select({
        amendment: contractAmendments,
        resource: {
          id: resources.id,
          code: resources.code,
          name: resources.name,
          resourceType: resources.resourceType,
        },
      })
      .from(contractAmendments)
      .leftJoin(resources, eq(resources.id, contractAmendments.resourceId))
      .where(eq(contractAmendments.contractId, contractId))
      .orderBy(asc(contractAmendments.number))
    const lines = await selectContractLines(tx, contractId)
    return rows.map((row) => ({
      ...row.amendment,
      resource: row.resource?.id ? row.resource : null,
      lines: lines.filter((line) => line.amendmentId === row.amendment.id),
    }))
  })
}

/** Un avenant du contrat, avec sa ressource et ses lignes. */
export async function findAmendment(
  contractId: string,
  amendmentId: string,
): Promise<AmendmentWithDetails | undefined> {
  return (await listAmendments(contractId)).find((amendment) => amendment.id === amendmentId)
}
