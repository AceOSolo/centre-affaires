import { amountDueCents } from '../facturation/montants.ts'
import type { InvoiceKind, InvoiceLineKind } from '../facturation/schema-factures.ts'
import { inPeriod, type Period } from './periode.ts'

/**
 * Chiffre d'affaires, encaissements et revenu par ressource et par service
 * (R31).
 *
 * **Source.** Les factures et avoirs **émis** (ADR 026) : un brouillon n'est
 * pas du chiffre d'affaires, un brouillon abandonné encore moins. Les montants
 * sont ceux que la base a calculés et figés — net HT des lignes, totaux des
 * documents — jamais recalculés ici.
 *
 * **Date.** Un document compte à sa date d'émission, jour du centre, comme en
 * comptabilité et dans l'export FEC (ADR 027) : un avoir émis en octobre sur
 * une facture de septembre réduit le chiffre d'octobre. Un paiement compte à sa
 * date de valeur (`paid_on`).
 *
 * **Avoirs.** Ils viennent en déduction : le revenu net d'une ressource est ce
 * que ses lignes ont facturé, moins ce que les lignes d'avoir qui les créditent
 * ont rendu. Une ligne d'avoir est rattachée à la ressource, au service et à la
 * nature de la ligne qu'elle crédite quand elle ne les porte pas elle-même.
 *
 * **Devise.** Une seule par calcul, celle du centre : additionner des euros et
 * des francs suisses n'a pas de sens. Ce qui est dans une autre devise est
 * compté à part et signalé, jamais converti.
 *
 * Tout est en centimes entiers (décision 5) ; aucune division, donc aucun
 * arrondi.
 *
 * Ces conventions (date d'émission plutôt que période de prestation, avoir
 * imputé au mois de son émission, trop-perçu non déduit du restant dû) sont
 * des choix par défaut, à valider par le centre et l'expert-comptable.
 */

/** Facturé, crédité par avoir, et la différence : le revenu net. */
export type RevenueAmounts = {
  /** Net HT des lignes de factures. */
  invoicedCents: number
  /** Net HT des lignes d'avoirs, en positif. */
  creditedCents: number
  /** Facturé moins crédité. */
  netCents: number
}

export const zeroAmounts = (): RevenueAmounts => ({ invoicedCents: 0, creditedCents: 0, netCents: 0 })

function addLine(into: RevenueAmounts, documentKind: InvoiceKind, netAmountCents: number): void {
  if (documentKind === 'credit_note') {
    into.creditedCents += netAmountCents
    into.netCents -= netAmountCents
  } else {
    into.invoicedCents += netAmountCents
    into.netCents += netAmountCents
  }
}

function sumAmounts(into: RevenueAmounts, amounts: RevenueAmounts): void {
  into.invoicedCents += amounts.invoicedCents
  into.creditedCents += amounts.creditedCents
  into.netCents += amounts.netCents
}

/**
 * Une ligne d'un document émis, telle que la requête la rend : ressource et
 * service déjà résolus depuis ses sources (réservation, ligne de contrat,
 * souscription) quand la ligne ne les porte pas.
 */
export type RevenueLine = {
  id: string
  documentKind: InvoiceKind
  currency: string
  kind: InvoiceLineKind
  quantity: number
  netAmountCents: number
  resourceId: string | null
  serviceId: string | null
  /** Ligne d'avoir : la ligne de facture qu'elle crédite. */
  creditedLineId: string | null
}

/** Ce qu'une ligne d'avoir hérite de la ligne qu'elle crédite. */
export type CreditedLineRef = Pick<RevenueLine, 'kind' | 'resourceId' | 'serviceId'>

/** Revenu d'un service, et le nombre d'actes facturés. */
export type ServiceRevenue = RevenueAmounts & {
  /** Actes facturés, moins ceux crédités par avoir. */
  acts: number
  /** Dont inclus dans une souscription, facturés à 0 € (ADR 024). */
  includedActs: number
}

export type RevenueBreakdown = {
  currency: string
  total: RevenueAmounts
  byResource: Map<string, RevenueAmounts>
  /** Lignes rattachées à aucune ressource : services, actes, remises, lignes libres. */
  withoutResource: RevenueAmounts
  byService: Map<string, ServiceRevenue>
  byKind: Map<InvoiceLineKind, RevenueAmounts>
  /** Lignes écartées parce qu'elles sont dans une autre devise. */
  otherCurrencyLines: number
}

