import { and, asc, eq, isNull, or, sql } from 'drizzle-orm'

import { PG_UNIQUE_VIOLATION, pgErrorCode } from '../../db/errors.ts'
import { withTenant } from '../../db/index.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { clients, type Client, type ClientStatus } from './schema.ts'

/** Clients vivants du centre, les supprimés exclus (décision 6). */
export async function listClients(
  filters: { status?: ClientStatus; search?: string } = {},
): Promise<Client[]> {
  const search = filters.search?.trim()
  return withTenant(currentTenantId(), (tx) =>
    tx
      .select()
      .from(clients)
      .where(
        and(
          isNull(clients.deletedAt),
          filters.status ? eq(clients.status, filters.status) : undefined,
          search
            ? or(
                sql`${clients.name} ilike ${`%${search}%`}`,
                sql`${clients.siret} ilike ${`%${search}%`}`,
                sql`${clients.city} ilike ${`%${search}%`}`,
              )
            : undefined,
        ),
      )
      .orderBy(asc(clients.name)),
  )
}

export async function findClient(id: string): Promise<Client | undefined> {
  const [client] = await withTenant(currentTenantId(), (tx) =>
    tx.select().from(clients).where(eq(clients.id, id)).limit(1),
  )
  return client
}

export type ClientInput = {
  name: string
  legalForm?: string | null
  siret?: string | null
  vatNumber?: string | null
  email?: string | null
  phone?: string | null
  addressLine1?: string | null
  addressLine2?: string | null
  postalCode?: string | null
  city?: string | null
  country?: string
  status?: ClientStatus
  notes?: string | null
}

/** Levée quand le SIRET saisi identifie déjà un autre client du centre. */
export class DuplicateSiretError extends Error {
  readonly siret: string

  constructor(siret: string) {
    super(`Le SIRET ${siret} est déjà enregistré pour un autre client.`)
    this.name = 'DuplicateSiretError'
    this.siret = siret
  }
}

export async function createClient(input: ClientInput): Promise<Client> {
  try {
    const [created] = await withTenant(currentTenantId(), (tx) =>
      tx
        .insert(clients)
        .values({ ...input, country: input.country || 'FR' })
        .returning(),
    )
    return created
  } catch (error) {
    // L'unicité est tenue par un index partiel : la vérifier en amont laisserait
    // passer deux créations simultanées.
    if (pgErrorCode(error) === PG_UNIQUE_VIOLATION && input.siret) {
      throw new DuplicateSiretError(input.siret)
    }
    throw error
  }
}

export async function updateClient(id: string, input: ClientInput): Promise<void> {
  try {
    await withTenant(currentTenantId(), (tx) =>
      tx
        .update(clients)
        .set({ ...input, country: input.country || 'FR' })
        .where(and(eq(clients.id, id), isNull(clients.deletedAt))),
    )
  } catch (error) {
    if (pgErrorCode(error) === PG_UNIQUE_VIOLATION && input.siret) {
      throw new DuplicateSiretError(input.siret)
    }
    throw error
  }
}

/**
 * Suppression logique (décision 6). Le client sort des listes mais ses contrats
 * et ses factures restent lisibles, y compris pour des raisons légales.
 */
export async function archiveClient(id: string): Promise<void> {
  await withTenant(currentTenantId(), (tx) =>
    tx
      .update(clients)
      .set({ deletedAt: sql`now()`, status: 'inactive' })
      .where(and(eq(clients.id, id), isNull(clients.deletedAt))),
  )
}
