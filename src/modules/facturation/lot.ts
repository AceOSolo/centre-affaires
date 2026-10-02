import type { PaymentMethod, ProrataRule, RecurringBillingTiming } from '../../db/tenants.ts'
import { formatCalendarDate } from '../../lib/dates.ts'
import { invoiceAmounts, lineNetAmountCents, type InvoiceAmounts } from './montants.ts'
import {
  billablePieces,
  containsDay,
  intersect,
  OPEN_END,
  prorataFor,
  subtractRanges,
  type DateRange,
  type RunWindows,
  type VersionSpan,
} from './periodes.ts'
import type { InvoiceLineKind, VatCategory } from './schema-factures.ts'
import type { BillingPeriod, RateUnit } from './schema.ts'
import { priceActs } from './souscriptions-regles.ts'

/**
 * Lot de facturation périodique (R13, R14, R15, ADR 026, ADR 029) : à partir
 * de ce qui est dû — échéances des contrats, forfaits souscrits, réservations,
 * actes du courrier —, les lignes de la facture brouillon de chaque client.
 *
 * Module pur : il reçoit les sources lues en base, et ce qui est déjà facturé,
 * et rend des lignes. Il ne décide d'aucun montant final : il pose quantité,
 * prix, remise et prorata, et la base calcule le net, la TVA et les totaux
 * (ADR 023, 026). `previewAmounts` les annonce, pour l'écran, par les jumeaux
 * TypeScript de ces règles.
 *
 * Chaque ligne garde sa source. La base refuse de facturer deux fois la même
 * (ADR 026) ; ce module ne propose de toute façon que ce qui reste à facturer,
 * pour qu'un lot rejoué n'échoue pas sur ce qu'il a déjà fait.
 */

/** Ligne de facture à écrire : tout sauf ce que la base calcule. */
export type InvoiceLineDraft = {
  kind: InvoiceLineKind
  description: string
  periodStart: string | null
  periodEnd: string | null
  quantity: number
  unit: RateUnit | null
  unitPriceCents: number
  discountBp: number | null
  discountAmountCents: number | null
  prorataNumerator: number | null
  prorataDenominator: number | null
  vatRateBp: number
  vatCategory: VatCategory
  contractId: string | null
  contractLineId: string | null
  bookingId: string | null
  subscribedServiceId: string | null
  mailItemId: string | null
  /** Demande de courrier faite : numérisation ou réexpédition, et ses frais (ADR 037). */
  mailRequestId: string | null
  serviceId: string | null
  resourceId: string | null
}

/** Ce que le lot n'a pas pu valoriser, à reprendre à la main. */
export type RunWarning = { clientId?: string; message: string }

export type RunSettings = {
  windows: RunWindows
  timing: RecurringBillingTiming
  prorataRule: ProrataRule
  /** Devise des factures du centre. */
  currency: string
}

const EMPTY_SOURCES = {
  contractId: null,
  contractLineId: null,
  bookingId: null,
  subscribedServiceId: null,
  mailItemId: null,
  mailRequestId: null,
  serviceId: null,
  resourceId: null,
} as const

/**
 * Catégorie de TVA d'un taux (EN 16931, BT-151) : `S` dès qu'il y a un taux ;
 * un taux nul est traité comme une exonération (`E`), dont le motif (BT-120)
 * se complète sur le brouillon : `issue_invoice()` refuse d'émettre sans lui
 * (ADR 032).
 */
export function vatCategoryFor(vatRateBp: number): VatCategory {
  return vatRateBp > 0 ? 'S' : 'E'
}

/** « 12/09/2026 ». */
export const dayLabel = formatCalendarDate

/* -------------------------------------------------------------------------- */
/* Contrats : loyers et lignes, par version (ADR 025)                          */
/* -------------------------------------------------------------------------- */

/** Une version de prix, telle que `contract_price_versions()` la rend. */
export type BillingPriceVersion = VersionSpan & {
  amendmentId: string | null
  amendmentNumber: number | null
  amountCents: number
}

/** Une ligne vivante du contrat, de la version initiale ou d'un avenant. */
export type BillingContractLine = {
  id: string
  amendmentId: string | null
  description: string
  quantity: number
  unit: RateUnit
  unitPriceCents: number
  discountBp: number | null
  discountAmountCents: number | null
  vatRateBp: number
  isRecurring: boolean
  serviceId: string | null
  resourceId: string | null
  position: number
}

/** Segment d'occupation (`contract_segments`) : la ressource en vigueur. */
export type BillingSegment = { startsOn: string; endsOn: string | null; resourceId: string | null }

export type BillingContract = {
  id: string
  clientId: string
  reference: string
  /** Nature lisible : « Bureau privatif », « Domiciliation ». */
  label: string
  billingPeriod: BillingPeriod
  currency: string
  /** TVA d'une version sans ligne (`contracts.vat_rate_bp`). */
  vatRateBp: number
  versions: readonly BillingPriceVersion[]
  lines: readonly BillingContractLine[]
  segments: readonly BillingSegment[]
}

/** Jours déjà facturés, par source (ADR 026). */
export type BilledRanges = ReadonlyMap<string, readonly DateRange[]>

/** Clé d'une source de loyer : le contrat, et la ligne de contrat ou rien. */
export function contractKey(contractId: string, contractLineId: string | null): string {
  return `${contractId}|${contractLineId ?? ''}`
}

