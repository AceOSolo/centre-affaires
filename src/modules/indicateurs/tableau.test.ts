import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { OccupancyResource, OccupancySummary } from './occupation.ts'
import type { RevenueAmounts } from './revenus.ts'
import { resourceIndicatorRows, totalRevenue, typeIndicatorRows } from './tableau.ts'

const ressource = (id: string, resourceType: OccupancyResource['resourceType']): OccupancyResource => ({
  id,
  resourceType,
  status: 'active',
  deletedAt: null,
})

const montant = (netCents: number, creditedCents = 0): RevenueAmounts => ({
  invoicedCents: netCents + creditedCents,
  creditedCents,
  netCents,
})

const SALLE = ressource('salle', 'salle')
const BUREAU = ressource('bureau', 'bureau')
const ANCIENNE = { ...ressource('ancienne', 'vehicule'), status: 'retired' as const }
const VIDE = { ...ressource('vide', 'casier'), status: 'retired' as const }

const occupation: OccupancySummary<OccupancyResource> = {
  resources: [
    { resource: SALLE, openMinutes: 540, busyMinutes: 270, contractMinutes: 0, contractDays: 0, rate: 500 },
    { resource: BUREAU, openMinutes: 540, busyMinutes: 540, contractMinutes: 540, contractDays: 1, rate: 1000 },
  ],
  types: [
    { resourceType: 'salle', resourceCount: 1, openMinutes: 540, busyMinutes: 270, contractMinutes: 0, rate: 500 },
    { resourceType: 'bureau', resourceCount: 1, openMinutes: 540, busyMinutes: 540, contractMinutes: 540, rate: 1000 },
  ],
  total: { openMinutes: 1080, busyMinutes: 810, contractMinutes: 540, rate: 750 },
}

describe('tableaux par ressource et par type', () => {
  it('garde les ressources du parc et celles qui ont produit du revenu, rien d’autre', () => {
    const rows = resourceIndicatorRows(
      [SALLE, BUREAU, ANCIENNE, VIDE],
      occupation,
      new Map([
        [BUREAU.id, montant(90_000)],
        [ANCIENNE.id, montant(4_000, 1_000)],
      ]),
    )
    assert.deepEqual(
      rows.map((row) => [row.resource.id, row.occupancy?.rate ?? null, row.revenue.netCents]),
      [
        ['salle', 500, 0],
        ['bureau', 1000, 90_000],
        // Retirée du parc mais facturée : visible, sans taux.
        ['ancienne', null, 4_000],
      ],
    )
    assert.deepEqual(totalRevenue(rows), { invoicedCents: 95_000, creditedCents: 1_000, netCents: 94_000 })
  })

  it('range les types dans l’ordre du catalogue, revenu sans occupation compris', () => {
    const rows = typeIndicatorRows(
      occupation.types,
      new Map([
        ['bureau', montant(90_000)],
        ['vehicule', montant(4_000)],
      ]),
    )
    assert.deepEqual(
      rows.map((row) => [row.resourceType, row.occupancy?.rate ?? null, row.revenue.netCents]),
      [
        ['salle', 500, 0],
        ['bureau', 1000, 90_000],
        ['vehicule', null, 4_000],
      ],
    )
  })
})
