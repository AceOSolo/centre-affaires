import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { columnChartGeometry, niceCeiling, type ChartPoint } from './graphique.ts'

const point = (key: string, value: number): ChartPoint => ({
  key,
  label: key,
  shortLabel: key,
  value,
  display: String(value),
})

describe('géométrie de l’histogramme mensuel', () => {
  it('arrondit le haut d’échelle à une valeur ronde', () => {
    assert.equal(niceCeiling(0), 0)
    assert.equal(niceCeiling(1), 1)
    assert.equal(niceCeiling(123_456), 200_000)
    assert.equal(niceCeiling(2_100), 2_500)
    assert.equal(niceCeiling(4_999), 5_000)
    assert.equal(niceCeiling(1_000), 1_000)
  })

  it('cale la plus haute barre sur le haut de l’échelle, et ne dessine pas une valeur nulle', () => {
    const geometry = columnChartGeometry([point('a', 1_000), point('b', 0), point('c', 500)], { minMax: 1_000 })
    assert.deepEqual(
      geometry.ticks.map((tick) => tick.value),
      [0, 500, 1_000],
    )
    const [a, b, c] = geometry.bars
    // Le haut de la zone de tracé est à 12 px.
    assert.match(a.path ?? '', /Q[\d.]+,12 /)
    assert.equal(b.path, null)
    assert.ok(c.path)
    // Toutes les barres partent de la ligne de base.
    for (const bar of [a, c]) assert.ok(bar.path?.startsWith(`M`) && bar.path.includes(`,${geometry.baseline}`))
  })

  it('limite la largeur des barres à 24 px et les centre dans leur colonne', () => {
    const geometry = columnChartGeometry([point('a', 10), point('b', 20)])
    for (const bar of geometry.bars) {
      const xs = [...(bar.path ?? '').matchAll(/M([\d.]+),/g)].map((match) => Number(match[1]))
      assert.equal(xs.length, 1)
      assert.ok(Math.abs(bar.centerX - xs[0] - 12) < 0.11, `${bar.centerX} ${xs[0]}`)
    }
  })

  it('fait descendre une valeur négative sous la ligne de base', () => {
    const geometry = columnChartGeometry([point('a', 2_000), point('b', -500)])
    assert.deepEqual(
      geometry.ticks.map((tick) => tick.value),
      [-500, 0, 1_000, 2_000],
    )
    const negative = geometry.bars[1]
    const last = negative.path?.match(/V([\d.]+) Z$/)
    assert.equal(Number(last?.[1]), geometry.baseline)
    const tick = geometry.ticks.find((entry) => entry.value === -500)
    assert.ok(tick && tick.y > geometry.baseline)
  })

  it('reste dessinable sans aucune valeur', () => {
    const geometry = columnChartGeometry([point('a', 0), point('b', 0)])
    assert.ok(geometry.bars.every((bar) => bar.path === null))
    assert.deepEqual(
      geometry.ticks.map((tick) => tick.value),
      [0],
    )
  })
})
