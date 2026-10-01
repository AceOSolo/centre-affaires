import { and, asc, desc, eq, gt, isNotNull, isNull, lt, ne, not, sql } from 'drizzle-orm'

import { PG_EXCLUSION_VIOLATION, PG_UNIQUE_VIOLATION, pgErrorCode } from '../../db/errors.ts'
import { withTenant, type Transaction } from '../../db/index.ts'
import { tenants } from '../../db/tenants.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { clients, type Client } from '../clients/schema.ts'
import { ratePlans, type RatePlan } from '../facturation/schema.ts'
import { bookings, type Booking } from '../reservations/schema.ts'
import { resources, type Resource } from '../ressources/schema.ts'
import { contractRange, type ContractPeriod } from './occupation.ts'
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

/**
 * Contrats du centre. Les archivés sont exclus par défaut (décision 6) ;
 * `archived: true` ne rend qu'eux, pour les retrouver depuis la liste.
 */
export async function listContracts(
  filters: { status?: ContractStatus; clientId?: string; archived?: boolean } = {},
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
          filters.archived ? isNotNull(contracts.deletedAt) : isNull(contracts.deletedAt),
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
  /**
   * Omise (`undefined`) : la base attribue le numéro suivant de la série du
   * centre, `CT-2026-0001` (ADR 021). Jamais une chaîne vide, refusée en base.
   */
  reference?: string
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
          // `undefined` laisse agir la valeur par défaut de la colonne,
          // `next_contract_reference()` (ADR 021).
          reference: input.reference || undefined,
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
    // Une référence attribuée par la base n'entre pas en collision : la
    // fonction saute les numéros déjà portés. Seule une saisie manuelle le peut.
    if (pgErrorCode(error) === PG_UNIQUE_VIOLATION && input.reference) {
      throw new DuplicateReferenceError(input.reference)
    }
    throw error
  }
}

/**
 * Modification d'un brouillon, avec les mêmes champs que la création (R12).
 *
 * Seul un brouillon se modifie ainsi : un contrat actif engage le centre et le
 * client, ses changements relèvent d'un avenant (vague 2). Rend `false` si le
 * contrat n'est plus un brouillon ou a été archivé : le filtre est dans la
 * requête, pas dans une lecture préalable qu'une écriture concurrente rendrait
 * fausse.
 */
export async function updateDraftContract(
  id: string,
  input: ContractInput & { reference: string },
): Promise<boolean> {
  try {
    const updated = await withTenant(currentTenantId(), (tx) =>
      tx
        .update(contracts)
        .set({
          clientId: input.clientId,
          reference: input.reference,
          contractType: input.contractType,
          startsOn: input.startsOn,
          endsOn: input.endsOn || null,
          billingPeriod: input.billingPeriod,
          amountCents: input.amountCents,
          currency: input.currency || 'EUR',
          ratePlanId: input.ratePlanId || null,
          resourceId: input.resourceId || null,
          noticeDays: input.noticeDays ?? 90,
          notes: input.notes ?? null,
        })
        .where(
          and(eq(contracts.id, id), eq(contracts.status, 'draft'), isNull(contracts.deletedAt)),
        )
        .returning({ id: contracts.id }),
    )
    return updated.length > 0
  } catch (error) {
    if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) {
      throw new DuplicateReferenceError(input.reference)
    }
    throw error
  }
}

/**
 * La ressource du contrat est déjà occupée sur sa période : la contrainte
 * d'exclusion a refusé l'occupation (ADR 018). Porte ce qui occupe la place,
 * pour que l'écran le nomme au lieu d'afficher une erreur SQL.
 */
export class ContractOccupationConflictError extends Error {
  // Champs déclarés puis affectés : le strip de types de Node ne compile pas
  // les paramètres-propriétés.
  readonly resourceId: string | null
  readonly conflicts: Booking[]

  constructor(resourceId: string | null, conflicts: Booking[]) {
    super('La ressource est déjà occupée sur la période du contrat.')
    this.name = 'ContractOccupationConflictError'
    this.resourceId = resourceId
    this.conflicts = conflicts
  }
}

/**
 * Ce qui occupe déjà `resourceId` sur la période du contrat, hors sa propre
 * occupation. Reproduit le prédicat de `bookings_no_overlap` : bornes `[)`,
 * annulées exclues. Sert à nommer le conflit, jamais à autoriser l'écriture :
 * c'est la contrainte qui tranche (décision 3).
 */
async function selectOccupationConflicts(
  tx: Transaction,
  contractId: string,
  candidate: ContractPeriod & { resourceId: string },
): Promise<Booking[]> {
  const [tenant] = await tx
    .select({ timezone: tenants.timezone })
    .from(tenants)
    .where(eq(tenants.id, currentTenantId()))
  if (!tenant) return []
  const range = contractRange(candidate, tenant.timezone)
  return tx
    .select()
    .from(bookings)
    .where(
      and(
        eq(bookings.resourceId, candidate.resourceId),
        ne(bookings.status, 'cancelled'),
        lt(bookings.startsAt, range.endsAt),
        gt(bookings.endsAt, range.startsAt),
        // Parenthèses explicites : `not()` ne les pose pas autour d'un `sql`.
        not(sql`(${bookings.kind} = 'contract' and ${bookings.contractId} = ${contractId})`),
      ),
    )
    .orderBy(asc(bookings.startsAt))
}

