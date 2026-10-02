import { toIsoDate, toWallClock } from '../../lib/dates.ts'
import type { ResourceType } from '../ressources/schema.ts'
import { lineNetAmountCents, vatAmountCents } from './montants.ts'
import type { RateUnit } from './schema.ts'
import {
  billableQuantity,
  isRatePlanValidOn,
  parseAmountToCents,
  parsePercentToBasisPoints,
  resolveRate,
  type QuantityRules,
  type RateCandidate,
  type RatePlanValidity,
} from './tarifs.ts'

/**
 * Moteur de devis d'une réservation (R11, ADR 023) : la seule règle qui dit
 * combien coûte une ressource sur un créneau. Le back-office, la page publique
 * et l'écriture de la réservation passent tous par `quoteBooking()` — par
 * `quote()` (`devis-queries.ts`) qui lui fournit la grille et les règles du
 * centre. Le montant HT est celui que la base recalcule
 * (`bookings.quote_amount_cents`), par la même règle d'arrondi.
 *
 * Module pur, sans base : il s'éprouve seul (`devis.test.ts`) et rejoue le jeu
 * de cas tarifaires (`cas-tarifaires.ts`).
 */

/**
 * Unités qui chiffrent une réservation : celles qui se comptent à la durée.
 * `month` et `unit` sont des forfaits de contrat ou de prestation.
 */
export const bookableUnits = ['hour', 'half_day', 'day', 'week'] as const satisfies readonly RateUnit[]
export type BookableUnit = (typeof bookableUnits)[number]

/** Remise accordée sur un devis : un pourcentage ou un montant, jamais les deux (ADR 023). */
export type QuoteDiscount =
  | { kind: 'percent'; basisPoints: number }
  | { kind: 'amount'; cents: number }

/** Grille candidate, telle que `quote()` la lit en base. */
export type QuotePlan = RatePlanValidity & {
  id: string
  name: string
  currency: string
  items: readonly (RateCandidate & { id: string })[]
}

/** D'où vient la grille appliquée : du contrat du client, ou du centre. */
export type QuotePlanSource =
  | { kind: 'contract'; contractId: string; contractReference: string }
  | { kind: 'default' }

/** Règles du centre qui entrent dans un devis (colonnes de `tenants`, ADR 023). */
export type QuoteRules = QuantityRules & {
  /** Taux de TVA des réservations, en points de base : 2000 = 20 %. */
  defaultVatRateBp: number
}

export type BookingQuoteInput = {
  resource: { id: string; resourceType: ResourceType }
  startsAt: Date
  endsAt: Date
  /** Fuseau du centre : la durée et le jour se comptent en heure murale. */
  timeZone: string
  /**
   * Grilles candidates, par ordre de priorité : celles des contrats du client
   * d'abord, la grille par défaut du centre en dernier. La première qui est
   * valable le jour de la réservation et qui tarife la ressource l'emporte.
   */
  plans: readonly { plan: QuotePlan; source: QuotePlanSource }[]
  rules: QuoteRules
  discount?: QuoteDiscount | null
}

/** Une manière de chiffrer le créneau : une unité de la grille et sa quantité. */
export type QuoteOption = {
  unit: BookableUnit
  quantity: number
  unitPriceCents: number
  /** Quantité × prix unitaire, avant remise. */
  grossCents: number
}

export type BookingQuote = QuoteOption & {
  /** Durée retenue, en minutes d'heure murale du centre. */
  durationMinutes: number
  discountBp: number | null
  discountAmountCents: number | null
  /** Ce que la remise retire, en centimes : brut − net. */
  discountCents: number
  /** Montant HT, en centimes : `line_net_amount_cents`, un seul arrondi. */
  netCents: number
  vatRateBp: number
  /** TVA du montant HT : `vat_amount_cents`. */
  vatCents: number
  /** Montant TTC. */
  totalCents: number
  currency: string
  ratePlanId: string
  ratePlanName: string
  ratePlanItemId: string
  source: QuotePlanSource
  /** Toutes les unités que la grille propose pour ce créneau, la retenue comprise. */
  options: QuoteOption[]
}

