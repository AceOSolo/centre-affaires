import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'

import { withTenant } from '../../db/index.ts'
import { ouvrirBasesDeTest, raisonDeSaut, viderTables, type TestDatabases } from '../../db/test-support.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { readDolibarrProductEvent, type ServiceFromDolibarr, type TariffFromDolibarr } from './produits-dolibarr.ts'
import { applyDolibarrService, applyDolibarrTariff } from './produits-dolibarr-queries.ts'

/**
 * Produits reçus de Dolibarr (ADR 049), écrits sous l'identité applicative,
 * comme la route les écrit. Rejouables, et sans jamais effacer un prix.
 */
describe('produits reçus de Dolibarr', { skip: raisonDeSaut }, () => {
  let bases: TestDatabases

  const PLAN = '01a00000-0000-7000-8000-000000490a01'
  const SALLE = '01a00000-0000-7000-8000-000000490b01'
  const AUJOURDHUI = '2026-10-20'

  const asTenant = <T>(run: Parameters<typeof withTenant<T>>[1]) =>
    withTenant(DEFAULT_TENANT_ID, run, bases.app.db)

  const service = (object: Record<string, unknown>, trigger = 'PRODUCT_MODIFY') => {
    const decision = readDolibarrProductEvent({
      triggercode: trigger,
      object: { ref: 'courrier.ouverture', label: 'Ouverture', type: '1', price: '3.5', tva_tx: '20', status: '1', ...object },
    })
    assert.equal(decision.kind, 'service')
    return decision as ServiceFromDolibarr
  }

  const tarif = (ref: string, price: string, trigger = 'PRODUCT_MODIFY') => {
    const decision = readDolibarrProductEvent({ triggercode: trigger, object: { ref, price, type: '1', status: '1' } })
    assert.equal(decision.kind, 'tarif')
    return decision as TariffFromDolibarr
  }

  const lignes = async <T>(query: string) => {
    const [rows] = (await bases.owner.client.query(query)) as unknown as [T[]]
    return rows
  }

  before(async () => {
    bases = await ouvrirBasesDeTest()
    ;(globalThis as { database?: unknown }).database = bases.app
  })

  beforeEach(async () => {
    await viderTables(bases.owner, 'offer_items', 'offers', 'services', 'rate_plan_items', 'rate_plans', 'resources')
  })

  after(async () => {
    delete (globalThis as { database?: unknown }).database
    await bases?.fermer()
  })

  describe('services', () => {
    it('crée le service, puis le met à jour, et rejouer ne change rien', async () => {
      assert.equal((await applyDolibarrService(service({}))).result, 'cree')
      assert.equal((await applyDolibarrService(service({}))).result, 'inchange')
      assert.equal((await applyDolibarrService(service({ price: '4.00000000' }))).result, 'modifie')

      const rows = await lignes<{ code: string; nature: string; unit: string; unit_price_cents: number }>(
        'select code, nature, unit, unit_price_cents from services',
      )
      assert.deepEqual(rows, [{ code: 'courrier.ouverture', nature: 'act', unit: 'unit', unit_price_cents: 400 }])
    })

    it('garde la nature d’un service existant', async () => {
      await applyDolibarrService(service({ ref: 'standard', duration_unit: 'm' }))
      await applyDolibarrService(service({ ref: 'standard', duration_unit: '', price: '50' }))
      const [row] = await lignes<{ nature: string; unit: string }>('select nature, unit from services')
      assert.deepEqual(row, { nature: 'package', unit: 'month' })
    })

    it('suit le renommage de la référence plutôt que d’en créer un second', async () => {
      await applyDolibarrService(service({ ref: 'ouverture' }))
      assert.equal((await applyDolibarrService(service({ ref: 'courrier.ouverture', oldcopy: { ref: 'ouverture' } }))).result, 'modifie')
      const rows = await lignes<{ code: string }>('select code from services')
      assert.deepEqual(rows, [{ code: 'courrier.ouverture' }])
    })

    it('archive le service supprimé dans Dolibarr, sans l’effacer', async () => {
      await applyDolibarrService(service({}))
      assert.equal((await applyDolibarrService(service({}, 'PRODUCT_DELETE'))).result, 'retire')
      assert.equal((await applyDolibarrService(service({}, 'PRODUCT_DELETE'))).result, 'inchange')
      const rows = await lignes<{ archive: number; is_active: number }>(
        'select deleted_at is not null as archive, is_active from services',
      )
      assert.deepEqual(rows.map((r) => [Number(r.archive), Number(r.is_active)]), [[1, 0]])
      // Recréé ensuite dans Dolibarr : un nouveau service, l'archivé reste.
      assert.equal((await applyDolibarrService(service({}))).result, 'cree')
    })

    it('tient deux envois simultanés du même produit', async () => {
      const results = await Promise.all([applyDolibarrService(service({})), applyDolibarrService(service({}))])
      assert.deepEqual(results.map((r) => r.result).sort(), ['cree', 'inchange'])
      const rows = await lignes<{ total: number }>('select count(*) as total from services')
      assert.equal(Number(rows[0]!.total), 1)
    })
  })

  describe('tarifs', () => {
    beforeEach(async () => {
      await asTenant(async (tx) => {
        await tx.execute(sql`insert into rate_plans (id, name, is_default) values (${PLAN}, 'Tarifs publics 2026', true)`)
        await tx.execute(sql`
          insert into resources (id, resource_type, code, name) values (${SALLE}, 'salle', 'SAL-MB', 'Salle Mont Blanc')`)
      })
    })

    const prix = () =>
      lignes<{ resource_id: string | null; unit: string; amount_cents: number; retire: number }>(
        'select resource_id, unit, amount_cents, deleted_at is not null as retire from rate_plan_items order by created_at, amount_cents',
      )

    it('ajoute le prix par type dans la grille par défaut, rejouable', async () => {
      assert.equal((await applyDolibarrTariff(tarif('tarif.salle.demi-journee', '90'), AUJOURDHUI)).result, 'cree')
      assert.equal((await applyDolibarrTariff(tarif('tarif.salle.demi-journee', '90'), AUJOURDHUI)).result, 'inchange')
      const rows = await prix()
      assert.deepEqual(
        rows.map((r) => [r.resource_id, r.unit, r.amount_cents, Number(r.retire)]),
        [[null, 'half_day', 9_000, 0]],
      )
    })

    it('remplace un prix qui change en gardant l’ancien retiré', async () => {
      await applyDolibarrTariff(tarif('tarif.salle.journee', '130'), AUJOURDHUI)
      assert.equal((await applyDolibarrTariff(tarif('tarif.salle.journee', '140'), AUJOURDHUI)).result, 'modifie')
      const rows = await prix()
      assert.deepEqual(rows.map((r) => [r.amount_cents, Number(r.retire)]), [[13_000, 1], [14_000, 0]])
    })

    it('pose un prix nominatif sur la ressource désignée par son code', async () => {
      assert.equal((await applyDolibarrTariff(tarif('TARIF.SALLE.SAL-MB.HEURE', '25'), AUJOURDHUI)).result, 'cree')
      const [row] = await prix()
      assert.equal(row?.resource_id, SALLE)
      assert.equal(row?.unit, 'hour')
    })

    it('refuse une ressource inconnue', async () => {
      const outcome = await applyDolibarrTariff(tarif('tarif.salle.sal-zz.heure', '25'), AUJOURDHUI)
      assert.equal(outcome.result, 'refuse')
      assert.equal((await prix()).length, 0)
    })

    it('retire le prix d’un produit supprimé', async () => {
      await applyDolibarrTariff(tarif('tarif.salle.journee', '130'), AUJOURDHUI)
      const outcome = await applyDolibarrTariff(tarif('tarif.salle.journee', '130', 'PRODUCT_DELETE'), AUJOURDHUI)
      assert.equal(outcome.result, 'retire')
      assert.deepEqual((await prix()).map((r) => Number(r.retire)), [1])
    })

    it('refuse sans grille par défaut en vigueur', async () => {
      await bases.owner.client.query(`update rate_plans set valid_to = '2026-01-01'`)
      const outcome = await applyDolibarrTariff(tarif('tarif.salle.journee', '130'), AUJOURDHUI)
      assert.equal(outcome.result, 'refuse')
    })
  })
})
