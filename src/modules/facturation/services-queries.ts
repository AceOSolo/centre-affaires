import { and, asc, count, eq, isNotNull, isNull, sql } from 'drizzle-orm'

import { PG_UNIQUE_VIOLATION, pgErrorCode } from '../../db/errors.ts'
import { withTenant } from '../../db/index.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { isUuid } from '../../lib/uuid.ts'
import { subscribedServices } from './schema-factures.ts'
import { offerItems, offers, services, type Service } from './schema.ts'
import type { ServiceInput } from './services-regles.ts'

/**
 * Catalogue de services (R18, ADR 024) : lecture, création, modification,
 * archivage. Toujours sous `withTenant()` : l'isolation par centre est en RLS.
 */

/**
 * Services du centre. Les archivés sont exclus par défaut (décision 6) ;
 * `archived: true` ne rend qu'eux.
 */
export async function listServices(filters: { archived?: boolean } = {}): Promise<Service[]> {
  return withTenant(currentTenantId(), (tx) =>
    tx
      .select()
      .from(services)
      .where(filters.archived ? isNotNull(services.deletedAt) : isNull(services.deletedAt))
      .orderBy(asc(services.nature), asc(services.name)),
  )
}

/** Tous les services, archivés compris : pour relire une offre ou une souscription. */
export async function listAllServices(): Promise<Service[]> {
  return withTenant(currentTenantId(), (tx) =>
    tx.select().from(services).orderBy(asc(services.nature), asc(services.name)),
  )
}

export async function findService(id: string): Promise<Service | undefined> {
  if (!isUuid(id)) return undefined
  const [service] = await withTenant(currentTenantId(), (tx) =>
    tx.select().from(services).where(eq(services.id, id)).limit(1),
  )
  return service
}

/** Ce qui emploie un service : à dire avant de le modifier ou de l'archiver. */
export type ServiceUsage = {
  /** Souscriptions vivantes, en cours ou à venir. */
  currentSubscriptions: number
  /** Offres actives qui le proposent. */
  activeOffers: number
}

export async function findServiceUsage(id: string, today: string): Promise<ServiceUsage> {
  return withTenant(currentTenantId(), async (tx) => {
    const [subscriptions] = await tx
      .select({ total: count() })
      .from(subscribedServices)
      .where(
        and(
          eq(subscribedServices.serviceId, id),
          isNull(subscribedServices.deletedAt),
          sql`(${subscribedServices.endsOn} is null or ${subscribedServices.endsOn} >= ${today})`,
        ),
      )
    const [offersUsing] = await tx
      .select({ total: sql<number>`count(distinct ${offers.id})::int` })
      .from(offerItems)
      .innerJoin(offers, eq(offers.id, offerItems.offerId))
      .where(
        and(eq(offerItems.serviceId, id), isNull(offerItems.deletedAt), isNull(offers.deletedAt)),
      )
    return {
      currentSubscriptions: subscriptions?.total ?? 0,
      activeOffers: offersUsing?.total ?? 0,
    }
  })
}

/** Levée quand le code est déjà celui d'un autre service vivant du centre. */
export class DuplicateServiceCodeError extends Error {
  constructor(code: string) {
    super(`Le code « ${code} » est déjà celui d’un autre service du catalogue.`)
    this.name = 'DuplicateServiceCodeError'
  }
}

/** Levée quand on modifie un service archivé : il est figé. */
export class ArchivedServiceError extends Error {
  constructor() {
    super('Ce service est archivé : il ne se modifie plus.')
    this.name = 'ArchivedServiceError'
  }
}

function translateUnique(error: unknown, code: string | null): never {
  if (code && pgErrorCode(error) === PG_UNIQUE_VIOLATION) throw new DuplicateServiceCodeError(code)
  throw error
}

export async function createService(input: ServiceInput): Promise<Service> {
  try {
    const [created] = await withTenant(currentTenantId(), (tx) =>
      tx.insert(services).values(input).returning(),
    )
    return created
  } catch (error) {
    translateUnique(error, input.code)
  }
}

/**
 * Modification d'un service vivant. Le prix change pour les prochaines
 * souscriptions et les offres au prix du catalogue ; les souscriptions en
 * cours gardent le prix figé à leur souscription (ADR 024).
 *
 * La nature et un code déjà posé ne changent pas (`readServiceForm`).
 */
export async function updateService(id: string, input: ServiceInput): Promise<void> {
  try {
    await withTenant(currentTenantId(), async (tx) => {
      const [current] = await tx
        .select({ deletedAt: services.deletedAt, code: services.code, nature: services.nature })
        .from(services)
        .where(eq(services.id, id))
        .for('update')
      if (!current) throw new ArchivedServiceError()
      if (current.deletedAt) throw new ArchivedServiceError()
      await tx
        .update(services)
        .set({
          ...input,
          // Ceinture sous les bretelles : le formulaire les fige déjà.
          code: current.code ?? input.code,
          nature: current.nature,
        })
        .where(eq(services.id, id))
    })
  } catch (error) {
    if (error instanceof ArchivedServiceError) throw error
    translateUnique(error, input.code)
  }
}

/**
 * Archivage (décision 6) : le service sort du catalogue et rend son code. Les
 * souscriptions en cours restent facturées à leurs conditions ; les lignes
 * d'offre qui le visent sont signalées sur leur offre.
 */
export async function archiveService(id: string): Promise<boolean> {
  if (!isUuid(id)) return false
  const archived = await withTenant(currentTenantId(), (tx) =>
    tx
      .update(services)
      .set({ deletedAt: sql`now()`, isActive: false })
      .where(and(eq(services.id, id), isNull(services.deletedAt)))
      .returning({ id: services.id }),
  )
  return archived.length > 0
}