/**
 * Ce qu'il faut d'un devis pour l'afficher, sans rien d'interne (identifiants
 * de grille). L'unité est toute unité de facturation : un devis figé sur une
 * réservation peut porter un prix saisi à la main.
 */
export type QuoteDisplay = { unit: RateUnit } & Pick<
  BookingQuote,
  | 'quantity'
  | 'unitPriceCents'
  | 'discountBp'
  | 'discountAmountCents'
  | 'discountCents'
  | 'netCents'
  | 'vatRateBp'
  | 'vatCents'
  | 'totalCents'
  | 'currency'
>

/** Ne garde du devis que ce qui s'affiche : la page publique ne reçoit rien d'autre. */
export function toQuoteDisplay(quote: QuoteDisplay): QuoteDisplay {
  return {
    unit: quote.unit,
    quantity: quote.quantity,
    unitPriceCents: quote.unitPriceCents,
    discountBp: quote.discountBp,
    discountAmountCents: quote.discountAmountCents,
    discountCents: quote.discountCents,
    netCents: quote.netCents,
    vatRateBp: quote.vatRateBp,
    vatCents: quote.vatCents,
    totalCents: quote.totalCents,
    currency: quote.currency,
  }
}

/** Ce qui a été figé sur une réservation (colonnes `quote_*` de `bookings`). */
export type FrozenBookingQuote = {
  quoteUnit: RateUnit | null
  quoteQuantity: number | null
  quoteUnitPriceCents: number | null
  quoteDiscountBp: number | null
  quoteDiscountAmountCents: number | null
  /** Montant HT calculé par la base (colonne générée). */
  quoteAmountCents: number | null
  quoteVatRateBp: number | null
  quoteCurrency: string | null
  quotedAt: Date | null
}

/**
 * Le devis figé d'une réservation, prêt à afficher ; `undefined` pour une
 * réservation non chiffrée. Le HT est celui de la base ; la TVA se recalcule
 * par la même règle d'arrondi (`vat_amount_cents`).
 */
export function frozenQuoteDisplay(booking: FrozenBookingQuote): QuoteDisplay | undefined {
  if (
    !booking.quotedAt ||
    booking.quoteUnit === null ||
    booking.quoteQuantity === null ||
    booking.quoteUnitPriceCents === null ||
    booking.quoteVatRateBp === null ||
    booking.quoteCurrency === null
  ) {
    return undefined
  }
  const netCents =
    booking.quoteAmountCents ??
    lineNetAmountCents({
      quantity: booking.quoteQuantity,
      unitPriceCents: booking.quoteUnitPriceCents,
      discountBp: booking.quoteDiscountBp,
      discountAmountCents: booking.quoteDiscountAmountCents,
    })
  const vatCents = vatAmountCents(netCents, booking.quoteVatRateBp)
  return {
    unit: booking.quoteUnit,
    quantity: booking.quoteQuantity,
    unitPriceCents: booking.quoteUnitPriceCents,
    discountBp: booking.quoteDiscountBp,
    discountAmountCents: booking.quoteDiscountAmountCents,
    discountCents: booking.quoteQuantity * booking.quoteUnitPriceCents - netCents,
    netCents,
    vatRateBp: booking.quoteVatRateBp,
    vatCents,
    totalCents: netCents + vatCents,
    currency: booking.quoteCurrency,
  }
}

export type QuoteFailure =
  | 'creneau-invalide'
  | 'aucune-grille'
  | 'aucun-tarif'
  | 'remise-invalide'
  | 'remise-excessive'

export type QuoteOutcome = { ok: true; quote: BookingQuote } | { ok: false; reason: QuoteFailure }

