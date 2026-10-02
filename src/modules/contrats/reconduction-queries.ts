import { and, asc, eq, isNotNull, isNull } from 'drizzle-orm'

import { PG_EXCLUSION_VIOLATION, pgErrorCode } from '../../db/errors.ts'
import { withTenant, type Transaction } from '../../db/index.ts'
import { formatCalendarDate } from '../../lib/dates.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { tacitRenewalTerm } from './reconduction.ts'
import { contractRenewals, contracts, type ContractRenewal } from './schema.ts'

/**
 * Reconduction tacite des contrats (R10, ADR 023, ADR 033), côté base : la
 * tâche nocturne du serveur (`/api/maintenance/contrats`) inscrit chaque
 * reconduction acquise — nouveau terme, et une ligne au journal
 * `contract_renewals`.
 */

export type RenewedContract = {
  contractId: string
  reference: string
  previousEndsOn: string
  newEndsOn: string
}

export type RenewalFailure = { contractId: string; reference: string; message: string }

export type RenewalReport = { renewed: RenewedContract[]; failures: RenewalFailure[] }

/**
 * Prolonge les contrats en cours, à reconduction tacite et non résiliés, dont
 * la reconduction est acquise au jour `today` (jour du centre). Un contrat à
 * la fois, chacun dans son point de reprise : si sa ressource est déjà prise
 * après le terme (la contrainte d'exclusion refuse l'occupation prolongée),
 * il garde son terme et le bilan le nomme ; les autres sont prolongés.
 *
 * Rejouable : un contrat déjà prolongé n'est plus dû avant sa prochaine
 * échéance de préavis.
 */
export async function renewTacitContracts(tx: Transaction, today: string): Promise<RenewalReport> {
  const candidates = await tx
    .select({
      id: contracts.id,
      reference: contracts.reference,
      endsOn: contracts.endsOn,
      renewalMonths: contracts.renewalMonths,
      noticeDays: contracts.noticeDays,
      commitmentEndsOn: contracts.commitmentEndsOn,
    })
    .from(contracts)
    .where(
      and(
        eq(contracts.status, 'active'),
        isNull(contracts.deletedAt),
        eq(contracts.tacitRenewal, true),
        isNotNull(contracts.endsOn),
        isNotNull(contracts.renewalMonths),
        isNull(contracts.terminatedOn),
      ),
    )
    .orderBy(asc(contracts.reference), asc(contracts.id))

  const report: RenewalReport = { renewed: [], failures: [] }
  for (const contract of candidates) {
    if (!contract.endsOn || !contract.renewalMonths) continue
    const previousEndsOn = contract.endsOn
    const newEndsOn = tacitRenewalTerm(
      {
        endsOn: previousEndsOn,
        renewalMonths: contract.renewalMonths,
        noticeDays: contract.noticeDays,
        commitmentEndsOn: contract.commitmentEndsOn,
      },
      today,
    )
    if (!newEndsOn) continue
    try {
      const written = await tx.transaction(async (savepoint) => {
        // Le terme lu est celui qu'on prolonge : modifié entre-temps, on passe.
        const updated = await savepoint
          .update(contracts)
          .set({ endsOn: newEndsOn })
          .where(and(eq(contracts.id, contract.id), eq(contracts.endsOn, previousEndsOn)))
          .returning({ id: contracts.id })
        if (updated.length === 0) return false
        await savepoint
          .insert(contractRenewals)
          .values({ contractId: contract.id, previousEndsOn, newEndsOn, renewedOn: today })
        return true
      })
      if (written) report.renewed.push({ contractId: contract.id, reference: contract.reference, previousEndsOn, newEndsOn })
    } catch (error) {
      report.failures.push({
        contractId: contract.id,
        reference: contract.reference,
        message:
          pgErrorCode(error) === PG_EXCLUSION_VIOLATION
            ? `Reconduction impossible : la ressource du contrat est déjà occupée après le ${formatCalendarDate(previousEndsOn)}. Libérez-la, ou résiliez le contrat à son terme.`
            : `Reconduction impossible : ${error instanceof Error ? error.message : 'erreur inattendue'}.`,
      })
    }
  }
  return report
}

/** Reconductions tacites d'un contrat, dans l'ordre. */
export async function listContractRenewals(contractId: string): Promise<ContractRenewal[]> {
  return withTenant(currentTenantId(), (tx) =>
    tx
      .select()
      .from(contractRenewals)
      .where(eq(contractRenewals.contractId, contractId))
      .orderBy(asc(contractRenewals.newEndsOn)),
  )
}