/**
 * Ventile le revenu des lignes émises par ressource, par service et par nature.
 *
 * `creditedLines` donne, pour les lignes créditées absentes de `lines` (une
 * facture émise avant la période, créditée pendant), de quoi rattacher l'avoir.
 */
export function revenueBreakdown(
  lines: readonly RevenueLine[],
  currency: string,
  creditedLines: ReadonlyMap<string, CreditedLineRef> = new Map(),
): RevenueBreakdown {
  const own = new Map(lines.map((line) => [line.id, line]))
  const breakdown: RevenueBreakdown = {
    currency,
    total: zeroAmounts(),
    byResource: new Map(),
    withoutResource: zeroAmounts(),
    byService: new Map(),
    byKind: new Map(),
    otherCurrencyLines: 0,
  }

  for (const line of lines) {
    if (line.currency !== currency) {
      breakdown.otherCurrencyLines += 1
      continue
    }
    const credited = line.creditedLineId
      ? (own.get(line.creditedLineId) ?? creditedLines.get(line.creditedLineId))
      : undefined
    const resourceId = line.resourceId ?? credited?.resourceId ?? null
    const serviceId = line.serviceId ?? credited?.serviceId ?? null
    // La nature est celle de ce que l'avoir corrige : un avoir sur un loyer
    // réduit les loyers, même saisi en ligne libre.
    const kind = credited?.kind ?? line.kind

    addLine(breakdown.total, line.documentKind, line.netAmountCents)

    const byKind = breakdown.byKind.get(kind) ?? zeroAmounts()
    addLine(byKind, line.documentKind, line.netAmountCents)
    breakdown.byKind.set(kind, byKind)

    if (resourceId) {
      const amounts = breakdown.byResource.get(resourceId) ?? zeroAmounts()
      addLine(amounts, line.documentKind, line.netAmountCents)
      breakdown.byResource.set(resourceId, amounts)
    } else {
      addLine(breakdown.withoutResource, line.documentKind, line.netAmountCents)
    }

    if (serviceId) {
      const service = breakdown.byService.get(serviceId) ?? { ...zeroAmounts(), acts: 0, includedActs: 0 }
      addLine(service, line.documentKind, line.netAmountCents)
      if (kind === 'act') {
        const sign = line.documentKind === 'credit_note' ? -1 : 1
        service.acts += sign * line.quantity
        if (line.netAmountCents === 0) service.includedActs += sign * line.quantity
      }
      breakdown.byService.set(serviceId, service)
    }
  }

  return breakdown
}

/**
 * Revenu par type de ressource, à partir du revenu par ressource. Une ligne
 * dont la ressource n'est pas connue (archivée et absente de la liste) reste
 * comptée dans le total, sous `unknown`.
 */
export function revenueByType<T extends string>(
  byResource: ReadonlyMap<string, RevenueAmounts>,
  typeOf: (resourceId: string) => T | undefined,
): { byType: Map<T, RevenueAmounts>; unknown: RevenueAmounts } {
  const byType = new Map<T, RevenueAmounts>()
  const unknown = zeroAmounts()
  for (const [resourceId, amounts] of byResource) {
    const type = typeOf(resourceId)
    if (!type) {
      sumAmounts(unknown, amounts)
      continue
    }
    const into = byType.get(type) ?? zeroAmounts()
    sumAmounts(into, amounts)
    byType.set(type, into)
  }
  return { byType, unknown }
}

/** Un document émis, avec ses totaux tenus par la base. */
export type IssuedDocument = {
  kind: InvoiceKind
  currency: string
  issueDate: string
  dueDate: string
  totalExclTaxCents: number
  totalInclTaxCents: number
  paidCents: number
  creditedCents: number
}

/** Un paiement non annulé. Négatif : un remboursement. */
export type ReceivedPayment = {
  currency: string
  paidOn: string
  amountCents: number
}

export type BillingSummary = {
  /** Factures moins avoirs émis sur la période, HT. */
  invoicedExclTaxCents: number
  /** Même chose, TTC. */
  invoicedInclTaxCents: number
  /** Avoirs émis sur la période, HT, en positif. */
  creditNotesExclTaxCents: number
  invoiceCount: number
  creditNoteCount: number
  /** Paiements reçus sur la période, remboursements déduits. */
  collectedCents: number
  /** Ce qui reste dû aujourd'hui sur les factures émises dans la période. */
  dueCents: number
  /** Dont l'échéance est passée. */
  overdueCents: number
  /** Documents et paiements écartés parce qu'ils sont dans une autre devise. */
  otherCurrencyCount: number
}