/** Ce que l'écran dit quand le créneau n'est pas chiffré. */
export const quoteFailureMessages: Record<QuoteFailure, string> = {
  'creneau-invalide': 'Le créneau doit finir après son début.',
  'aucune-grille':
    'Aucune grille tarifaire n’est en vigueur à cette date : le montant n’est pas calculé.',
  'aucun-tarif':
    'La grille en vigueur ne fixe aucun prix à l’heure, à la demi-journée, à la journée ni à la semaine pour cette ressource.',
  'remise-invalide':
    'Remise illisible : un pourcentage de 0 à 100, ou un montant positif en euros.',
  'remise-excessive': 'La remise dépasse le montant de la réservation.',
}

/** Minutes d'heure murale depuis l'époque, pour mesurer une durée dans le fuseau du centre. */
function wallClockMinutes(instant: Date, timeZone: string): number {
  return Date.parse(`${toWallClock(instant, timeZone)}:00Z`) / 60_000
}

/**
 * Durée d'un créneau en minutes d'heure murale du centre.
 *
 * Une réservation du samedi 0 h au mardi 0 h dure trois jours, même si la nuit
 * du changement d'heure en compte 23 ou 25 : elle doit coûter trois journées,
 * pas quatre. Hors de ces nuits, c'est la durée réelle.
 */
export function bookingDurationMinutes(startsAt: Date, endsAt: Date, timeZone: string): number {
  return wallClockMinutes(endsAt, timeZone) - wallClockMinutes(startsAt, timeZone)
}

/** Une remise saisie est-elle lisible ? Pourcentage de 0 à 100 %, montant positif. */
function validDiscount(discount: QuoteDiscount): boolean {
  if (discount.kind === 'percent') {
    return Number.isInteger(discount.basisPoints) && discount.basisPoints >= 0 && discount.basisPoints <= 10_000
  }
  return Number.isInteger(discount.cents) && discount.cents >= 0
}

/**
 * Chiffrer une réservation.
 *
 * 1. **La grille** : la première des grilles candidates qui est en vigueur le
 *    jour du début de la réservation (jour du centre) et qui tarife la
 *    ressource à l'une des unités de durée. Celle du contrat du client passe
 *    avant celle du centre (`quote()`).
 * 2. **L'unité** : parmi l'heure, la demi-journée, la journée et la semaine que
 *    la grille propose pour la ressource (le tarif nominatif primant sur celui
 *    du type), celle qui donne **le montant le plus bas** pour ce créneau. Le
 *    centre vend la demi-journée 90 € et la journée 130 € : une réunion de
 *    quatre heures coûte une demi-journée, une de neuf heures une journée, et
 *    non trois demi-journées. À montant égal, l'unité la plus large (une
 *    journée plutôt que deux demi-journées).
 * 3. **La quantité** : unité entamée au-delà de la tolérance du centre
 *    (`billableQuantity`).
 * 4. **Le montant** : quantité × prix, moins la remise, arrondi une seule fois
 *    (`lineNetAmountCents`, jumeau de la base) ; TVA au taux du centre.
 */
