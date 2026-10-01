import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm'

import { withTenant, type Transaction } from '../../db/index.ts'
import { PG_UNIQUE_VIOLATION, pgErrorCode } from '../../db/errors.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { hasCapacity, mergeAttributes, type ResourceAttributesFor } from './attributs.ts'
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
  attributes?: ResourceAttributesFor[ResourceType]
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
      const numero = lockerNumber(input.resourceType, input.attributes)
      if (numero) await assertLockerNumberFree(tx, numero)

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

/** Levée quand le numéro saisi est déjà porté par un autre casier du centre. */
export class DuplicateLockerNumberError extends Error {
  readonly numero: string

  constructor(numero: string) {
    super(`Le casier n° ${numero} existe déjà.`)
    this.name = 'DuplicateLockerNumberError'
    this.numero = numero
  }
}

/** Numéro d'un casier, ou `undefined` pour tout autre type. */
function lockerNumber(
  resourceType: ResourceType,
  attributes: object | undefined,
): string | undefined {
  if (resourceType !== 'casier') return undefined
  const numero = (attributes as { numero?: unknown } | undefined)?.numero
  return typeof numero === 'string' && numero.trim() ? numero.trim() : undefined
}

/**
 * Deux casiers vivants ne portent pas le même numéro, à la casse près.
 *
 * Vérifié dans la transaction qui écrit, faute d'index unique sur
 * `attributes->>'numero'` : deux saisies strictement simultanées pourraient
 * encore passer. Le risque est accepté pour un écran de back-office ; l'index
 * est demandé pour la prochaine migration.
 */
async function assertLockerNumberFree(
  tx: Transaction,
  numero: string,
  exceptId?: string,
): Promise<void> {
  const [taken] = await tx
    .select({ id: resources.id })
    .from(resources)
    .where(
      and(
        eq(resources.resourceType, 'casier'),
        isNull(resources.deletedAt),
        sql`lower(${resources.attributes} ->> 'numero') = lower(${numero})`,
        exceptId ? ne(resources.id, exceptId) : undefined,
      ),
    )
    .limit(1)
  if (taken) throw new DuplicateLockerNumberError(numero)
}

/** Ce que l'écran de modification change. Le type, lui, ne change pas. */
export type UpdateResourceInput = {
  code: string
  name: string
  description: string | null
  capacity: number | null
  status: ResourceStatus
  attributes: ResourceAttributesFor[ResourceType]
}

/**
 * Modification d'une ressource vivante (R01), dans une transaction ouverte.
 *
 * La ligne est verrouillée le temps de fusionner les attributs : deux
 * modifications simultanées ne doivent pas s'écraser en relisant chacune
 * l'ancien JSONB. Rend `undefined` pour une ressource absente ou archivée —
 * une ressource archivée reste lisible, pas modifiable (décision 6).
 */
export async function writeResourceUpdate(
  tx: Transaction,
  id: string,
  input: UpdateResourceInput,
): Promise<Resource | undefined> {
  const [existing] = await tx
    .select()
    .from(resources)
    .where(and(eq(resources.id, id), isNull(resources.deletedAt)))
    .limit(1)
    .for('update')
  if (!existing) return undefined

  const attributes = mergeAttributes(
    existing.resourceType,
    existing.attributes as Record<string, unknown>,
    input.attributes as Record<string, unknown>,
  )
  const numero = lockerNumber(existing.resourceType, attributes)
  if (numero) await assertLockerNumberFree(tx, numero, id)

  const [updated] = await tx
    .update(resources)
    .set({
      code: input.code,
      name: input.name,
      description: input.description,
      capacity: hasCapacity(existing.resourceType) ? input.capacity : null,
      status: input.status,
      attributes: attributes as ResourceAttributes[ResourceType],
    })
    .where(eq(resources.id, id))
    .returning()
  return updated
}

/** Modification d'une ressource ; le code reste unique dans le centre. */
export async function updateResource(
  id: string,
  input: UpdateResourceInput,
): Promise<Resource | undefined> {
  try {
    return await withTenant(currentTenantId(), (tx) => writeResourceUpdate(tx, id, input))
  } catch (error) {
    // Même garde que la création : l'index partiel tranche, pas une lecture.
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
