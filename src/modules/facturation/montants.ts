import type { InvoiceKind, InvoiceStatus, VatCategory } from './schema-factures.ts'

/**
 * Règles d'arrondi de l'argent (ADR 023, ADR 026), jumelles des fonctions SQL
 * de la migration 0029 et 0031. L'autorité est en base : les colonnes
 * `net_amount_cents`, la TVA des lignes et les totaux d'une facture y sont
 * calculés. Ces fonctions servent à **annoncer** un montant avant écriture —
 * un devis à l'écran, l'aperçu d'un brouillon — et doivent tomber au même
 * centime : `montants.db.test.ts` les éprouve contre la base.
 *
 * Tout est en entiers : centimes, points de base (2000 = 20 %), jours. Les
 * calculs passent par `bigint`, jamais par un flottant (décision 5).
 */

// Constantes `bigint` sans littéral `0n` : la cible TypeScript du projet
// précède ES2020.
const ZERO = BigInt(0)
const TWO = BigInt(2)
const BASIS_POINTS = BigInt(10_000)

/** Division arrondie au plus proche, la moitié s'éloignant de zéro, comme `round(numeric)`. */
function roundedDivision(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= ZERO) throw new RangeError('Dénominateur nul ou négatif.')
  const negative = numerator < ZERO
  const magnitude = negative ? -numerator : numerator
  const rounded = (TWO * magnitude + denominator) / (TWO * denominator)
  return negative ? -rounded : rounded
}

export type LineAmountInput = {
  quantity: number
  unitPriceCents: number
  /** Remise en points de base : 1000 = 10 %. Exclusive de `discountAmountCents`. */
  discountBp?: number | null
  /** Remise en centimes par période entière. Exclusive de `discountBp`. */
  discountAmountCents?: number | null
  /** Prorata d'une période partielle : jours couverts… */
  prorataNumerator?: number | null
  /** …sur jours de la période. */
  prorataDenominator?: number | null
}

/**
 * Montant net HT d'une ligne, en centimes — `line_net_amount_cents()` :
 *
 *   (quantité × prix − remise en montant) × (10000 − remise en points) / 10000
 *   × prorata
 *
 * arrondi une seule fois au centime, la moitié s'éloignant de zéro. Une
 * remise en montant est due par période entière, comme le prix : une période
 * partielle les proratise ensemble.
 */
export function lineNetAmountCents(line: LineAmountInput): number {
  const gross = BigInt(line.quantity) * BigInt(line.unitPriceCents)
  const numerator =
    (gross - BigInt(line.discountAmountCents ?? 0)) *
    BigInt(10_000 - (line.discountBp ?? 0)) *
    BigInt(line.prorataNumerator ?? 1)
  const denominator = BASIS_POINTS * BigInt(line.prorataDenominator ?? 1)
  return Number(roundedDivision(numerator, denominator))
}

/** TVA d'une base HT à un taux en points de base — `vat_amount_cents()`. */
export function vatAmountCents(baseCents: number, rateBp: number): number {
  return Number(roundedDivision(BigInt(baseCents) * BigInt(rateBp), BASIS_POINTS))
}

/** Ce qu'il faut d'une ligne de facture pour répartir la TVA. */
export type VatLine = {
  id: string
  position: number
  netAmountCents: number
  vatRateBp: number
  vatCategory: VatCategory
}

export type VatBreakdown = {
  vatCategory: VatCategory
  vatRateBp: number
  /** Base HT du taux (EN 16931, BT-116). */
  taxableAmountCents: number
  /** TVA du taux, calculée sur la base (BT-117). */
  vatAmountCents: number
}

export type InvoiceAmounts = {
  /** TVA de chaque ligne, par identifiant. */
  lineVatCents: Map<string, number>
  breakdown: VatBreakdown[]
  totalExclTaxCents: number
  totalTaxCents: number
  totalInclTaxCents: number
}

/**
 * TVA et totaux d'une facture — `invoice_refresh_amounts()`.
 *
 * La TVA se calcule par catégorie et par taux sur la somme des bases
 * (EN 16931, BR-CO-17), pas ligne à ligne. Chaque ligne reçoit sa TVA
 * arrondie, et l'écart d'arrondi du taux va à la ligne de plus forte valeur
 * absolue, puis à la première par position, puis par identifiant : la somme
 * des TVA des lignes égale exactement celle de la ventilation.
 */
export function invoiceAmounts(lines: readonly VatLine[]): InvoiceAmounts {
  const groups = new Map<string, VatLine[]>()
  for (const line of lines) {
    const key = `${line.vatCategory}|${line.vatRateBp}`
    const group = groups.get(key)
    if (group) group.push(line)
    else groups.set(key, [line])
  }

  const lineVatCents = new Map<string, number>()
  const breakdown: VatBreakdown[] = []
  for (const group of groups.values()) {
    const { vatCategory, vatRateBp } = group[0]
    const base = group.reduce((total, line) => total + line.netAmountCents, 0)
    const vat = vatAmountCents(base, vatRateBp)
    const ordered = [...group].sort(
      (a, b) =>
        Math.abs(b.netAmountCents) - Math.abs(a.netAmountCents) ||
        a.position - b.position ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    let allocated = 0
    for (const line of ordered) {
      const lineVat = vatAmountCents(line.netAmountCents, vatRateBp)
      lineVatCents.set(line.id, lineVat)
      allocated += lineVat
    }
    const gap = vat - allocated
    if (gap !== 0) lineVatCents.set(ordered[0].id, (lineVatCents.get(ordered[0].id) ?? 0) + gap)
    breakdown.push({ vatCategory, vatRateBp, taxableAmountCents: base, vatAmountCents: vat })
  }

  const totalExclTaxCents = lines.reduce((total, line) => total + line.netAmountCents, 0)
  const totalTaxCents = breakdown.reduce((total, group) => total + group.vatAmountCents, 0)
  return {
    lineVatCents,
    breakdown,
    totalExclTaxCents,
    totalTaxCents,
    totalInclTaxCents: totalExclTaxCents + totalTaxCents,
  }
}

/**
 * Statut d'une facture émise, déduit de ses montants —
 * `invoice_payment_status()`. Un avoir est toujours `issued`.
 */
export function invoicePaymentStatus(
  kind: InvoiceKind,
  totalInclTaxCents: number,
  paidCents: number,
  creditedCents: number,
): Exclude<InvoiceStatus, 'draft'> {
  if (kind === 'credit_note') return 'issued'
  if (totalInclTaxCents > 0 && creditedCents >= totalInclTaxCents) return 'cancelled'
  if (totalInclTaxCents - creditedCents - paidCents <= 0) return 'paid'
  if (paidCents > 0) return 'partially_paid'
  return 'issued'
}

/** Reste dû d'une facture émise, en centimes ; négatif : trop-perçu à rembourser. */
export function amountDueCents(invoice: {
  totalInclTaxCents: number
  paidCents: number
  creditedCents: number
}): number {
  return invoice.totalInclTaxCents - invoice.creditedCents - invoice.paidCents
}