export function quoteBooking(input: BookingQuoteInput): QuoteOutcome {
  const durationMinutes = bookingDurationMinutes(input.startsAt, input.endsAt, input.timeZone)
  if (!(durationMinutes > 0)) return { ok: false, reason: 'creneau-invalide' }
  if (input.discount && !validDiscount(input.discount)) return { ok: false, reason: 'remise-invalide' }

  const day = toIsoDate(input.startsAt, input.timeZone)
  const valid = input.plans.filter(({ plan }) => isRatePlanValidOn(plan, day))
  if (valid.length === 0) return { ok: false, reason: 'aucune-grille' }

  for (const { plan, source } of valid) {
    const options = bookableUnits.flatMap((unit) => {
      const item = resolveRate(plan, {
        resourceId: input.resource.id,
        resourceType: input.resource.resourceType,
        unit,
        on: day,
      })
      if (!item) return []
      const quantity = billableQuantity(unit, durationMinutes, input.rules)
      return [{ unit, quantity, unitPriceCents: item.amountCents, grossCents: quantity * item.amountCents, itemId: item.id }]
    })
    if (options.length === 0) continue

    // Le moins cher ; à égalité, l'unité la plus large (dernière de `bookableUnits`).
    const best = options.reduce((retained, option) =>
      option.grossCents <= retained.grossCents ? option : retained,
    )

    const discountBp = input.discount?.kind === 'percent' && input.discount.basisPoints > 0 ? input.discount.basisPoints : null
    const discountAmountCents = input.discount?.kind === 'amount' && input.discount.cents > 0 ? input.discount.cents : null
    if (discountAmountCents !== null && discountAmountCents > best.grossCents) {
      return { ok: false, reason: 'remise-excessive' }
    }

    const netCents = lineNetAmountCents({
      quantity: best.quantity,
      unitPriceCents: best.unitPriceCents,
      discountBp,
      discountAmountCents,
    })
    const vatRateBp = input.rules.defaultVatRateBp
    const vatCents = vatAmountCents(netCents, vatRateBp)

    return {
      ok: true,
      quote: {
        unit: best.unit,
        quantity: best.quantity,
        unitPriceCents: best.unitPriceCents,
        grossCents: best.grossCents,
        durationMinutes,
        discountBp,
        discountAmountCents,
        discountCents: best.grossCents - netCents,
        netCents,
        vatRateBp,
        vatCents,
        totalCents: netCents + vatCents,
        currency: plan.currency,
        ratePlanId: plan.id,
        ratePlanName: plan.name,
        ratePlanItemId: best.itemId,
        source,
        options: options.map(({ unit, quantity, unitPriceCents, grossCents }) => ({
          unit,
          quantity,
          unitPriceCents,
          grossCents,
        })),
      },
    }
  }

  return { ok: false, reason: 'aucun-tarif' }
}

/**
 * Colonnes `quote_*` de `bookings` pour un devis retenu : ce qui est figé sur
 * la réservation. Le montant HT n'en fait pas partie : la base le calcule
 * (`quote_amount_cents`, colonne générée), par la même règle.
 */
export function bookingQuoteColumns(quote: BookingQuote, quotedAt: Date) {
  return {
    quoteUnit: quote.unit as RateUnit,
    quoteQuantity: quote.quantity,
    quoteUnitPriceCents: quote.unitPriceCents,
    quoteDiscountBp: quote.discountBp,
    quoteDiscountAmountCents: quote.discountAmountCents,
    quoteVatRateBp: quote.vatRateBp,
    quoteCurrency: quote.currency,
    quoteRatePlanItemId: quote.ratePlanItemId,
    quotedAt,
  }
}

/**
 * Lit la remise saisie dans un formulaire : un pourcentage (« 10 », « 12,5 »)
 * ou un montant en euros (« 15 », « 15,50 »). Sans forme choisie, ou avec une
 * valeur vide, pas de remise.
 */
export function parseQuoteDiscount(
  kind: string,
  value: string,
): { ok: true; discount: QuoteDiscount | null } | { ok: false; message: string } {
  const trimmed = value.trim()
  if (kind === '' || trimmed === '') return { ok: true, discount: null }
  if (kind === 'percent') {
    const basisPoints = parsePercentToBasisPoints(trimmed)
    return basisPoints === undefined
      ? { ok: false, message: 'Pourcentage illisible : de 0 à 100, deux décimales au plus. Exemple : 10 ou 12,5' }
      : { ok: true, discount: { kind: 'percent', basisPoints } }
  }
  if (kind === 'amount') {
    const cents = parseAmountToCents(trimmed)
    return cents === undefined
      ? { ok: false, message: 'Montant illisible. Exemple : 15,00' }
      : { ok: true, discount: { kind: 'amount', cents } }
  }
  return { ok: false, message: 'Forme de remise inconnue.' }
}

/** Colonnes `quote_*` d'une réservation non chiffrée : tout ou rien (`bookings_quote_complete`). */
export const NO_BOOKING_QUOTE = {
  quoteUnit: null,
  quoteQuantity: null,
  quoteUnitPriceCents: null,
  quoteDiscountBp: null,
  quoteDiscountAmountCents: null,
  quoteVatRateBp: null,
  quoteCurrency: null,
  quoteRatePlanItemId: null,
  quotedAt: null,
} as const
