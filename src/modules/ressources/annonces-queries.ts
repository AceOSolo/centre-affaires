import { and, asc, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm'

import { PG_UNIQUE_VIOLATION, pgErrorCode } from '../../db/errors.ts'
import { withTenant } from '../../db/index.ts'
import { uniqueSlug } from '../../lib/slug.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { listings, resources, type Listing, type Resource } from './schema.ts'

/** Une annonce et la ressource qu'elle met en vitrine. */
export type ListingWithResource = Listing & { resource: Resource }

const hydrate = (row: { listing: Listing; resource: Resource }): ListingWithResource => ({
  ...row.listing,
  resource: row.resource,
})

/**
 * Annonces visibles du public.
 *
 * Trois conditions, et les trois comptent : l'annonce est publiée, elle n'est
 * pas archivée, et la ressource est encore en service. Une salle mise en
 * maintenance disparaît du catalogue sans qu'on ait à dépublier son annonce —
 * sinon il faudrait penser aux deux.
 */
export async function listPublishedListings(): Promise<ListingWithResource[]> {
  const rows = await withTenant(currentTenantId(), (tx) =>
    tx
      .select({ listing: listings, resource: resources })
      .from(listings)
      .innerJoin(resources, eq(resources.id, listings.resourceId))
      .where(
        and(
          isNotNull(listings.publishedAt),
          isNull(listings.deletedAt),
          isNull(resources.deletedAt),
          eq(resources.status, 'active'),
        ),
      )
      .orderBy(asc(resources.resourceType), asc(resources.code)),
  )
  return rows.map(hydrate)
}

export async function findPublishedListing(
  slug: string,
): Promise<ListingWithResource | undefined> {
  const [row] = await withTenant(currentTenantId(), (tx) =>
    tx
      .select({ listing: listings, resource: resources })
      .from(listings)
      .innerJoin(resources, eq(resources.id, listings.resourceId))
      .where(
        and(
          eq(listings.slug, slug),
          isNotNull(listings.publishedAt),
          isNull(listings.deletedAt),
          isNull(resources.deletedAt),
          eq(resources.status, 'active'),
        ),
      )
      .limit(1),
  )
  return row ? hydrate(row) : undefined
}

/** Toutes les annonces, brouillons compris, pour le back-office. */
export async function listAllListings(): Promise<ListingWithResource[]> {
  const rows = await withTenant(currentTenantId(), (tx) =>
    tx
      .select({ listing: listings, resource: resources })
      .from(listings)
      .innerJoin(resources, eq(resources.id, listings.resourceId))
      .where(isNull(listings.deletedAt))
      .orderBy(desc(listings.publishedAt), asc(resources.code)),
  )
  return rows.map(hydrate)
}

export async function findListingForResource(
  resourceId: string,
): Promise<Listing | undefined> {
  const [listing] = await withTenant(currentTenantId(), (tx) =>
    tx
      .select()
      .from(listings)
      .where(and(eq(listings.resourceId, resourceId), isNull(listings.deletedAt)))
      .limit(1),
  )
  return listing
}

async function takenSlugs(exceptResourceId?: string): Promise<string[]> {
  const rows = await withTenant(currentTenantId(), (tx) =>
    tx.select({ slug: listings.slug, resourceId: listings.resourceId }).from(listings),
  )
  return rows.filter((row) => row.resourceId !== exceptResourceId).map((row) => row.slug)
}

export type ListingInput = {
  resourceId: string
  headline: string
  description?: string | null
  highlights?: string[]
  /** Laissé vide : dérivé du titre, puis figé. */
  slug?: string
}

/** Levée quand le slug saisi est déjà porté par une autre annonce. */
export class DuplicateSlugError extends Error {
  readonly slug: string

  constructor(slug: string) {
    super(`L'adresse « ${slug} » est déjà utilisée par une autre annonce.`)
    this.name = 'DuplicateSlugError'
    this.slug = slug
  }
}

/**
 * Crée ou met à jour l'annonce d'une ressource.
 *
 * Le slug n'est calculé qu'à la création : le changer après publication
 * casserait les liens partagés et les résultats de recherche. Le staff peut le
 * forcer, à ses risques.
 */
export async function saveListing(input: ListingInput): Promise<Listing> {
  const existing = await findListingForResource(input.resourceId)
  const slug =
    input.slug?.trim() ||
    existing?.slug ||
    uniqueSlug(input.headline, await takenSlugs(input.resourceId))

  const values = {
    headline: input.headline,
    description: input.description?.trim() || null,
    highlights: input.highlights ?? [],
    slug,
  }

  try {
    if (existing) {
      const [updated] = await withTenant(currentTenantId(), (tx) =>
        tx.update(listings).set(values).where(eq(listings.id, existing.id)).returning(),
      )
      return updated
    }
    const [created] = await withTenant(currentTenantId(), (tx) =>
      tx
        .insert(listings)
        .values({ ...values, resourceId: input.resourceId })
        .returning(),
    )
    return created
  } catch (error) {
    // L'unicité est tenue par un index partiel : la vérifier en amont laisserait
    // passer deux enregistrements simultanés.
    if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) throw new DuplicateSlugError(slug)
    throw error
  }
}

export async function publishListing(id: string): Promise<void> {
  await withTenant(currentTenantId(), (tx) =>
    tx.update(listings).set({ publishedAt: sql`now()` }).where(eq(listings.id, id)),
  )
}

/**
 * Dépublication. L'annonce reste en base : la republier ne doit pas obliger à
 * tout ressaisir, et son slug reste réservé.
 */
export async function unpublishListing(id: string): Promise<void> {
  await withTenant(currentTenantId(), (tx) =>
    tx.update(listings).set({ publishedAt: null }).where(eq(listings.id, id)),
  )
}
