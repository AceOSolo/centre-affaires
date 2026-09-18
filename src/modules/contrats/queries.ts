import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm'

import { PG_UNIQUE_VIOLATION, pgErrorCode } from '../../db/errors.ts'
import { withTenant } from '../../db/index.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { clients, type Client } from '../clients/schema.ts'
import { ratePlans, type RatePlan } from '../facturation/schema.ts'
import { resources, type Resource } from '../ressources/schema.ts'
import {
  contracts,
  type BillingPeriod,
  type Contract,
  type ContractStatus,
  type ContractType,
} from './schema.ts'

/** Un contrat et ce qu'il désigne, tel que les écrans l'affichent. */
export type ContractWithRelations = Contract & {
  client: Client
  ratePlan: RatePlan | null
  resource: Resource | null
}

const selection = {
  contract: contracts,
  client: clients,
  ratePlan: ratePlans,
  resource: resources,
}

const hydrate = (row: {
  contract: Contract
  client: Client
  ratePlan: RatePlan | null
  resource: Resource | null
}): ContractWithRelations => ({
  ...row.contract,
  client: row.client,
  ratePlan: row.ratePlan,
  resource: row.resource,
})

export async function listContracts(
  filters: { status?: ContractStatus; clientId?: string } = {},
): Promise<ContractWithRelations[]> {
  const rows = await withTenant(currentTenantId(), (tx) =>
    tx
      .select(selection)
      .from(contracts)
      .innerJoin(clients, eq(clients.id, contracts.clientId))
      .leftJoin(ratePlans, eq(ratePlans.id, contracts.ratePlanId))
      .leftJoin(resources, eq(resources.id, contracts.resourceId))
      .where(
        and(
          isNull(contracts.deletedAt),
          filters.status ? eq(contracts.status, filters.status) : undefined,
          filters.clientId ? eq(contracts.clientId, filters.clientId) : undefined,
        ),
      )
      .orderBy(desc(contracts.startsOn), asc(contracts.reference)),
  )
  return rows.map(hydrate)
}

export async function findContract(id: string): Promise<ContractWithRelations | undefined> {
  const [row] = await withTenant(currentTenantId(), (tx) =>
    tx
      .select(selection)
      .from(contracts)
      .innerJoin(clients, eq(clients.id, contracts.clientId))
      .leftJoin(ratePlans, eq(ratePlans.id, contracts.ratePlanId))
      .leftJoin(resources, eq(resources.id, contracts.resourceId))
      .where(eq(contracts.id, id))
      .limit(1),
  )
  return row ? hydrate(row) : undefined
}

export type ContractInput = {
  clientId: string
  reference: string
  contractType: ContractType
  startsOn: string
  endsOn?: string | null
  billingPeriod: BillingPeriod
  amountCents: number
  currency?: string
  ratePlanId?: string | null
  resourceId?: string | null
  noticeDays?: number
  notes?: string | null
}

/** Levée quand la référence saisie est déjà portée par un contrat du centre. */
export class DuplicateReferenceError extends Error {
  readonly reference: string

  constructor(reference: string) {
    super(`La référence « ${reference} » est déjà utilisée par un autre contrat.`)
    this.name = 'DuplicateReferenceError'
    this.reference = reference
  }
}

export async function createContract(input: ContractInput): Promise<Contract> {
  try {
    const [created] = await withTenant(currentTenantId(), (tx) =>
      tx
        .insert(contracts)
        .values({
          ...input,
          currency: input.currency || 'EUR',
          endsOn: input.endsOn || null,
          ratePlanId: input.ratePlanId || null,
          resourceId: input.resourceId || null,
          noticeDays: input.noticeDays ?? 90,
        })
        .returning(),
    )
    return created
  } catch (error) {
    if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) {
      throw new DuplicateReferenceError(input.reference)
    }
    throw error
  }
}

/** Passage à l'état actif : le contrat devient facturable. */
export async function activateContract(id: string): Promise<void> {
  await withTenant(currentTenantId(), (tx) =>
    tx
      .update(contracts)
      .set({ status: 'active' })
      .where(and(eq(contracts.id, id), eq(contracts.status, 'draft'))),
  )
}

/**
 * Résiliation. La ligne est conservée et la date de fin effective est posée :
 * l'échéancier s'arrête là, même si le terme prévu était plus tard.
 *
 * `terminatedOn` et le statut sont écrits ensemble, comme l'exige la contrainte
 * `contracts_terminated_on_consistent`.
 */
export async function terminateContract(
  id: string,
  terminatedOn: string,
  reason?: string | null,
): Promise<void> {
  await withTenant(currentTenantId(), (tx) =>
    tx
      .update(contracts)
      .set({
        status: 'terminated',
        terminatedOn,
        terminationReason: reason?.trim() || null,
      })
      .where(and(eq(contracts.id, id), sql`${contracts.status} <> 'terminated'`)),
  )
}
