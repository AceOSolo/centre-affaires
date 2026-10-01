import { and, asc, desc, eq, gt, isNotNull, isNull, lt, ne, not, sql } from 'drizzle-orm'

import { PG_EXCLUSION_VIOLATION, PG_UNIQUE_VIOLATION, pgErrorCode } from '../../db/errors.ts'
import { withTenant, type Transaction } from '../../db/index.ts'
import { tenants } from '../../db/tenants.ts'
import { todayIsoDate } from '../../lib/dates.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { clients, type Client } from '../clients/schema.ts'
import { subscribedServices } from '../facturation/schema-factures.ts'
import { ratePlans, type RatePlan } from '../facturation/schema.ts'
import { bookings, type Booking } from '../reservations/schema.ts'
import { resources, type Resource } from '../ressources/schema.ts'
import { archiveContractDocument } from './documents.ts'
import { contractRange, formatCalendarDate, type ContractPeriod } from './occupation.ts'
import {
  contracts,
  type BillingPeriod,
  type Contract,
  type ContractStatus,
  type ContractType,
} from './schema.ts'
import {
  alignDraftSubscriptions,
  archiveContractSubscriptions,
  endContractSubscriptions,
  restoreContractSubscriptions,
} from './souscriptions.ts'

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
  /** TVA d'un contrat sans ligne, en points de base ; 20 % par défaut en base. */
  vatRateBp?: number
  /** Engagement en mois (ADR 023) ; nul : sans engagement. */
  commitmentMonths?: number | null
  /** Reconduction tacite, par périodes de `renewalMonths` (les deux ensemble). */
  tacitRenewal?: boolean
  renewalMonths?: number | null
  /** Offre dont le contrat est tiré (ADR 024). */
  offerId?: string | null
}

/** Champs d'engagement et de TVA écrits seulement quand la saisie les porte. */
function termsColumns(input: ContractInput) {
  return {
    ...(input.vatRateBp !== undefined && { vatRateBp: input.vatRateBp }),
    ...(input.commitmentMonths !== undefined && { commitmentMonths: input.commitmentMonths }),
    ...(input.tacitRenewal !== undefined && {
      tacitRenewal: input.tacitRenewal,
      renewalMonths: input.tacitRenewal ? (input.renewalMonths ?? null) : null,
    }),
  }
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

/** Insère un brouillon dans la transaction de l'appelant. */
export async function insertContract(tx: Transaction, input: ContractInput): Promise<Contract> {
  const [created] = await tx
    .insert(contracts)
    .values({
      ...input,
      ...termsColumns(input),
      // `undefined` laisse agir la valeur par défaut de la colonne,
      // `next_contract_reference()` (ADR 021).
      reference: input.reference || undefined,
      currency: input.currency || 'EUR',
      endsOn: input.endsOn || null,
      ratePlanId: input.ratePlanId || null,
      resourceId: input.resourceId || null,
      noticeDays: input.noticeDays ?? 90,
      offerId: input.offerId || null,
    })
    .returning()
  return created
}

/** Une référence saisie à la main, déjà portée : l'erreur du formulaire. */
export function referenceRefusal(error: unknown, reference: string | undefined): unknown {
  // Une référence attribuée par la base n'entre pas en collision : la
  // fonction saute les numéros déjà portés. Seule une saisie manuelle le peut.
  if (pgErrorCode(error) === PG_UNIQUE_VIOLATION && reference) {
    return new DuplicateReferenceError(reference)
  }
  return error
}

export async function createContract(input: ContractInput): Promise<Contract> {
  try {
    return await withTenant(currentTenantId(), (tx) => insertContract(tx, input))
  } catch (error) {
    throw referenceRefusal(error, input.reference)
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
    return await withTenant(currentTenantId(), async (tx) => {
      // Une souscription rattachée au brouillon (actes inclus d'une offre)
      // désigne son client par clé étrangère, archivée comprise : le client
      // ne change plus (ADR 024).
      const [subscribed] = await tx
        .select({ clientId: subscribedServices.clientId })
        .from(subscribedServices)
        .where(eq(subscribedServices.contractId, id))
        .limit(1)
      if (subscribed && subscribed.clientId !== input.clientId) {
        throw new ContractClientLockedError()
      }

      const updated = await tx
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
          ...termsColumns(input),
        })
        .where(
          and(eq(contracts.id, id), eq(contracts.status, 'draft'), isNull(contracts.deletedAt)),
        )
        .returning({ id: contracts.id, startsOn: contracts.startsOn, endsOn: contracts.endsOn })
      if (updated.length === 0) return false
      // Les actes inclus suivent les dates du brouillon.
      await alignDraftSubscriptions(tx, updated[0])
      return true
    })
  } catch (error) {
    if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) {
      throw new DuplicateReferenceError(input.reference)
    }
    throw error
  }
}

