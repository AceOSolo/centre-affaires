import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'

import { withTenant } from '../../db/index.ts'
import { ouvrirBasesDeTest, raisonDeSaut, viderTables, type TestDatabases } from '../../db/test-support.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import {
  ArchivedRatePlanError,
  addRatePlanItem,
  archiveRatePlan,
  findApplicableRate,
  findRatePlan,
  removeRatePlanItem,
} from './queries.ts'

/**
 * Retrait d'un prix de grille (B5, décision 6) : un archivage, pas une
 * suppression. Le prix retiré ne s'applique plus et n'apparaît plus, mais sa
 * ligne reste pour expliquer un montant calculé avec lui. Les prix d'une
 * grille archivée sont figés. Fonctions appelées telles que l'application les
 * appelle, sous l'identité applicative.
 */
describe('retrait des prix d’une grille', { skip: raisonDeSaut }, () => {
  let bases: TestDatabases

  const PLAN = '01a00000-0000-7000-8000-000000300a01'
  const SALLE = '01a00000-0000-7000-8000-000000300b01'

  const asTenant = <T>(run: Parameters<typeof withTenant<T>>[1]) =>
    withTenant(DEFAULT_TENANT_ID, run, bases.app.db)

  const prix = (amountCents: number, resourceId: string | null = null) =>
    addRatePlanItem({ ratePlanId: PLAN, resourceType: 'salle', resourceId, unit: 'hour', amountCents })

  const lignes = async () => {
    const [rows] = (await bases.owner.client.query(
      'select amount_cents, deleted_at from rate_plan_items order by created_at, amount_cents',
    )) as unknown as [{ amount_cents: number; deleted_at: Date | null }[]]
    return rows
  }

  before(async () => {
    bases = await ouvrirBasesDeTest()
    // Les requêtes du module passent par la base du processus : celle des tests.
    ;(globalThis as { database?: unknown }).database = bases.app
  })

  beforeEach(async () => {
    await viderTables(bases.owner, 'bookings', 'contracts', 'rate_plan_items', 'rate_plans', 'clients', 'resources')
    await asTenant(async (tx) => {
      await tx.execute(sql`insert into rate_plans (id, name) values (${PLAN}, 'Tarifs 2026')`)
      await tx.execute(sql`
        insert into resources (id, resource_type, code, name) values (${SALLE}, 'salle', 'SAL-G', 'Salle Garance')`)
    })
  })

  after(async () => {
    delete (globalThis as { database?: unknown }).database
    await bases.fermer()
  })

  it('garde la ligne retirée en base, marquée, et la sort de la grille', async () => {
    const item = await prix(2500)
    assert.equal(await removeRatePlanItem(item.id), true)

    const [ligne] = await lignes()
    assert.equal(ligne.amount_cents, 2500)
    assert.ok(ligne.deleted_at)
    assert.deepEqual((await findRatePlan(PLAN))?.items, [])
  })

  it('ne l’applique plus : le tarif du type reprend la main', async () => {
    await prix(2500)
    const nominatif = await prix(4000, SALLE)
    const lookup = {
      resourceId: SALLE,
      resourceType: 'salle' as const,
      unit: 'hour' as const,
      on: '2026-10-01',
    }
    assert.equal((await findApplicableRate(lookup, PLAN))?.item.amountCents, 4000)

    await removeRatePlanItem(nominatif.id)
    assert.equal((await findApplicableRate(lookup, PLAN))?.item.amountCents, 2500)
  })

  it('laisse remplacer un prix retiré', async () => {
    const ancien = await prix(2500)
    await removeRatePlanItem(ancien.id)
    await prix(2800)

    assert.deepEqual(
      (await findRatePlan(PLAN))?.items.map((item) => item.amountCents),
      [2800],
    )
    assert.equal((await lignes()).length, 2)
  })

  it('ne retire pas deux fois, et ignore un identifiant illisible', async () => {
    const item = await prix(2500)
    assert.equal(await removeRatePlanItem(item.id), true)
    assert.equal(await removeRatePlanItem(item.id), false)
    assert.equal(await removeRatePlanItem('pas-un-uuid'), false)
  })

  it('fige les prix d’une grille archivée', async () => {
    const item = await prix(2500)
    await archiveRatePlan(PLAN)

    await assert.rejects(removeRatePlanItem(item.id), ArchivedRatePlanError)
    await assert.rejects(prix(3000, SALLE), ArchivedRatePlanError)

    // La grille archivée reste lisible, ses prix intacts.
    const plan = await findRatePlan(PLAN)
    assert.ok(plan?.deletedAt)
    assert.deepEqual(plan?.items.map((ligne) => ligne.amountCents), [2500])
    const [ligne] = await lignes()
    assert.equal(ligne.deleted_at, null)
  })
})