/**
 * Jours qu'un morceau de la version `version` ne facture plus sous la clé
 * `key` (ADR 032) : ceux que sa propre clé a déjà facturés, et tous ceux
 * qu'une **autre version** du contrat a facturés, quelle que soit leur clé.
 *
 * Deux lignes d'une même version se facturent chacune pour son compte : un
 * avoir qui ne crédite que l'une la rend seule facturable à nouveau. Mais une
 * version ne refacture jamais un jour qu'une autre a déjà facturé — un avenant
 * signé après la facturation de sa période, ou un lot rejoué après un avenant
 * rétroactif, sans quoi la période serait due deux fois.
 *
 * Propriétaire d'une clé : la version de sa ligne de contrat ; une ligne
 * inconnue est réputée d'une autre version. Le loyer global (clé sans ligne)
 * est celui d'une version sans ligne récurrente : il appartient à `version`
 * quand elle n'en a pas, à une autre sinon.
 */
function takenFor(
  contract: BillingContract,
  billed: BilledRanges,
  version: BillingPriceVersion,
  key: string,
): DateRange[] {
  const prefix = `${contract.id}|`
  const owners = new Map(contract.lines.map((line) => [line.id, line.amendmentId]))
  const ownsGlobalRent = !contract.lines.some(
    (line) => line.amendmentId === version.amendmentId && line.isRecurring,
  )
  const taken: DateRange[] = []
  for (const [candidate, ranges] of billed) {
    if (!candidate.startsWith(prefix)) continue
    const lineId = candidate.slice(prefix.length)
    const sameVersion =
      lineId === ''
        ? ownsGlobalRent
        : owners.has(lineId) && owners.get(lineId) === version.amendmentId
    if (candidate === key || !sameVersion) taken.push(...ranges)
  }
  return taken
}

const versionSuffix = (version: BillingPriceVersion) =>
  version.amendmentNumber ? `, avenant n° ${version.amendmentNumber}` : ''

function resourceAt(segments: readonly BillingSegment[], day: string): string | null {
  return (
    segments.find((segment) =>
      containsDay({ start: segment.startsOn, end: segment.endsOn ?? OPEN_END }, day),
    )?.resourceId ?? null
  )
}

/**
 * Échéances d'un contrat engagé dans la fenêtre du lot. Chaque période civile
 * est coupée aux dates d'effet des avenants ; chaque morceau est facturé aux
 * lignes récurrentes de sa version, ou à son montant pour une version sans
 * ligne récurrente, au prorata d'une période partielle. Une ligne ponctuelle
 * (frais de dossier) est facturée une fois, avec le premier morceau de sa
 * version. Un jour déjà facturé, par cette version ou par une autre, ne l'est
 * pas une seconde fois (`takenFor`).
 */
export function contractInvoiceLines(
  contract: BillingContract,
  billed: BilledRanges,
  settings: RunSettings,
): { lines: InvoiceLineDraft[]; warnings: RunWarning[] } {
  const lines: InvoiceLineDraft[] = []
  const warnings: RunWarning[] = []
  if (contract.currency !== settings.currency) {
    warnings.push({
      clientId: contract.clientId,
      message: `Contrat ${contract.reference} en ${contract.currency} : les factures du centre sont en ${settings.currency}. À facturer à la main.`,
    })
    return { lines, warnings }
  }

  const pieces = billablePieces(
    contract.versions,
    contract.billingPeriod,
    settings.windows.recurring,
    settings.timing,
  )
  const contractStart = contract.versions.reduce<string | null>(
    (earliest, version) => (earliest === null || version.startsOn < earliest ? version.startsOn : earliest),
    null,
  )
  for (const { version, civil, piece } of pieces) {
    const versionLines = contract.lines
      .filter((line) => line.amendmentId === version.amendmentId)
      .sort((a, b) => a.position - b.position)
    const prorata = (range: DateRange) =>
      prorataFor(settings.prorataRule, range, civil, contract.billingPeriod)
    // Sans prorata, une période entamée est due en entier au prix de la version
    // en vigueur sur son premier jour couvert : une version qui prend effet en
    // cours de période compte à partir de la suivante, comme dans l'échéancier
    // du contrat (`contractSchedule`) — sans quoi la période serait due deux fois.
    const firstCovered = contractStart && contractStart > civil.start ? contractStart : civil.start
    const recurringDue = settings.prorataRule !== 'none' || piece.start === firstCovered
    const recurring = versionLines.filter((line) => line.isRecurring)

    // Sans ligne récurrente, la version se facture de son montant (loyer
    // global), à côté de ses éventuelles lignes ponctuelles.
    if (recurring.length === 0 && version.amountCents > 0 && recurringDue) {
      const key = contractKey(contract.id, null)
      for (const rest of subtractRanges(piece, takenFor(contract, billed, version, key))) {
        const fraction = prorata(rest)
        // En base 30, un 31 isolé ne doit rien (0/30) : pas de ligne.
        if (fraction?.numerator === 0) continue
        lines.push({
          ...EMPTY_SOURCES,
          kind: 'rent',
          description: `${contract.label} — contrat ${contract.reference}${versionSuffix(version)}`,
          periodStart: rest.start,
          periodEnd: rest.end,
          quantity: 1,
          unit: contract.billingPeriod === 'monthly' ? 'month' : null,
          unitPriceCents: version.amountCents,
          discountBp: null,
          discountAmountCents: null,
          prorataNumerator: fraction?.numerator ?? null,
          prorataDenominator: fraction?.denominator ?? null,
          vatRateBp: contract.vatRateBp,
          vatCategory: vatCategoryFor(contract.vatRateBp),
          contractId: contract.id,
          resourceId: resourceAt(contract.segments, rest.start),
        })
      }
    }

    for (const line of recurringDue ? recurring : []) {
      const key = contractKey(contract.id, line.id)
      for (const rest of subtractRanges(piece, takenFor(contract, billed, version, key))) {
        const fraction = prorata(rest)
        if (fraction?.numerator === 0) continue
        lines.push(contractLineDraft(contract, version, line, rest, fraction))
      }
    }

    // Ponctuelle : due une fois, au premier jour de sa version (la base le
    // pose d'office) ; facturée avec le morceau qui commence ce jour-là.
    if (piece.start === version.startsOn) {
      for (const line of versionLines.filter((candidate) => !candidate.isRecurring)) {
        const day = { start: version.startsOn, end: version.startsOn }
        if (subtractRanges(day, billed.get(contractKey(contract.id, line.id)) ?? []).length === 0) {
          continue
        }
        lines.push(contractLineDraft(contract, version, line, day, null))
      }
    }
  }
  return { lines, warnings }
}