/** Levée quand on change le client d'un brouillon qui porte des souscriptions. */
export class ContractClientLockedError extends Error {
  constructor() {
    super(
      'Ce brouillon porte des services souscrits pour son client (actes inclus de l’offre) : il ne change plus de client. Archivez-le et créez un nouveau contrat pour l’autre client.',
    )
    this.name = 'ContractClientLockedError'
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

/** Fuseau du centre, lu dans la transaction : les dates d'un contrat en sont des jours. */
async function centreTimeZone(tx: Transaction): Promise<string | undefined> {
  const [tenant] = await tx
    .select({ timezone: tenants.timezone })
    .from(tenants)
    .where(eq(tenants.id, currentTenantId()))
  return tenant?.timezone
}

/**
 * Ce qui occupe déjà `resourceId` sur la période du contrat, hors sa propre
 * occupation. Reproduit le prédicat de `bookings_no_overlap` : bornes `[)`,
 * annulées exclues. Sert à nommer le conflit, jamais à autoriser l'écriture :
 * c'est la contrainte qui tranche (décision 3).
 */
export async function selectOccupationConflicts(
  tx: Transaction,
  contractId: string,
  candidate: ContractPeriod & { resourceId: string },
): Promise<Booking[]> {
  const timeZone = await centreTimeZone(tx)
  if (!timeZone) return []
  const range = contractRange(candidate, timeZone)
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
 *
 * Un avenant de changement de ressource découpe l'occupation en segments, une
 * ligne chacun (ADR 025) : c'est alors le dernier segment qui est rendu, celui
 * de la ressource la plus récente.
 */
export async function findContractOccupation(contractId: string): Promise<Booking | undefined> {
  const [occupation] = await withTenant(currentTenantId(), (tx) =>
    tx
      .select()
      .from(bookings)
      .where(and(eq(bookings.contractId, contractId), eq(bookings.kind, 'contract')))
      .orderBy(desc(bookings.startsAt))
      .limit(1),
  )
  return occupation
}

/**
 * Passage à l'état actif : le contrat devient facturable et occupe sa
 * ressource (ADR 018). Dans la même transaction, le document du contrat est
 * archivé : l'instantané de ce qui est remis au client, avec son empreinte
 * (ADR 025). Rend `false` si le contrat n'était plus un brouillon.
 *
 * `generatedBy` : le membre de l'équipe qui active ; nul pour un script.
 *
 * @throws ContractOccupationConflictError si la ressource est déjà occupée sur
 * la période : le contrat reste alors en brouillon, sans document.
 */
export async function activateContract(
  id: string,
  generatedBy: string | null = null,
): Promise<boolean> {
  return writeContract(id, async (tx) => {
    const activated = await tx
      .update(contracts)
      .set({ status: 'active' })
      .where(
        and(eq(contracts.id, id), eq(contracts.status, 'draft'), isNull(contracts.deletedAt)),
      )
      .returning({ id: contracts.id })
    if (activated.length === 0) return false
    await archiveContractDocument(tx, { contractId: id, amendmentId: null, generatedBy })
    return true
  })
}

/**
 * Levée quand on veut changer la ressource d'un contrat déjà commencé : son
 * occupation serait réécrite depuis le premier jour (ADR 018). Le message dit
 * quoi faire à la place.
 */
export class ContractAlreadyStartedError extends Error {
  readonly startsOn: string

  constructor(startsOn: string) {
    super(
      `Ce contrat a commencé le ${formatCalendarDate(startsOn)} : sa ressource ne change plus ici. ` +
        'Pour passer sur une autre ressource, établissez un avenant de changement de ressource, à sa date d’effet.',
    )
    this.name = 'ContractAlreadyStartedError'
    this.startsOn = startsOn
  }
}

/**
 * Changement de la ressource d'un contrat en cours qui n'a pas encore
 * commencé : l'occupation suit (ADR 018). `null` retire la ressource et libère
 * l'ancienne.
 *
 * Réservé aux contrats actifs : un brouillon se modifie en entier, et un
 * contrat résilié garde la trace de ce qu'il a occupé. Rend `false` si le
 * contrat n'est pas (ou plus) en cours.
 *
 * Un contrat commencé ne change pas de ressource (`canChangeContractResource`) :
 * l'occupation, réécrite depuis le premier jour, effacerait la période écoulée
 * sur l'ancienne ressource, et la nouvelle serait refusée pour une réservation
 * passée. Le filtre est dans la requête ; la relecture ne sert qu'à le dire.
 *
 * @throws ContractAlreadyStartedError si le contrat a déjà commencé.
 * @throws ContractOccupationConflictError si la nouvelle ressource est occupée.
 */
export async function changeContractResource(
  id: string,
  resourceId: string | null,
): Promise<boolean> {
  return writeContract(
    id,
    async (tx) => {
      const timeZone = await centreTimeZone(tx)
      if (!timeZone) return false
      const changed = await tx
        .update(contracts)
        .set({ resourceId })
        .where(
          and(
            eq(contracts.id, id),
            eq(contracts.status, 'active'),
            isNull(contracts.deletedAt),
            // Le jour du centre, pas celui du serveur (décision 4).
            gt(contracts.startsOn, todayIsoDate(timeZone)),
          ),
        )
        .returning({ id: contracts.id })
      if (changed.length > 0) return true

      const [current] = await tx
        .select({
          status: contracts.status,
          deletedAt: contracts.deletedAt,
          startsOn: contracts.startsOn,
        })
        .from(contracts)
        .where(eq(contracts.id, id))
      if (current?.status === 'active' && current.deletedAt === null) {
        throw new ContractAlreadyStartedError(current.startsOn)
      }
      return false
    },
    { resourceId },
  )
}

/**
 * Archivage : suppression logique (décision 6). Le contrat sort des listes et
 * reste consultable ; son occupation passe à `cancelled` avec le motif
 * « Contrat archivé », ce qui libère la ressource. Son numéro reste porté
 * (ADR 021).
 */
export async function archiveContract(id: string): Promise<boolean> {
  return withTenant(currentTenantId(), async (tx) => {
    const archived = await tx
      .update(contracts)
      .set({ deletedAt: sql`now()` })
      .where(and(eq(contracts.id, id), isNull(contracts.deletedAt)))
      .returning({ id: contracts.id })
    if (archived.length === 0) return false
    // Les actes inclus du contrat sont archivés au même instant (`now()` est
    // celui de la transaction) : le désarchivage les retrouve ainsi.
    await archiveContractSubscriptions(tx, id)
    return true
  })
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
    const restored = await writeContract(id, async (tx) => {
      // Avant de lever l'archivage : les souscriptions se reconnaissent à
      // l'instant d'archivage du contrat.
      await restoreContractSubscriptions(tx, id)
      return tx
        .update(contracts)
        .set({ deletedAt: null })
        .where(and(eq(contracts.id, id), isNotNull(contracts.deletedAt)))
        .returning({ id: contracts.id })
    })
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
 * Résiliation d'un contrat en cours. La ligne est conservée et la date de fin
 * effective est posée : l'échéancier s'arrête là, même si le terme prévu était
 * plus tard.
 *
 * Seul un contrat actif et non archivé se résilie. Un brouillon n'a engagé
 * personne : le résilier le ferait occuper sa ressource jusqu'à la date de
 * résiliation (le prédicat d'occupation retient `terminated`, ADR 018) ; il
 * s'archive. Rend `false` pour tout autre contrat, sans rien écrire.
 *
 * `terminatedOn` et le statut sont écrits ensemble, comme l'exige la contrainte
 * `contracts_terminated_on_consistent`.
 */
export async function terminateContract(
  id: string,
  terminatedOn: string,
  reason?: string | null,
): Promise<boolean> {
  // Une résiliation ne fait que raccourcir l'occupation. Elle n'échoue en
  // conflit que pour un contrat laissé sans occupation à la reprise (ADR 018) :
  // `writeContract` nomme alors ce qui bloque au lieu d'une erreur brute.
  const terminated = await writeContract(
    id,
    async (tx) => {
      const rows = await tx
        .update(contracts)
        .set({
          status: 'terminated',
          terminatedOn,
          terminationReason: reason?.trim() || null,
        })
        .where(
          and(eq(contracts.id, id), eq(contracts.status, 'active'), isNull(contracts.deletedAt)),
        )
        .returning({ id: contracts.id, endsOn: contracts.endsOn })
      // Les actes inclus du contrat prennent fin avec lui (ADR 024), au
      // dernier jour effectif : le plus proche du terme et de la résiliation.
      const [row] = rows
      if (row) {
        const lastDay = row.endsOn && row.endsOn < terminatedOn ? row.endsOn : terminatedOn
        await endContractSubscriptions(tx, id, lastDay)
      }
      return rows
    },
    { terminatedOn },
  )
  return terminated.length > 0
}
