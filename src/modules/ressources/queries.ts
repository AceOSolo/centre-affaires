import { and, asc, eq, isNull, sql } from 'drizzle-orm'

import { withTenant } from '../../db/index.ts'
import { PG_UNIQUE_VIOLATION, pgErrorCode } from '../../db/errors.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { centreRanges } from './ouverture.ts'
import {
  openingHours,
  resources,
  type Resource,
  type ResourceAttributes,
  type ResourceStatus,
  type ResourceType,
} from './schema.ts'

/** Ressources vivantes du centre, les archivées exclues (décision 6). */
export async function listResources(
  filters: { resourceType?: ResourceType; status?: ResourceStatus } = {},
): Promise<Resource[]> {
  return withTenant(currentTenantId(), (tx) =>
    tx
      .select()
      .from(resources)
      .where(
        and(
          isNull(resources.deletedAt),
          filters.resourceType ? eq(resources.resourceType, filters.resourceType) : undefined,
          filters.status ? eq(resources.status, filters.status) : undefined,
        ),
      )
      .orderBy(asc(resources.resourceType), asc(resources.code)),
  )
}

/**
 * Ressources proposées à la réservation.
 *
 * `maintenance` et `retired` restent affichées dans l'inventaire mais ne sont
 * pas réservables : une salle en travaux ne doit pas apparaître dans le
 * planning comme un créneau libre.
 */
export async function listBookableResources(): Promise<Resource[]> {
  return listResources({ status: 'active' })
}

export async function findResource(id: string): Promise<Resource | undefined> {
  const [resource] = await withTenant(currentTenantId(), (tx) =>
    tx.select().from(resources).where(eq(resources.id, id)).limit(1),
  )
  return resource
}

export type CreateResourceInput = {
  resourceType: ResourceType
  code: string
  name: string
  description?: string | null
  capacity?: number | null
  status?: ResourceStatus
  attributes?: ResourceAttributes[ResourceType]
}

/** Levée quand le code saisi est déjà porté par une ressource active du centre. */
export class DuplicateResourceCodeError extends Error {
  // Voir BookingConflictError : pas de paramètre-propriété, Node ne sait pas
  // les stripper et le module deviendrait intestable.
  readonly code: string

  constructor(code: string) {
    super(`Le code « ${code} » est déjà utilisé par une autre ressource.`)
    this.name = 'DuplicateResourceCodeError'
    this.code = code
  }
}

/**
 * Déclare une ressource, et lui pose aussitôt ses horaires propres (ADR 012).
 *
 * Les deux écritures tiennent dans la même transaction : une ressource ne doit
 * jamais exister sans ses horaires, sinon elle hériterait de ceux du centre le
 * temps d'une requête — exactement l'héritage que l'ADR 012 supprime.
 *
 * Le modèle copié est celui du centre au moment de la création. Un centre sans
 * horaires n'en donne aucun : la ressource naît fermée, visiblement, et c'est
 * préférable à une amplitude inventée.
 */
export async function createResource(input: CreateResourceInput): Promise<Resource> {
  try {
    const created = await withTenant(currentTenantId(), async (tx) => {
      const [resource] = await tx
        .insert(resources)
        .values({
          resourceType: input.resourceType,
          code: input.code,
          name: input.name,
          description: input.description ?? null,
          capacity: input.capacity ?? null,
          status: input.status ?? 'active',
          attributes: input.attributes ?? {},
        })
        .returning()

      const modele = centreRanges(
        await tx
          .select()
          .from(openingHours)
          .where(isNull(openingHours.resourceId)),
      )
      if (modele.length > 0) {
        await tx.insert(openingHours).values(
          modele.map((range) => ({
            resourceId: resource.id,
            weekday: range.weekday,
            opensAt: range.opensAt,
            closesAt: range.closesAt,
          })),
        )
      }

      return resource
    })
    return created
  } catch (error) {
    // L'unicité du code est tenue par un index partiel : la vérifier en amont
    // laisserait passer deux créations simultanées.
    if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) {
      throw new DuplicateResourceCodeError(input.code)
    }
    throw error
  }
}

export async function updateResourceStatus(id: string, status: ResourceStatus): Promise<void> {
  await withTenant(currentTenantId(), (tx) =>
    tx.update(resources).set({ status }).where(eq(resources.id, id)),
  )
}

/**
 * Archivage : suppression logique (décision 6). La ressource sort de
 * l'inventaire mais reste lisible depuis les réservations passées, et son code
 * redevient disponible.
 */
export async function archiveResource(id: string): Promise<void> {
  await withTenant(currentTenantId(), (tx) =>
    tx
      .update(resources)
      .set({ deletedAt: sql`now()`, status: 'retired' })
      .where(and(eq(resources.id, id), isNull(resources.deletedAt))),
  )
}
