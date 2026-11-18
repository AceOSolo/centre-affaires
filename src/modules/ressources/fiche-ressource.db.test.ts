import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { eq, sql } from 'drizzle-orm'

import { withTenant } from '../../db/index.ts'
import { ouvrirBasesDeTest, raisonDeSaut, viderTables, type TestDatabases } from '../../db/test-support.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { ensureListingForResource } from './queries.ts'
import { listings } from './schema.ts'

/**
 * Photos et vidéos depuis la fiche d'une ressource (ADR 082) : l'annonce qui
 * les porte se crée en brouillon au besoin, sans jamais réécrire une annonce
 * existante, ni servir une ressource archivée ou d'un autre centre.
 */
describe('annonce préparée depuis la fiche d’une ressource', { skip: raisonDeSaut }, () => {
  let bases: TestDatabases

  const SALLE = '01a00000-0000-7000-8000-00000000f9a1'
  const HOMONYME = '01a00000-0000-7000-8000-00000000f9a2'
  const ARCHIVEE = '01a00000-0000-7000-8000-00000000f9a3'
  const AUTRE_CENTRE = '01999f00-0000-7000-8000-0000000000f9'
  const AILLEURS = '01a00000-0000-7000-8000-00000000f9a4'

  const asTenant = <T>(run: Parameters<typeof withTenant<T>>[1]) => withTenant(DEFAULT_TENANT_ID, run, bases.app.db)

  const annoncesDe = (resourceId: string) =>
    asTenant((tx) => tx.select().from(listings).where(eq(listings.resourceId, resourceId)))

  before(async () => {
    bases = await ouvrirBasesDeTest()
    ;(globalThis as { database?: unknown }).database = bases.app
  })

  beforeEach(async () => {
    await viderTables(bases.owner, 'listings', 'bookings', 'rate_plan_items', 'resources')
    await bases.owner.client.query('delete from tenants where id = ?', [AUTRE_CENTRE])
    await asTenant((tx) =>
      tx.execute(sql`
        insert into resources (id, resource_type, code, name, deleted_at) values
          (${SALLE}, 'salle', 'SAL-MB', 'Salle Mont Blanc', null),
          (${HOMONYME}, 'salle', 'SAL-MB2', 'Salle Mont Blanc', null),
          (${ARCHIVEE}, 'salle', 'SAL-OLD', 'Salle ancienne', utc_timestamp(3))`),
    )
  })

  after(async () => {
    try {
      // La ressource de l'autre centre d'abord : elle le référence.
      await viderTables(bases.owner, 'listings', 'resources')
      await bases.owner.client.query('delete from tenants where id = ?', [AUTRE_CENTRE])
    } finally {
      delete (globalThis as { database?: unknown }).database
      await bases.fermer()
    }
  })

  it('crée un brouillon au nom de la ressource, invisible du public, sans média', async () => {
    const listing = await ensureListingForResource(SALLE)
    assert.ok(listing)
    assert.equal(listing.resourceId, SALLE)
    assert.equal(listing.headline, 'Salle Mont Blanc')
    assert.equal(listing.slug, 'salle-mont-blanc')
    assert.equal(listing.publishedAt, null)
    assert.deepEqual(listing.media, [])
  })

  it('rend l’annonce existante telle quelle, sans en créer une seconde', async () => {
    const first = await ensureListingForResource(SALLE)
    await asTenant((tx) =>
      tx
        .update(listings)
        .set({ headline: 'Salle Mont Blanc, 12 places', description: 'Lumineuse', highlights: ['Vue'] })
        .where(eq(listings.id, first!.id)),
    )
    const again = await ensureListingForResource(SALLE)
    assert.equal(again?.id, first?.id)
    assert.equal(again?.headline, 'Salle Mont Blanc, 12 places')
    assert.equal(again?.description, 'Lumineuse')
    assert.deepEqual(again?.highlights, ['Vue'])
    assert.equal((await annoncesDe(SALLE)).length, 1)
  })

  it('ne crée qu’une annonce pour deux demandes simultanées', async () => {
    const [a, b] = await Promise.all([ensureListingForResource(SALLE), ensureListingForResource(SALLE)])
    assert.equal(a?.id, b?.id)
    assert.equal((await annoncesDe(SALLE)).length, 1)
  })

  it('donne une adresse libre à un homonyme', async () => {
    await ensureListingForResource(SALLE)
    const second = await ensureListingForResource(HOMONYME)
    assert.equal(second?.slug, 'salle-mont-blanc-2')
  })

  it('ne sert ni une ressource archivée, ni une ressource inconnue', async () => {
    assert.equal(await ensureListingForResource(ARCHIVEE), undefined)
    assert.equal(await ensureListingForResource('01a00000-0000-7000-8000-00000000ffff'), undefined)
    assert.equal((await annoncesDe(ARCHIVEE)).length, 0)
  })

  it('ne sert pas la ressource d’un autre centre', async () => {
    await bases.owner.client.query(
      `insert into tenants (id, name, slug) values (?, 'Autre centre', 'autre-centre-fiche')`,
      [AUTRE_CENTRE],
    )
    await withTenant(
      AUTRE_CENTRE,
      (tx) =>
        tx.execute(sql`
          insert into resources (id, tenant_id, resource_type, code, name)
          values (${AILLEURS}, ${AUTRE_CENTRE}, 'salle', 'SAL-X', 'Salle ailleurs')`),
      bases.app.db,
    )
    assert.equal(await ensureListingForResource(AILLEURS), undefined)
    const [{ total }] = (await bases.owner.client.query('select count(*) as total from listings'))[0] as {
      total: number
    }[]
    assert.equal(Number(total), 0)
  })
})
