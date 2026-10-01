import type { PaymentMethod, ProrataRule, RecurringBillingTiming } from '../../db/tenants.ts'
import { invoiceAmounts, lineNetAmountCents, type InvoiceAmounts } from './montants.ts'
import {
  billablePieces,
  containsDay,
  OPEN_END,
  prorataFor,
  subtractRanges,
  type DateRange,
  type RunWindows,
  type VersionSpan,
} from './periodes.ts'
import type { InvoiceLineKind, VatCategory } from './schema-factures.ts'
import type { BillingPeriod, RateUnit } from './schema.ts'

/**
 * Lot de facturation périodique (R13, R14, R15, ADR 026, ADR 028) : à partir
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
  serviceId: null,
  resourceId: null,
} as const

/**
 * Catégorie de TVA d'un taux (EN 16931, BT-151) : `S` dès qu'il y a un taux ;
 * un taux nul est traité comme une exonération (`E`), dont le motif se
 * complète sur le brouillon.
 */
export function vatCategoryFor(vatRateBp: number): VatCategory {
  return vatRateBp > 0 ? 'S' : 'E'
}

/** « 12/09/2026 ». */
export function dayLabel(isoDate: string): string {
  return `${isoDate.slice(8, 10)}/${isoDate.slice(5, 7)}/${isoDate.slice(0, 4)}`
}

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
 * lignes de sa version, ou à son montant pour une version sans ligne, au
 * prorata d'une période partielle. Une ligne ponctuelle (frais de dossier) est
 * facturée une fois, avec le premier morceau de sa version.
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
  for (const { version, civil, piece } of pieces) {
    const versionLines = contract.lines
      .filter((line) => line.amendmentId === version.amendmentId)
      .sort((a, b) => a.position - b.position)
    const prorata = (range: DateRange) =>
      prorataFor(settings.prorataRule, range, civil, contract.billingPeriod)

    if (versionLines.length === 0) {
      if (version.amountCents <= 0) continue
      for (const rest of subtractRanges(piece, billed.get(contractKey(contract.id, null)) ?? [])) {
        const fraction = prorata(rest)
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
      continue
    }

    const recurring = versionLines.filter((line) => line.isRecurring)
    if (recurring.length === 0 && version.amountCents > 0) {
      // La base refuse un loyer global à côté de lignes, même ponctuelles :
      // le montant saisi d'une telle version n'a pas de chemin vers la facture.
      warnings.push({
        clientId: contract.clientId,
        message: `Contrat ${contract.reference}${versionSuffix(version)} : la version n’a que des lignes ponctuelles, son loyer n’est pas facturable par le lot. À facturer à la main.`,
      })
    }
    for (const line of recurring) {
      for (const rest of subtractRanges(piece, billed.get(contractKey(contract.id, line.id)) ?? [])) {
        const fraction = prorata(rest)
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
 * Un forfait souscrit, au prix figé de la souscription. Mensuel : chaque mois
 * civil de la fenêtre, au prorata des jours souscrits. À la prestation : une
 * fois, dans le lot de son premier jour. Les autres unités ne se facturent
 * pas par un lot (ADR 028).
 */
export function subscriptionInvoiceLines(
  subscription: BillingSubscription,
  billed: BilledRanges,
  settings: RunSettings,
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
    for (const { civil, piece } of pieces) {
      for (const rest of subtractRanges(piece, taken)) {
        lines.push(draft(rest, prorataFor(settings.prorataRule, rest, civil, 'monthly')))
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

/** Souscription du client en vigueur ce jour-là : la plus ancienne si plusieurs. */
function subscriptionOn(
  subscriptions: readonly BillingActSubscription[],
  clientId: string,
  day: string,
): BillingActSubscription | undefined {
  return subscriptions
    .filter(
      (subscription) =>
        subscription.clientId === clientId &&
        containsDay({ start: subscription.startsOn, end: subscription.endsOn ?? OPEN_END }, day),
    )
    .sort((a, b) => (a.startsOn < b.startsOn ? -1 : a.startsOn > b.startsOn ? 1 : a.id < b.id ? -1 : 1))[0]
}

/**
 * Plis ouverts de la période, valorisés (ADR 024) :
 *
 * 1. la souscription du client en vigueur le jour de l'ouverture : ses
 *    `included_quantity` premiers actes de la période, par ordre d'ouverture,
 *    sont inclus — une ligne à 0 €, mention « inclus » ; les suivants sont dus
 *    à son prix figé, remise comprise ;
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
  const byClient = new Map<string, InvoiceLineDraft[]>()
  const warnings: RunWarning[] = []
  const ordered = [...items].sort(
    (a, b) => a.openedAt.getTime() - b.openedAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )

  if (!service) {
    const pending = new Map<string, number>()
    for (const item of ordered) {
      if (!item.held) pending.set(item.clientId, (pending.get(item.clientId) ?? 0) + 1)
    }
    for (const [clientId, count] of pending) {
      warnings.push({
        clientId,
        message: `${count} pli${count > 1 ? 's' : ''} ouvert${count > 1 ? 's' : ''} non valorisé${count > 1 ? 's' : ''} : aucun service de code « courrier.ouverture » au catalogue.`,
      })
    }
    return { byClient, warnings }
  }

  const ranks = new Map<string, number>()
  for (const item of ordered) {
    const subscription = subscriptionOn(subscriptions, item.clientId, item.day)
    const rankKey = subscription?.id ?? `catalogue|${item.clientId}`
    const rank = (ranks.get(rankKey) ?? 0) + 1
    ranks.set(rankKey, rank)
    if (item.held) continue

    const currency = subscription?.currency ?? service.currency
    if (currency !== settings.currency) {
      warnings.push({
        clientId: item.clientId,
        message: `Pli ouvert le ${dayLabel(item.day)} : prix en ${currency}, à facturer à la main.`,
      })
      continue
    }

    const included = subscription !== undefined && rank <= (subscription.includedQuantity ?? 0)
    const unitPriceCents = included ? 0 : (subscription?.unitPriceCents ?? service.unitPriceCents)
    const vatRateBp = subscription?.vatRateBp ?? service.vatRateBp
    const line: InvoiceLineDraft = {
      ...EMPTY_SOURCES,
      kind: 'act',
      description: `${service.name} — pli ouvert le ${dayLabel(item.day)}${included ? ', inclus' : ''}`,
      periodStart: item.day,
      periodEnd: item.day,
      quantity: 1,
      unit: 'unit',
      unitPriceCents,
      discountBp: included ? null : (subscription?.discountBp ?? null),
      // Une remise en montant se compte par acte et ne dépasse pas son prix.
      discountAmountCents:
        included || subscription?.discountAmountCents == null
          ? null
          : Math.min(subscription.discountAmountCents, unitPriceCents),
      prorataNumerator: null,
      prorataDenominator: null,
      vatRateBp,
      vatCategory: vatCategoryFor(vatRateBp),
      subscribedServiceId: subscription?.id ?? null,
      mailItemId: item.id,
      serviceId: service.id,
    }
    const clientLines = byClient.get(item.clientId)
    if (clientLines) clientLines.push(line)
    else byClient.set(item.clientId, [line])
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
}

export type ClientRun = { clientId: string; lines: InvoiceLineDraft[]; warnings: RunWarning[] }

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Lignes de chaque client pour le lot, dans l'ordre de la facture : loyers et
 * lignes des contrats, forfaits souscrits, réservations, actes. Un client sans
 * ligne ni avertissement n'apparaît pas.
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
  for (const subscription of subscriptions) {
    const { lines, warnings } = subscriptionInvoiceLines(subscription, sources.subscriptionBilled, settings)
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

  return [...runs.values()]
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