function contractLineDraft(
  contract: BillingContract,
  version: BillingPriceVersion,
  line: BillingContractLine,
  range: DateRange,
  fraction: { numerator: number; denominator: number } | null,
): InvoiceLineDraft {
  return {
    ...EMPTY_SOURCES,
    // Un forfait de service porté par le contrat se facture en forfait, le
    // reste (ressource, type de ressource, ligne libre) en loyer.
    kind: line.serviceId ? 'package' : 'rent',
    description: `${line.description} — contrat ${contract.reference}${versionSuffix(version)}`,
    periodStart: range.start,
    periodEnd: range.end,
    quantity: line.quantity,
    unit: line.unit,
    unitPriceCents: line.unitPriceCents,
    discountBp: line.discountBp,
    discountAmountCents: line.discountAmountCents,
    prorataNumerator: fraction?.numerator ?? null,
    prorataDenominator: fraction?.denominator ?? null,
    vatRateBp: line.vatRateBp,
    vatCategory: vatCategoryFor(line.vatRateBp),
    contractId: contract.id,
    contractLineId: line.id,
    serviceId: line.serviceId,
    resourceId: line.resourceId,
  }
}

/* -------------------------------------------------------------------------- */
/* Forfaits souscrits (R18, ADR 024)                                           */
/* -------------------------------------------------------------------------- */

export type BillingSubscription = {
  id: string
  clientId: string
  contractId: string | null
  serviceId: string
  serviceName: string
  quantity: number
  unit: RateUnit
  unitPriceCents: number
  discountBp: number | null
  discountAmountCents: number | null
  vatRateBp: number
  currency: string
  startsOn: string
  endsOn: string | null
}

/**
 * Chaîne d'une souscription : celles du même client, au même service, pour le
 * même contrat (ou sans contrat). Un changement de conditions (ADR 024) coupe
 * une souscription la veille de sa date d'effet et en ouvre une autre dans la
 * même chaîne ; `subscribed_services_no_overlap` interdit qu'elles se
 * recouvrent.
 */
export function subscriptionChainKey(
  subscription: Pick<BillingSubscription, 'clientId' | 'serviceId' | 'contractId'>,
): string {
  return `${subscription.clientId}|${subscription.serviceId}|${subscription.contractId ?? ''}`
}

/**
 * Un forfait souscrit, au prix figé de la souscription. Mensuel : chaque mois
 * civil de la fenêtre, au prorata des jours souscrits. À la prestation : une
 * fois, dans le lot de son premier jour. Les autres unités ne se facturent
 * pas par un lot (ADR 029).
 *
 * Sans prorata (règle `none`), un mois entamé est dû en entier, une seule fois
 * par chaîne (`chain`, la souscription comprise) : au prix de la souscription
 * en vigueur sur le premier jour couvert du mois. Celle qui prend la suite en
 * cours de mois compte à partir du mois suivant, comme une version de contrat
 * (ADR 032).
 */
