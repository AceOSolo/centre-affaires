/**
 * Géométrie d'un histogramme mensuel (R31), calculée à part du rendu pour être
 * éprouvée seule : échelle arrondie à une valeur ronde, barres de 24 px au plus
 * centrées dans leur colonne, arrondies de 4 px du côté de la valeur et
 * carrées sur la ligne de base. Une valeur négative (un mois où les avoirs
 * dépassent le facturé) descend sous la ligne de base au lieu d'être tue.
 */

export type ChartPoint = {
  key: string
  /** Libellé complet, pour l'infobulle : « octobre 2026 ». */
  label: string
  /** Libellé de l'axe : « oct. ». */
  shortLabel: string
  /** Année, écrite sous le premier mois et sous chaque janvier. */
  year?: string
  value: number
  /** Valeur mise en forme, pour l'infobulle : « 1 250,00 € ». */
  display: string
}

export type ChartBar = {
  point: ChartPoint
  centerX: number
  slotX: number
  slotWidth: number
  /** Tracé de la barre, ou `null` pour une valeur nulle. */
  path: string | null
}

export type ChartGeometry = {
  width: number
  height: number
  plotLeft: number
  /** Ordonnée de la valeur 0. */
  baseline: number
  ticks: { value: number; y: number }[]
  bars: ChartBar[]
}

const MAX_BAR_WIDTH = 24
const RADIUS = 4

/** Plus petite valeur ronde (1, 2, 2,5 ou 5 × 10ⁿ) supérieure ou égale. */
export function niceCeiling(value: number): number {
  if (value <= 0) return 0
  const magnitude = 10 ** Math.floor(Math.log10(value))
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (step * magnitude >= value) return step * magnitude
  }
  return 10 * magnitude
}

const round = (value: number) => Math.round(value * 10) / 10

export function columnChartGeometry(
  points: readonly ChartPoint[],
  options: { minMax?: number; width?: number; height?: number } = {},
): ChartGeometry {
  const { minMax = 0, width = 640, height = 200 } = options
  const plotLeft = 72
  const plotTop = 12
  const plotBottom = height - 36

  const values = points.map((point) => point.value)
  const highest = niceCeiling(Math.max(minMax, 0, ...values))
  const lowest = Math.min(0, ...values)
  const min = lowest < 0 ? -niceCeiling(-lowest) : 0
  // Rien à montrer : une échelle arbitraire, et la seule ligne de base.
  const max = highest > 0 || min < 0 ? highest : 1
  const y = (value: number) => round(plotTop + ((max - value) / (max - min)) * (plotBottom - plotTop))
  const baseline = y(0)

  const ticks = [...new Set(highest > 0 || min < 0 ? [min, 0, max / 2, max] : [0])]
    .sort((a, b) => a - b)
    .map((value) => ({ value, y: y(value) }))

  const slotWidth = points.length > 0 ? (width - plotLeft) / points.length : 0
  const barWidth = Math.min(MAX_BAR_WIDTH, slotWidth * 0.6)

  const bars = points.map((point, index): ChartBar => {
    const slotX = round(plotLeft + index * slotWidth)
    const centerX = round(plotLeft + index * slotWidth + slotWidth / 2)
    const left = round(centerX - barWidth / 2)
    const right = round(centerX + barWidth / 2)
    const end = y(point.value)
    const length = Math.abs(end - baseline)
    if (point.value === 0 || length === 0) {
      return { point, centerX, slotX, slotWidth: round(slotWidth), path: null }
    }
    const radius = Math.min(RADIUS, barWidth / 2, length)
    // Positive : arrondie en haut. Négative : arrondie en bas.
    const direction = point.value > 0 ? 1 : -1
    const corner = round(end + direction * radius)
    const path = [
      `M${left},${baseline}`,
      `V${corner}`,
      `Q${left},${end} ${round(left + radius)},${end}`,
      `H${round(right - radius)}`,
      `Q${right},${end} ${right},${corner}`,
      `V${baseline}`,
      'Z',
    ].join(' ')
    return { point, centerX, slotX, slotWidth: round(slotWidth), path }
  })

  return { width, height, plotLeft, baseline, ticks, bars }
}