/**
 * Écrit un contrat et traduit le refus de son occupation.
 *
 * Le trigger `contracts_sync_occupation` recalcule l'occupation dans la même
 * transaction : un chevauchement fait échouer l'écriture du contrat elle-même
 * (`23P01`). On relit alors, dans une nouvelle transaction, ce qui occupe la
 * ressource visée. `target` porte la ressource ou la date demandée quand elle
 * diffère de celle en base, que le refus a laissée intacte.
 */
async function writeContract<T>(
  id: string,
  write: (tx: Transaction) => Promise<T>,
  target: Partial<Pick<Contract, 'resourceId' | 'terminatedOn'>> = {},
): Promise<T> {
  try {
    return await withTenant(currentTenantId(), write)
  } catch (error) {
    if (pgErrorCode(error) !== PG_EXCLUSION_VIOLATION) throw error
    const [contract] = await withTenant(currentTenantId(), (tx) =>
      tx.select().from(contracts).where(eq(contracts.id, id)).limit(1),
    )
    const candidate = contract ? { ...contract, ...target } : undefined
    const resourceId = candidate?.resourceId ?? null
    const conflicts =
      candidate && resourceId
        ? await withTenant(currentTenantId(), (tx) =>
            selectOccupationConflicts(tx, id, { ...candidate, resourceId }),
          )
        : []
    throw new ContractOccupationConflictError(resourceId, conflicts)
  }
}

/**
 * Occupation de la ressource par ce contrat (ADR 018) : la ligne de `bookings`
 * tenue par le trigger, annulée comprise, car elle dit pourquoi la ressource a
 * été libérée. `undefined` pour un contrat qui n'en a jamais eu.
 */
export async function findContractOccupation(contractId: string): Promise<Booking | undefined> {
  const [occupation] = await withTenant(currentTenantId(), (tx) =>
    tx
      .select()
      .from(bookings)
      .where(and(eq(bookings.contractId, contractId), eq(bookings.kind, 'contract')))
      .limit(1),
  )
  return occupation
}

/**
 * Passage à l'état actif : le contrat devient facturable et occupe sa
 * ressource (ADR 018). Rend `false` si le contrat n'était plus un brouillon.
 *
 * @throws ContractOccupationConflictError si la ressource est déjà occupée sur
 * la période : le contrat reste alors en brouillon.
 */
export async function activateContract(id: string): Promise<boolean> {
  const activated = await writeContract(id, (tx) =>
    tx
      .update(contracts)
      .set({ status: 'active' })
      .where(
        and(eq(contracts.id, id), eq(contracts.status, 'draft'), isNull(contracts.deletedAt)),
      )
      .returning({ id: contracts.id }),
  )
  return activated.length > 0
}

/**
 * Changement de la ressource d'un contrat en cours : l'occupation suit, sur
 * toute la période (ADR 018). `null` retire la ressource et libère l'ancienne.
 *
 * Réservé aux contrats actifs : un brouillon se modifie en entier, et un
 * contrat résilié garde la trace de ce qu'il a occupé.
 *
 * @throws ContractOccupationConflictError si la nouvelle ressource est occupée.
 */
export async function changeContractResource(
  id: string,
  resourceId: string | null,
): Promise<boolean> {
  const changed = await writeContract(
    id,
    (tx) =>
      tx
        .update(contracts)
        .set({ resourceId })
        .where(
          and(eq(contracts.id, id), eq(contracts.status, 'active'), isNull(contracts.deletedAt)),
        )
        .returning({ id: contracts.id }),
    { resourceId },
  )
  return changed.length > 0
}

/**
 * Archivage : suppression logique (décision 6). Le contrat sort des listes et
 * reste consultable ; son occupation passe à `cancelled` avec le motif
 * « Contrat archivé », ce qui libère la ressource. Son numéro reste porté
 * (ADR 021).
 */
export async function archiveContract(id: string): Promise<boolean> {
  const archived = await withTenant(currentTenantId(), (tx) =>
    tx
      .update(contracts)
      .set({ deletedAt: sql`now()` })
      .where(and(eq(contracts.id, id), isNull(contracts.deletedAt)))
      .returning({ id: contracts.id }),
  )
  return archived.length > 0
}

/**
 * Désarchivage : le contrat revient dans les listes et son occupation est
 * rétablie (ADR 018).
 *
 * @throws ContractOccupationConflictError si la ressource a été prise depuis.
 * @throws DuplicateReferenceError si sa référence a été reprise entre-temps.
 */
export async function restoreContract(id: string): Promise<boolean> {
  try {
    const restored = await writeContract(id, (tx) =>
      tx
        .update(contracts)
        .set({ deletedAt: null })
        .where(and(eq(contracts.id, id), isNotNull(contracts.deletedAt)))
        .returning({ id: contracts.id }),
    )
    return restored.length > 0
  } catch (error) {
    if (pgErrorCode(error) !== PG_UNIQUE_VIOLATION) throw error
    const [contract] = await withTenant(currentTenantId(), (tx) =>
      tx.select({ reference: contracts.reference }).from(contracts).where(eq(contracts.id, id)),
    )
    throw new DuplicateReferenceError(contract?.reference ?? '')
  }
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
  // Une résiliation ne fait que raccourcir l'occupation. Elle n'échoue en
  // conflit que pour un contrat laissé sans occupation à la reprise (ADR 018) :
  // `writeContract` nomme alors ce qui bloque au lieu d'une erreur brute.
  await writeContract(
    id,
    (tx) =>
      tx
        .update(contracts)
        .set({
          status: 'terminated',
          terminatedOn,
          terminationReason: reason?.trim() || null,
        })
        .where(and(eq(contracts.id, id), sql`${contracts.status} <> 'terminated'`)),
    { terminatedOn },
  )
}