export function subscriptionInvoiceLines(
  subscription: BillingSubscription,
  billed: BilledRanges,
  settings: RunSettings,
  chain: readonly BillingSubscription[] = [subscription],
): { lines: InvoiceLineDraft[]; warnings: RunWarning[] } {
  const lines: InvoiceLineDraft[] = []
  const warnings: RunWarning[] = []
  if (subscription.currency !== settings.currency) {
    warnings.push({
      clientId: subscription.clientId,
      message: `Forfait « ${subscription.serviceName} » souscrit en ${subscription.currency} : à facturer à la main.`,
    })
    return { lines, warnings }
  }

  const taken = billed.get(subscription.id) ?? []
  const draft = (range: DateRange, fraction: { numerator: number; denominator: number } | null) => ({
    ...EMPTY_SOURCES,
    kind: 'package' as const,
    description: subscription.serviceName,
    periodStart: range.start,
    periodEnd: range.end,
    quantity: subscription.quantity,
    unit: subscription.unit,
    unitPriceCents: subscription.unitPriceCents,
    discountBp: subscription.discountBp,
    discountAmountCents: subscription.discountAmountCents,
    prorataNumerator: fraction?.numerator ?? null,
    prorataDenominator: fraction?.denominator ?? null,
    vatRateBp: subscription.vatRateBp,
    vatCategory: vatCategoryFor(subscription.vatRateBp),
    contractId: subscription.contractId,
    subscribedServiceId: subscription.id,
    serviceId: subscription.serviceId,
  })

  if (subscription.unit === 'month') {
    const pieces = billablePieces(
      [{ startsOn: subscription.startsOn, endsOn: subscription.endsOn }],
      'monthly',
      settings.windows.recurring,
      settings.timing,
    )
    const monthly = chain.filter((member) => member.unit === 'month')
    for (const { civil, piece } of pieces) {
      if (settings.prorataRule === 'none' && piece.start !== firstCoveredDay(monthly, civil)) continue
      for (const rest of subtractRanges(piece, taken)) {
        const fraction = prorataFor(settings.prorataRule, rest, civil, 'monthly')
        if (fraction?.numerator === 0) continue
        lines.push(draft(rest, fraction))
      }
    }
  } else if (subscription.unit === 'unit') {
    const day = { start: subscription.startsOn, end: subscription.startsOn }
    if (
      containsDay(settings.windows.recurring, subscription.startsOn) &&
      subtractRanges(day, taken).length > 0
    ) {
      lines.push(draft(day, null))
    }
  } else {
    warnings.push({
      clientId: subscription.clientId,
      message: `Forfait « ${subscription.serviceName} » souscrit dans une unité que le lot ne facture pas (seuls le mois et la prestation le sont) : à facturer à la main.`,
    })
  }
  return { lines, warnings }
}

/** Premier jour de la période civile couvert par l'une des souscriptions de la chaîne. */
function firstCoveredDay(chain: readonly BillingSubscription[], civil: DateRange): string | null {
  let first: string | null = null
  for (const member of chain) {
    const covered = intersect(civil, { start: member.startsOn, end: member.endsOn ?? OPEN_END })
    if (covered && (first === null || covered.start < first)) first = covered.start
  }
  return first
}

/* -------------------------------------------------------------------------- */
/* Réservations ponctuelles, au prix figé (R11)                               */
/* -------------------------------------------------------------------------- */

export type BookingQuote = {
  unit: RateUnit
  quantity: number
  unitPriceCents: number
  discountBp: number | null
  discountAmountCents: number | null
  vatRateBp: number
  currency: string
}

export type BillingBooking = {
  id: string
  clientId: string
  resourceId: string
  resourceName: string
  /** Jour du centre où la réservation commence. */
  day: string
  /** Heures du centre, « 09:00 ». */
  startTime: string
  endTime: string
  /** Devis figé à la réservation ; nul pour une réservation non chiffrée. */
  quote: BookingQuote | null
  /** Déjà tenue par une ligne de facture. */
  held: boolean
}