/**
 * Reste dû d'une facture, jamais négatif : un trop-perçu se rembourse, il ne
 * vient pas en déduction de ce que doivent les autres clients.
 */
export function remainingDueCents(document: IssuedDocument): number {
  if (document.kind !== 'invoice') return 0
  return Math.max(0, amountDueCents(document))
}

/**
 * Chiffre d'affaires facturé, encaissé et restant dû sur une période.
 *
 * Le restant dû porte sur les factures **émises dans la période** et se lit à
 * la date du jour : c'est « ce qui manque encore sur ce qu'on a facturé ce
 * mois-là ». L'encours de toutes les périodes est `outstanding()`.
 */
export function billingSummary(input: {
  documents: readonly IssuedDocument[]
  payments: readonly ReceivedPayment[]
  currency: string
  period: Period
  today: string
}): BillingSummary {
  const summary: BillingSummary = {
    invoicedExclTaxCents: 0,
    invoicedInclTaxCents: 0,
    creditNotesExclTaxCents: 0,
    invoiceCount: 0,
    creditNoteCount: 0,
    collectedCents: 0,
    dueCents: 0,
    overdueCents: 0,
    otherCurrencyCount: 0,
  }

  for (const document of input.documents) {
    if (!inPeriod(document.issueDate, input.period)) continue
    if (document.currency !== input.currency) {
      summary.otherCurrencyCount += 1
      continue
    }
    if (document.kind === 'credit_note') {
      summary.creditNoteCount += 1
      summary.creditNotesExclTaxCents += document.totalExclTaxCents
      summary.invoicedExclTaxCents -= document.totalExclTaxCents
      summary.invoicedInclTaxCents -= document.totalInclTaxCents
      continue
    }
    summary.invoiceCount += 1
    summary.invoicedExclTaxCents += document.totalExclTaxCents
    summary.invoicedInclTaxCents += document.totalInclTaxCents
    const due = remainingDueCents(document)
    summary.dueCents += due
    if (document.dueDate < input.today) summary.overdueCents += due
  }

  for (const payment of input.payments) {
    if (!inPeriod(payment.paidOn, input.period)) continue
    if (payment.currency !== input.currency) {
      summary.otherCurrencyCount += 1
      continue
    }
    summary.collectedCents += payment.amountCents
  }

  return summary
}

/** Encours client à ce jour, toutes périodes confondues. */
export function outstanding(
  documents: readonly IssuedDocument[],
  currency: string,
  today: string,
): { dueCents: number; overdueCents: number; invoiceCount: number } {
  let dueCents = 0
  let overdueCents = 0
  let invoiceCount = 0
  for (const document of documents) {
    if (document.currency !== currency) continue
    const due = remainingDueCents(document)
    if (due <= 0) continue
    invoiceCount += 1
    dueCents += due
    if (document.dueDate < today) overdueCents += due
  }
  return { dueCents, overdueCents, invoiceCount }
}

export type MonthlyBilling = {
  month: string
  invoicedExclTaxCents: number
  invoicedInclTaxCents: number
  collectedCents: number
}

/** Facturé (avoirs déduits) et encaissé, mois par mois. */
export function monthlyBilling(input: {
  documents: readonly IssuedDocument[]
  payments: readonly ReceivedPayment[]
  currency: string
  months: readonly string[]
}): MonthlyBilling[] {
  const rows = new Map(
    input.months.map((month) => [
      month,
      { month, invoicedExclTaxCents: 0, invoicedInclTaxCents: 0, collectedCents: 0 },
    ]),
  )
  for (const document of input.documents) {
    const row = rows.get(document.issueDate.slice(0, 7))
    if (!row || document.currency !== input.currency) continue
    const sign = document.kind === 'credit_note' ? -1 : 1
    row.invoicedExclTaxCents += sign * document.totalExclTaxCents
    row.invoicedInclTaxCents += sign * document.totalInclTaxCents
  }
  for (const payment of input.payments) {
    const row = rows.get(payment.paidOn.slice(0, 7))
    if (!row || payment.currency !== input.currency) continue
    row.collectedCents += payment.amountCents
  }
  return [...rows.values()]
}
