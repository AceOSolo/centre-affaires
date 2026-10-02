import type { InvoiceLineKind } from '../facturation/schema-factures.ts'
import type { ChartPoint } from './graphique.ts'
import type { Period } from './periode.ts'

/**
 * Mise en forme des indicateurs (R31) : dates et mois en français, natures de
 * lignes. Module pur, éprouvé par `affichage.test.ts`.
 */

/** Libellés des natures de lignes de facture, au pluriel : ce sont des cumuls. */
export const revenueKindLabels: Record<InvoiceLineKind, string> = {
  rent: 'Loyers des contrats',
  booking: 'Réservations',
  package: 'Forfaits',
  act: 'Actes',
  discount: 'Remises',
  other: 'Autres lignes',
}

/** Ordre d'affichage des natures. */
export const revenueKindOrder: readonly InvoiceLineKind[] = ['rent', 'booking', 'package', 'act', 'discount', 'other']

const longDate = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })

/** « 1er octobre 2026 », « 14 octobre 2026 » : un jour civil, sans fuseau. */
export function formatDay(isoDate: string): string {
  const [year, month, day] = isoDate.split('-').map(Number)
  const text = longDate.format(new Date(Date.UTC(year, month - 1, day, 12)))
  return day === 1 ? text.replace(/^1 /, '1er ') : text
}

/** « du 1er octobre 2026 au 31 octobre 2026 », ou « le 14 octobre 2026 ». */
export function formatPeriod(period: Period): string {
  if (period.from === period.to) return `le ${formatDay(period.from)}`
  return `du ${formatDay(period.from)} au ${formatDay(period.to)}`
}

const monthLong = new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric', timeZone: 'UTC' })
const monthShort = new Intl.DateTimeFormat('fr-FR', { month: 'short', timeZone: 'UTC' })

const midMonth = (isoMonth: string) => {
  const [year, month] = isoMonth.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, 15, 12))
}

/**
 * Points d'un histogramme mensuel : libellé complet pour l'infobulle, mois
 * abrégé pour l'axe, année sous le premier mois et sous chaque janvier.
 */
export function monthPoints(
  rows: readonly { month: string; value: number }[],
  display: (value: number) => string,
): ChartPoint[] {
  return rows.map((row, index) => ({
    key: row.month,
    label: monthLong.format(midMonth(row.month)),
    shortLabel: monthShort.format(midMonth(row.month)),
    year: index === 0 || row.month.endsWith('-01') ? row.month.slice(0, 4) : undefined,
    value: row.value,
    display: display(row.value),
  }))
}