/** Une réservation confirmée, facturée à son devis : jamais au prix du jour (ADR 023). */
export function bookingInvoiceLine(
  booking: BillingBooking,
  settings: RunSettings,
): { line?: InvoiceLineDraft; warning?: RunWarning } {
  if (booking.held) return {}
  const label = `Réservation ${booking.resourceName} du ${dayLabel(booking.day)}`
  if (!booking.quote) {
    return {
      warning: {
        clientId: booking.clientId,
        message: `${label} sans prix figé : à facturer à la main.`,
      },
    }
  }
  if (booking.quote.currency !== settings.currency) {
    return {
      warning: {
        clientId: booking.clientId,
        message: `${label} chiffrée en ${booking.quote.currency} : à facturer à la main.`,
      },
    }
  }
  return {
    line: {
      ...EMPTY_SOURCES,
      kind: 'booking',
      description: `Réservation ${booking.resourceName} — ${dayLabel(booking.day)}, ${booking.startTime}–${booking.endTime}`,
      periodStart: booking.day,
      periodEnd: booking.day,
      quantity: booking.quote.quantity,
      unit: booking.quote.unit,
      unitPriceCents: booking.quote.unitPriceCents,
      discountBp: booking.quote.discountBp,
      discountAmountCents: booking.quote.discountAmountCents,
      prorataNumerator: null,
      prorataDenominator: null,
      vatRateBp: booking.quote.vatRateBp,
      vatCategory: vatCategoryFor(booking.quote.vatRateBp),
      bookingId: booking.id,
      resourceId: booking.resourceId,
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Actes du courrier (R14, ADR 024)                                            */
/* -------------------------------------------------------------------------- */

export type BillingMailItem = {
  id: string
  clientId: string
  /** Instant d'ouverture, pour l'ordre des actes. */
  openedAt: Date
  /** Jour du centre de l'ouverture. */
  day: string
  held: boolean
}

/** Le service de l'acte, retrouvé par son code (`courrier.ouverture`). */
export type BillingActService = {
  id: string
  name: string
  unitPriceCents: number
  vatRateBp: number
  currency: string
}

export type BillingActSubscription = {
  id: string
  clientId: string
  /** Actes inclus par période de facturation. */
  includedQuantity: number | null
  unitPriceCents: number
  discountBp: number | null
  discountAmountCents: number | null
  vatRateBp: number
  currency: string
  startsOn: string
  endsOn: string | null
}

/**
 * Plis ouverts de la période, valorisés par la règle unique des actes
 * (`priceActs`, ADR 024) :
 *
 * 1. la souscription du client en vigueur le jour de l'ouverture : ses
 *    `included_quantity` premiers actes de la période, par ordre d'ouverture,
 *    sont inclus — une ligne à 0 €, mention « inclus » ; les suivants sont dus
 *    à son prix figé, remise comprise ; deux souscriptions en vigueur le même
 *    jour : la plus avantageuse pour le client ;
 * 2. sans souscription, le prix du catalogue.
 *
 * Le rang d'un acte se compte sur tous les plis de la période, facturés ou
 * non : un lot rejoué ne déplace pas les inclus. Sans service au catalogue,
 * rien n'est valorisé et chaque client concerné reçoit un avertissement.
 */
export function mailActInvoiceLines(
  items: readonly BillingMailItem[],
  service: BillingActService | null,
  subscriptions: readonly BillingActSubscription[],
  settings: RunSettings,
): { byClient: Map<string, InvoiceLineDraft[]>; warnings: RunWarning[] } {
  return actInvoiceLines(
    items.map((item) => ({ ...item, at: item.openedAt })),
    service,
    subscriptions,
    settings,
    {
      occurrence: (day) => `pli ouvert le ${day}`,
      unvalued: (count) =>
        `${count} pli${count > 1 ? 's' : ''} ouvert${count > 1 ? 's' : ''} non valorisé${count > 1 ? 's' : ''} : aucun service de code « courrier.ouverture » au catalogue.`,
      foreignCurrency: (day) => `Pli ouvert le ${day}`,
      source: (act) => ({ mailItemId: act.id }),
    },
  )
}

/** Un acte à valoriser : un pli ouvert, une numérisation ou une réexpédition faite. */
type BillableAct = {
  id: string
  clientId: string
  /** Instant de l'acte, pour l'ordre : les premiers de la période sont les inclus. */
  at: Date
  /** Jour du centre de l'acte. */
  day: string
  /** Déjà tenu par une ligne de facture. */
  held: boolean
}

/** Ce qui change d'une nature d'acte à l'autre : les mots, et la source de la ligne. */
type ActWording = {
  /** « pli ouvert le 03/09/2026 », désignation de la ligne après le service. */
  occurrence: (day: string) => string
  /** Avertissement d'un client dont les actes ne sont pas valorisés, faute de service. */
  unvalued: (count: number) => string
  /** « Pli ouvert le 03/09/2026 », en tête d'un avertissement de devise. */
  foreignCurrency: (day: string) => string
  source: (act: BillableAct) => Partial<Pick<InvoiceLineDraft, 'mailItemId' | 'mailRequestId'>>
}

/**
 * La règle unique des actes (`priceActs`, ADR 024), quelle que soit leur
 * nature : par client, les inclus de la souscription en vigueur le jour de
 * l'acte, à 0 €, puis son prix figé, sinon le catalogue. Le rang se compte sur
 * tous les actes de la période, facturés ou non.
 */
function actInvoiceLines(
  acts: readonly BillableAct[],
  service: BillingActService | null,
  subscriptions: readonly BillingActSubscription[],
  settings: RunSettings,
  wording: ActWording,
): { byClient: Map<string, InvoiceLineDraft[]>; warnings: RunWarning[] } {
  const byClient = new Map<string, InvoiceLineDraft[]>()
  const warnings: RunWarning[] = []

  const actsByClient = new Map<string, BillableAct[]>()
  for (const act of acts) {
    const clientActs = actsByClient.get(act.clientId)
    if (clientActs) clientActs.push(act)
    else actsByClient.set(act.clientId, [act])
  }

  if (!service) {
    for (const [clientId, clientActs] of actsByClient) {
      const count = clientActs.filter((act) => !act.held).length
      if (count === 0) continue
      warnings.push({ clientId, message: wording.unvalued(count) })
    }
    return { byClient, warnings }
  }

  for (const [clientId, clientActs] of actsByClient) {
    const clientSubscriptions = subscriptions.filter((subscription) => subscription.clientId === clientId)
    const actById = new Map(clientActs.map((act) => [act.id, act]))
    const priced = priceActs(
      clientActs.map((act) => ({ id: act.id, day: act.day, at: act.at })),
      clientSubscriptions,
      service,
    )
    for (const pricedAct of priced) {
      const act = actById.get(pricedAct.actId)
      if (!act || act.held || pricedAct.source === 'unpriced') continue
      if (pricedAct.currency !== settings.currency) {
        warnings.push({
          clientId,
          message: `${wording.foreignCurrency(dayLabel(act.day))} : prix en ${pricedAct.currency}, à facturer à la main.`,
        })
        continue
      }
      const included = pricedAct.source === 'included'
      const unitPriceCents = included ? 0 : (pricedAct.unitPriceCents ?? 0)
      const vatRateBp = pricedAct.vatRateBp ?? service.vatRateBp
      const amountDiscount = clientSubscriptions.find(
        (subscription) => subscription.id === pricedAct.subscriptionId,
      )?.discountAmountCents
      const line: InvoiceLineDraft = {
        ...EMPTY_SOURCES,
        kind: 'act',
        description: `${service.name} — ${wording.occurrence(dayLabel(act.day))}${included ? ', inclus' : ''}`,
        periodStart: act.day,
        periodEnd: act.day,
        quantity: 1,
        unit: 'unit',
        unitPriceCents,
        discountBp: included ? null : pricedAct.discountBp,
        // Une remise en montant (que la saisie refuse sur un acte) se compte
        // par acte et ne dépasse pas son prix.
        discountAmountCents:
          included || amountDiscount == null ? null : Math.min(amountDiscount, unitPriceCents),
        prorataNumerator: null,
        prorataDenominator: null,
        vatRateBp,
        vatCategory: vatCategoryFor(vatRateBp),
        subscribedServiceId: pricedAct.subscriptionId,
        ...wording.source(act),
        serviceId: service.id,
      }
      const clientLines = byClient.get(clientId)
      if (clientLines) clientLines.push(line)
      else byClient.set(clientId, [line])
    }
  }
  return { byClient, warnings }
}

/* -------------------------------------------------------------------------- */
/* Demandes de courrier faites (R21, ADR 037)                                 */
/* -------------------------------------------------------------------------- */

/** Natures de demande facturées par elles-mêmes ; l'ouverture l'est par son pli. */
export type BillableMailRequestKind = 'scan' | 'forward'

/** Une numérisation seule ou une réexpédition faite dans la période. */
export type BillingMailRequest = {
  id: string
  clientId: string
  kind: BillableMailRequestKind
  /** Instant où la demande a été faite, pour l'ordre des inclus. */
  completedAt: Date
  /** Jour du centre où elle a été faite. */
  day: string
  /** Son acte est déjà tenu par une ligne de facture. */
  held: boolean
  /**
   * Réexpédition : frais d'affranchissement relevés (0 compris). Sans eux,
   * elle attend : une fois l'acte facturé, la base fige les frais (CA008).
   */
  postageRecorded?: boolean
  /**
   * Demande d'un mois antérieur à la période, chargée pour le rang des inclus
   * de son mois, mais que le rattrapage ne reprend pas : faite avant que son
   * service n'entre au catalogue. Elle compte dans le rang, sans être
   * facturée ni signalée. Absent : facturable.
   */
  billable?: boolean
}

/**
 * Frais d'affranchissement relevés d'une réexpédition faite dans la période,
 * pas encore facturés : refacturés au centime relevé, une fois (ADR 037).
 */
export type BillingPostage = {
  requestId: string
  clientId: string
  /** Jour du centre de la réexpédition. */
  day: string
  postageCents: number
  currency: string
}

const requestWording: Record<BillableMailRequestKind, Omit<ActWording, 'source'>> = {
  scan: {
    occurrence: (day) => `numérisation du ${day}`,
    unvalued: (count) =>
      `${count} numérisation${count > 1 ? 's' : ''} non valorisée${count > 1 ? 's' : ''} : aucun service de code « courrier.numerisation » au catalogue.`,
    foreignCurrency: (day) => `Numérisation du ${day}`,
  },
  forward: {
    occurrence: (day) => `réexpédition du ${day}`,
    unvalued: (count) =>
      `${count} réexpédition${count > 1 ? 's' : ''} non valorisée${count > 1 ? 's' : ''} : aucun service de code « courrier.reexpedition » au catalogue.`,
    foreignCurrency: (day) => `Réexpédition du ${day}`,
  },
}

/**
 * Numérisations ou réexpéditions faites dans la période, valorisées par la
 * même règle que les plis ouverts, au service de leur nature
 * (`courrier.numerisation`, `courrier.reexpedition`) et aux souscriptions à ce
 * service : leurs inclus d'abord, par ordre de réalisation. Une demande déjà
 * tenue par une ligne compte dans le rang mais n'est pas refacturée.
 *
 * Une réexpédition dont les frais d'affranchissement ne sont pas relevés
 * attend, signalée : facturer son acte figerait ses frais (la base les refuse
 * dès qu'une ligne tient la demande), et ils ne seraient jamais refacturés.
 * Elle garde sa place dans le rang des inclus : notés ses frais — 0 s'il n'y
 * en a pas —, le lot rejoué la facture comme si elle n'avait pas attendu.
 *
 * Rattrapage : une demande d'un mois antérieur jamais tenue par une ligne
 * (réexpédition qui attendait ses frais, client dont la facture était déjà
 * émise) est reprise par le lot suivant, et signalée tant qu'elle attend. Le
 * rang des inclus se compte par mois civil de la demande (ADR 035) : chaque
 * mois est valorisé avec toutes ses demandes, facturées ou non, comme le lot
 * de son mois l'aurait fait.
 */
export function mailRequestInvoiceLines(
  requests: readonly BillingMailRequest[],
  kind: BillableMailRequestKind,
  service: BillingActService | null,
  subscriptions: readonly BillingActSubscription[],
  settings: RunSettings,
): { byClient: Map<string, InvoiceLineDraft[]>; warnings: RunWarning[] } {
  const ofKind = requests.filter((request) => request.kind === kind)
  const waiting = (request: BillingMailRequest) =>
    kind === 'forward' && request.postageRecorded === false && !request.held && request.billable !== false
  const byMonth = new Map<string, BillingMailRequest[]>()
  for (const request of ofKind) {
    const month = request.day.slice(0, 7)
    byMonth.set(month, [...(byMonth.get(month) ?? []), request])
  }
  const result: { byClient: Map<string, InvoiceLineDraft[]>; warnings: RunWarning[] } = {
    byClient: new Map(),
    warnings: [],
  }
  for (const month of [...byMonth.keys()].sort()) {
    const monthRun = actInvoiceLines(
      (byMonth.get(month) as BillingMailRequest[]).map((request) => ({
        ...request,
        at: request.completedAt,
        // Sans service, rien n'est valorisé : elle est comptée avec les autres.
        held: request.held || request.billable === false || (service !== null && waiting(request)),
      })),
      service,
      subscriptions,
      settings,
      { ...requestWording[kind], source: (act) => ({ mailRequestId: act.id }) },
    )
    for (const [clientId, lines] of monthRun.byClient) {
      result.byClient.set(clientId, [...(result.byClient.get(clientId) ?? []), ...lines])
    }
    result.warnings.push(...monthRun.warnings)
  }
  if (service) {
    const missing = new Map<string, number>()
    for (const request of ofKind.filter(waiting)) {
      missing.set(request.clientId, (missing.get(request.clientId) ?? 0) + 1)
    }
    for (const [clientId, count] of missing) {
      result.warnings.push({
        clientId,
        message: `${count} réexpédition${count > 1 ? 's' : ''} non facturée${count > 1 ? 's' : ''} : frais d’affranchissement non relevés. Notez-les sur la demande (0 s’il n’y en a pas), puis relancez le lot.`,
      })
    }
  }
  return result
}

/**
 * Frais d'affranchissement des réexpéditions, une ligne `other` chacun : au
 * centime relevé, quantité 1, sans remise ni prorata, dans la devise de la
 * facture — ce que la base exige (`invoice_lines_guard`, CA003). Leur TVA est
 * celle du service de réexpédition : des frais accessoires suivent la
 * prestation (*à valider* par l'expert-comptable, ADR 037). Sans ce service,
 * rien n'est facturé et le client est signalé.
 */
export function postageInvoiceLines(
  postages: readonly BillingPostage[],
  forwardService: BillingActService | null,
  settings: RunSettings,
): { byClient: Map<string, InvoiceLineDraft[]>; warnings: RunWarning[] } {
  const byClient = new Map<string, InvoiceLineDraft[]>()
  const warnings: RunWarning[] = []
  const sorted = [...postages].sort((a, b) => byText(a.day, b.day) || byText(a.requestId, b.requestId))
  if (!forwardService) {
    const counts = new Map<string, number>()
    for (const postage of sorted) counts.set(postage.clientId, (counts.get(postage.clientId) ?? 0) + 1)
    for (const [clientId, count] of counts) {
      warnings.push({
        clientId,
        message: `Frais d’affranchissement de ${count} réexpédition${count > 1 ? 's' : ''} non facturés : aucun service de code « courrier.reexpedition » au catalogue pour en fixer la TVA.`,
      })
    }
    return { byClient, warnings }
  }
  for (const postage of sorted) {
    if (postage.currency !== settings.currency) {
      warnings.push({
        clientId: postage.clientId,
        message: `Frais d’affranchissement de la réexpédition du ${dayLabel(postage.day)} en ${postage.currency} : à facturer à la main.`,
      })
      continue
    }
    const line: InvoiceLineDraft = {
      ...EMPTY_SOURCES,
      kind: 'other',
      description: `Frais d’affranchissement — réexpédition du ${dayLabel(postage.day)}`,
      periodStart: postage.day,
      periodEnd: postage.day,
      quantity: 1,
      unit: 'unit',
      unitPriceCents: postage.postageCents,
      discountBp: null,
      discountAmountCents: null,
      prorataNumerator: null,
      prorataDenominator: null,
      vatRateBp: forwardService.vatRateBp,
      vatCategory: vatCategoryFor(forwardService.vatRateBp),
      mailRequestId: postage.requestId,
    }
    const clientLines = byClient.get(postage.clientId)
    if (clientLines) clientLines.push(line)
    else byClient.set(postage.clientId, [line])
  }
  return { byClient, warnings }
}

/* -------------------------------------------------------------------------- */
/* Le lot : une facture par client (R15)                                      */
/* -------------------------------------------------------------------------- */

export type RunSources = {
  contracts: readonly BillingContract[]
  /** Jours déjà facturés par contrat et ligne de contrat (`contractKey`). */
  contractBilled: BilledRanges
  subscriptions: readonly BillingSubscription[]
  /** Jours déjà facturés par souscription. */
  subscriptionBilled: BilledRanges
  bookings: readonly BillingBooking[]
  mailItems: readonly BillingMailItem[]
  actService: BillingActService | null
  actSubscriptions: readonly BillingActSubscription[]
  /** Numérisations et réexpéditions faites dans la période (ADR 037). */
  mailRequests?: readonly BillingMailRequest[]
  /** Service et souscriptions de chaque nature de demande facturée. */
  requestServices?: Partial<Record<BillableMailRequestKind, BillingActService | null>>
  requestSubscriptions?: Partial<Record<BillableMailRequestKind, readonly BillingActSubscription[]>>
  /** Frais d'affranchissement relevés, pas encore facturés. */
  postages?: readonly BillingPostage[]
}

export type ClientRun = { clientId: string; lines: InvoiceLineDraft[]; warnings: RunWarning[] }

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Lignes de chaque client pour le lot, dans l'ordre de la facture : loyers et
 * lignes des contrats, forfaits souscrits, réservations, actes — plis ouverts,
 * puis numérisations, réexpéditions et frais d'affranchissement. Un client
 * sans ligne ni avertissement n'apparaît pas.
 */
export function computeRun(sources: RunSources, settings: RunSettings): ClientRun[] {
  const runs = new Map<string, ClientRun>()
  const runOf = (clientId: string) => {
    let run = runs.get(clientId)
    if (!run) {
      run = { clientId, lines: [], warnings: [] }
      runs.set(clientId, run)
    }
    return run
  }
  const add = (clientId: string, lines: readonly InvoiceLineDraft[], warnings: readonly RunWarning[]) => {
    if (lines.length === 0 && warnings.length === 0) return
    const run = runOf(clientId)
    run.lines.push(...lines)
    run.warnings.push(...warnings)
  }

  for (const contract of [...sources.contracts].sort((a, b) => byText(a.reference, b.reference))) {
    const { lines, warnings } = contractInvoiceLines(contract, sources.contractBilled, settings)
    add(contract.clientId, lines, warnings)
  }

  const subscriptions = [...sources.subscriptions].sort(
    (a, b) => byText(a.serviceName, b.serviceName) || byText(a.startsOn, b.startsOn),
  )
  const chains = new Map<string, BillingSubscription[]>()
  for (const subscription of subscriptions) {
    const key = subscriptionChainKey(subscription)
    chains.set(key, [...(chains.get(key) ?? []), subscription])
  }
  for (const subscription of subscriptions) {
    const { lines, warnings } = subscriptionInvoiceLines(
      subscription,
      sources.subscriptionBilled,
      settings,
      chains.get(subscriptionChainKey(subscription)),
    )
    add(subscription.clientId, lines, warnings)
  }

  const bookings = [...sources.bookings].sort(
    (a, b) => byText(a.day, b.day) || byText(a.startTime, b.startTime) || byText(a.id, b.id),
  )
  for (const booking of bookings) {
    const { line, warning } = bookingInvoiceLine(booking, settings)
    add(booking.clientId, line ? [line] : [], warning ? [warning] : [])
  }

  const acts = mailActInvoiceLines(sources.mailItems, sources.actService, sources.actSubscriptions, settings)
  for (const [clientId, lines] of acts.byClient) add(clientId, lines, [])
  for (const warning of acts.warnings) add(warning.clientId ?? '', [], [warning])

  // Puis les demandes faites : numérisations, réexpéditions, et les frais
  // d'affranchissement relevés (ADR 037).
  const requestRuns = (['scan', 'forward'] as const).map((kind) =>
    mailRequestInvoiceLines(
      sources.mailRequests ?? [],
      kind,
      sources.requestServices?.[kind] ?? null,
      sources.requestSubscriptions?.[kind] ?? [],
      settings,
    ),
  )
  requestRuns.push(postageInvoiceLines(sources.postages ?? [], sources.requestServices?.forward ?? null, settings))
  for (const requestRun of requestRuns) {
    for (const [clientId, lines] of requestRun.byClient) add(clientId, lines, [])
    for (const warning of requestRun.warnings) add(warning.clientId ?? '', [], [warning])
  }

  return [...runs.values()]
}

/**
 * Avertissement d'un client dont la facture de la période est déjà émise :
 * rien ne s'y ajoute. Les demandes de courrier (numérisations, réexpéditions
 * et leurs frais) restent sans ligne et le lot suivant les reprend : les
 * facturer à la main les ferait payer deux fois. Le reste est à facturer à
 * part.
 */
export function issuedInvoiceWarning(invoiceNumber: string | null, lines: readonly InvoiceLineDraft[]): string {
  const requests = lines.filter((line) => line.mailRequestId).length
  const others = lines.length - requests
  const parts: string[] = []
  if (others > 0) {
    parts.push(`${others} élément${others > 1 ? 's restent' : ' reste'} à facturer à part`)
  }
  if (requests > 0) {
    parts.push(
      `${requests} ligne${requests > 1 ? 's' : ''} de demandes de courrier ${requests > 1 ? 'seront reprises' : 'sera reprise'} par le lot suivant, ne ${requests > 1 ? 'les' : 'la'} facturez pas à la main`,
    )
  }
  return `La facture ${invoiceNumber} de la période est déjà émise : ${parts.join(' ; ')}.`
}

/**
 * Mode de paiement attendu d'une facture (ADR 027) : le prélèvement quand le
 * client a un mandat actif, sinon le mode par défaut du centre — le virement
 * si ce défaut est un prélèvement, qu'aucun mandat ne permet.
 */
export function expectedPaymentFor(
  defaultMethod: PaymentMethod,
  activeMandateId: string | null,
): { method: PaymentMethod; sepaMandateId: string | null } {
  if (activeMandateId) return { method: 'direct_debit', sepaMandateId: activeMandateId }
  return { method: defaultMethod === 'direct_debit' ? 'transfer' : defaultMethod, sepaMandateId: null }
}

/**
 * Montants annoncés d'un ensemble de lignes, avant écriture : net de chaque
 * ligne par la règle d'arrondi commune, TVA par taux et totaux (ADR 026). La
 * base recalcule et fait foi ; `montants.db.test.ts` tient les deux alignés.
 */
export function previewAmounts(lines: readonly InvoiceLineDraft[]): InvoiceAmounts {
  return invoiceAmounts(
    lines.map((line, index) => ({
      id: String(index).padStart(6, '0'),
      position: index,
      netAmountCents: lineNetAmountCents(line),
      vatRateBp: line.vatRateBp,
      vatCategory: line.vatCategory,
    })),
  )
}
