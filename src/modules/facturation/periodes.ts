import type { ProrataRule, RecurringBillingTiming } from '../../db/tenants.ts'
import { addMonthsToIsoMonth, formatIsoMonth } from '../../lib/dates.ts'
import { addDays, daysInclusive, periodEnd, periodStart } from '../contrats/echeancier.ts'
import type { BillingPeriod } from './schema.ts'

/**
 * Calendrier de la facturation périodique (R13, ADR 026, ADR 028) : quelles
 * périodes un lot facture, comment elles se coupent aux versions d'un contrat,
 * ce qui reste à facturer quand une partie l'est déjà, et le prorata d'une
 * période partielle selon la règle du centre (ADR 023).
 *
 * Tout est en jours civils du centre, au format ISO (« 2026-10-01 »), bornes
 * comprises : une période va « du 1er au 31 octobre ». Les dates ISO se
 * comparent comme des chaînes. Aucun fuseau ici : la conversion des instants
 * (réservations, plis) en jours du centre se fait avant.
 */

/** Période de jours civils, bornes comprises. */
export type DateRange = { start: string; end: string }

/** Borne d'une période sans terme : un contrat à durée indéterminée. */
export const OPEN_END = '9999-12-31'

const min = (a: string, b: string) => (a <= b ? a : b)
const max = (a: string, b: string) => (a >= b ? a : b)

/** Mois civil d'un mois ISO « 2026-10 » : du 1er au dernier jour. */
export function monthRange(isoMonth: string): DateRange {
  const start = `${isoMonth}-01`
  return { start, end: periodEnd(start, 'monthly') }
}

/** « 12/09/2026 ». */
function frenchDay(isoDate: string): string {
  return `${isoDate.slice(8, 10)}/${isoDate.slice(5, 7)}/${isoDate.slice(0, 4)}`
}

/**
 * Une période lisible : « octobre 2026 » pour un mois civil entier, « le
 * 12/09/2026 » pour un jour, « du 10/03/2026 au 31/03/2026 » sinon.
 */
export function formatPeriod(start: string, end: string): string {
  const month = monthRange(start.slice(0, 7))
  if (month.start === start && month.end === end) return formatIsoMonth(start.slice(0, 7))
  if (start === end) return `le ${frenchDay(start)}`
  return `du ${frenchDay(start)} au ${frenchDay(end)}`
}

/** Intersection de deux périodes, nulle si elles ne se touchent pas. */
export function intersect(a: DateRange, b: DateRange): DateRange | null {
  const start = max(a.start, b.start)
  const end = min(a.end, b.end)
  return start <= end ? { start, end } : null
}

export function containsDay(range: DateRange, day: string): boolean {
  return range.start <= day && day <= range.end
}

/**
 * Les trois périodes d'un lot (ADR 026, choix par défaut à valider par le
 * centre, ADR 028) :
 *
 * - `invoice` : la période portée par la facture (EN 16931, BG-14) et sa clé
 *   d'unicité — le mois du lot ;
 * - `recurring` : loyers et forfaits — le mois du lot quand le centre facture
 *   à échoir, le mois précédent quand il facture à terme échu ;
 * - `consumption` : réservations commencées et plis ouverts — toujours le mois
 *   précédent, une consommation se facture une fois faite.
 */
export type RunWindows = {
  invoice: DateRange
  recurring: DateRange
  consumption: DateRange
}

export function runWindows(isoMonth: string, timing: RecurringBillingTiming): RunWindows {
  const invoice = monthRange(isoMonth)
  const previous = monthRange(addMonthsToIsoMonth(isoMonth, -1))
  return {
    invoice,
    recurring: timing === 'in_advance' ? invoice : previous,
    consumption: previous,
  }
}

/** Périodes civiles de facturation (mois, trimestres, années) qui touchent la fenêtre. */
export function civilPeriods(window: DateRange, billingPeriod: BillingPeriod): DateRange[] {
  const periods: DateRange[] = []
  let cursor = periodStart(window.start, billingPeriod)
  // Une fenêtre d'un mois touche au plus deux périodes ; la borne ne sert
  // qu'à couper une boucle sur une saisie aberrante.
  for (let guard = 0; guard < 1200 && cursor <= window.end; guard += 1) {
    const end = periodEnd(cursor, billingPeriod)
    periods.push({ start: cursor, end })
    cursor = addDays(end, 1)
  }
  return periods
}

/**
 * Ce qui reste d'une période une fois retirés les jours déjà facturés, dans
 * l'ordre. Une période entièrement facturée ne laisse rien : rejouer un lot ne
 * refacture pas (la base le refuserait de toute façon, ADR 026).
 */
