import { and, asc, eq, isNull, sql } from 'drizzle-orm'

import { withTenant } from '../../db/index.ts'
import { tenants, type ProrataRule } from '../../db/tenants.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import type { ScheduleOptions, ScheduleVersion } from './echeancier.ts'
import { contractLines } from './schema.ts'

/**
 * Ce que l'échéancier d'un contrat lit en base (R10, ADR 023, ADR 025) : la
 * règle de prorata du centre et les versions de prix du contrat
 * (`contract_price_versions`), chacune avec ses lignes vivantes. Le calcul
 * reste celui de `billingSchedule()`, pur et testé.
 */
export async function loadContractScheduleOptions(
  contractId: string,
): Promise<Required<ScheduleOptions>> {
  return withTenant(currentTenantId(), async (tx) => {
    const [tenant] = await tx
      .select({ prorataRule: tenants.prorataRule })
      .from(tenants)
      .where(eq(tenants.id, currentTenantId()))
      .limit(1)

    const rows = await tx.execute(sql`
      select amendment_id, amendment_number, starts_on::text as starts_on,
             ends_on::text as ends_on, amount_cents
        from contract_price_versions(${contractId}::uuid)`)

    const lines = await tx
      .select({
        amendmentId: contractLines.amendmentId,
        quantity: contractLines.quantity,
        unitPriceCents: contractLines.unitPriceCents,
        discountBp: contractLines.discountBp,
        discountAmountCents: contractLines.discountAmountCents,
        isRecurring: contractLines.isRecurring,
      })
      .from(contractLines)
      .where(and(eq(contractLines.contractId, contractId), isNull(contractLines.deletedAt)))
      .orderBy(asc(contractLines.position), asc(contractLines.createdAt))

    const versions: ScheduleVersion[] = rows.map((row) => {
      const amendmentId = (row.amendment_id as string | null) ?? null
      return {
        amendmentNumber: (row.amendment_number as number | null) ?? null,
        startsOn: row.starts_on as string,
        endsOn: (row.ends_on as string | null) ?? null,
        amountCents: Number(row.amount_cents),
        // Lignes d'une version : même `amendment_id`, nul pour l'initiale.
        lines: lines.filter((line) => line.amendmentId === amendmentId),
      }
    })

    return { prorataRule: (tenant?.prorataRule ?? 'calendar_days') as ProrataRule, versions }
  })
}