export function subtractRanges(range: DateRange, taken: readonly DateRange[]): DateRange[] {
  const ordered = taken
    .map((other) => intersect(range, other))
    .filter((other): other is DateRange => other !== null)
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))

  const rest: DateRange[] = []
  let cursor = range.start
  for (const other of ordered) {
    if (other.start > cursor) rest.push({ start: cursor, end: addDays(other.start, -1) })
    if (other.end >= cursor) cursor = addDays(other.end, 1)
    if (cursor > range.end) return rest
  }
  if (cursor <= range.end) rest.push({ start: cursor, end: range.end })
  return rest
}

/** Fraction d'une période due : jours couverts sur jours de la période. */
export type Prorata = { numerator: number; denominator: number }

const MONTHS_IN_PERIOD: Record<BillingPeriod, number> = { monthly: 1, quarterly: 3, yearly: 12 }

/**
 * Rang d'un jour dans son mois en base 30 (convention 30/360, ADR 023) : le 31
 * n'existe pas, et le dernier jour d'un mois compte comme le 30, fin février
 * comprise.
 */
export function thirtyDayIndex(isoDate: string): number {
  const day = Number(isoDate.slice(8, 10))
  if (isoDate === periodEnd(isoDate, 'monthly')) return 30
  return Math.min(day, 30)
}

/** Jours couverts en base 30, mois par mois. Du 10 au 31 mars : 21. */
export function thirtyDayCount(range: DateRange): number {
  let total = 0
  let cursor = range.start
  for (let guard = 0; guard < 1200 && cursor <= range.end; guard += 1) {
    const monthEnd = periodEnd(cursor, 'monthly')
    const end = min(monthEnd, range.end)
    total += thirtyDayIndex(end) - thirtyDayIndex(cursor) + 1
    cursor = addDays(monthEnd, 1)
  }
  return total
}

/**
 * Prorata d'un morceau de période civile, selon la règle du centre
 * (`tenants.prorata_rule`, ADR 023). Nul quand le morceau est dû en entier :
 * période complète, ou règle `none` (une période entamée est due).
 *
 * - `calendar_days` : jours couverts sur jours réels de la période (22/31) ;
 * - `thirty_day_month` : base 30, dénominateur 30, 90 ou 360 (21/30).
 *
 * Le prorata est porté sur la ligne de facture, jamais appliqué au prix : la
 * base calcule le montant en un seul arrondi (`line_net_amount_cents`).
 */
export function prorataFor(
  rule: ProrataRule,
  piece: DateRange,
  civil: DateRange,
  billingPeriod: BillingPeriod,
): Prorata | null {
  if (rule === 'none') return null
  if (piece.start <= civil.start && piece.end >= civil.end) return null
  if (rule === 'thirty_day_month') {
    const denominator = 30 * MONTHS_IN_PERIOD[billingPeriod]
    const numerator = Math.min(thirtyDayCount(piece), denominator)
    return numerator >= denominator ? null : { numerator, denominator }
  }
  return { numerator: daysInclusive(piece.start, piece.end), denominator: daysInclusive(civil.start, civil.end) }
}

/** Ce qu'il faut d'une version de prix (`contract_price_versions`). */
export type VersionSpan = {
  startsOn: string
  /** Dernier jour, compris ; nul : sans terme. */
  endsOn: string | null
}

/** Morceau d'une période civile qui relève d'une seule version. */
export type Piece<V extends VersionSpan> = {
  version: V
  civil: DateRange
  piece: DateRange
}

/**
 * Morceaux que le lot facture : chaque période civile qui touche la fenêtre,
 * coupée aux dates d'effet des versions (ADR 025), retenue quand elle relève
 * de la fenêtre du lot :
 *
 * - à échoir (`in_advance`), le morceau qui **commence** dans la fenêtre — le
 *   premier mois partiel d'un contrat est facturé dans le lot de son mois ;
 * - à terme échu (`in_arrears`), le morceau qui **finit** dans la fenêtre — un
 *   trimestre se facture une fois écoulé.
 *
 * Un trimestre ou une année se facture donc une seule fois, dans le lot du
 * mois où il commence (ou finit), pas dans chaque lot mensuel qu'il touche.
 */
export function billablePieces<V extends VersionSpan>(
  versions: readonly V[],
  billingPeriod: BillingPeriod,
  window: DateRange,
  timing: RecurringBillingTiming,
): Piece<V>[] {
  const pieces: Piece<V>[] = []
  for (const civil of civilPeriods(window, billingPeriod)) {
    for (const version of versions) {
      const piece = intersect(civil, { start: version.startsOn, end: version.endsOn ?? OPEN_END })
      if (!piece) continue
      const anchor = timing === 'in_advance' ? piece.start : piece.end
      if (containsDay(window, anchor)) pieces.push({ version, civil, piece })
    }
  }
  return pieces
}
