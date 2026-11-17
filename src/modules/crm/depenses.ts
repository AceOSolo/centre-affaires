import { addDaysToIsoDate, addMonthsToIsoMonth, formatCalendarDate, toIsoDate } from '../../lib/dates.ts'
import { contractTypeLabels } from '../contrats/labels.ts'
import type { BillingPeriod, ContractType } from '../contrats/schema.ts'
import { billablePages } from '../courrier/regles.ts'
import { lineNetAmountCents } from '../facturation/montants.ts'
import {
  priceActs,
  type ActCatalogueService,
  type ActSubscription,
  type PricedAct,
} from '../facturation/souscriptions-regles.ts'
import {
  consumptionDraft,
  consumptionNatureLabels,
  occurredAt,
  sourceKey,
  sourceValidity,
  type ConsumptionSource,
} from './consommations.ts'
import type { ConsumptionNature } from './schema-consommations.ts'

/**
 * Les dépenses d'une entreprise, mois par mois, pour son espace client
 * (ADR 081). Règles pures, sans base ; `depenses-queries.ts` les nourrit.
 *
 * **Une estimation, pas une facture** : le site ne facture rien (ADR 046),
 * Dolibarr facture en fin de mois. Le site montre ce qu'il sait :
 *
 * - les **frais fixes** des contrats (le prix par période que le contrat du
 *   site porte, reçu du CRM, ADR 066), comptés le mois où chaque période
 *   commence ;
 * - les **prestations**, selon les règles du registre des consommations
 *   transmises au CRM (`consommations.ts`, ADR 066) — réservations sans devis
 *   de toute ressource, ouvertures, pages en plus, numérisations,
 *   réexpéditions et leur affranchissement — prises **à la source**, pour que
 *   le mois en cours apparaisse avant d'être clos ;
 * - leur montant : le devis figé d'une réservation (ADR 023) ; pour un acte du
 *   courrier, la règle déjà annoncée au client avant chaque demande
 *   (`priceActs`, ADR 024 : compris dans son forfait, à son prix, sinon au
 *   prix du catalogue reçu du CRM, ADR 049), si le centre le permet ; sinon
 *   aucun montant n'est inventé : « chiffré sur la facture ».
 *
 * Montants HT, en centimes (décision 5). Le mois est celui du centre.
 */

/* ------------------------------------------------------------------------ */
/* Mois                                                                     */
/* ------------------------------------------------------------------------ */

const monthIndex = (isoMonth: string) => {
  const [year, month] = isoMonth.split('-').map(Number)
  return year! * 12 + (month! - 1)
}

/** Le jour `day` d'un mois, ramené à son dernier jour s'il n'existe pas (31 → 30). */
function dayInMonth(isoMonth: string, day: number): string {
  const [year, month] = isoMonth.split('-').map(Number)
  const last = new Date(Date.UTC(year!, month!, 0)).getUTCDate()
  return `${isoMonth}-${String(Math.min(day, last)).padStart(2, '0')}`
}

/**
 * Les mois montrés : le mois en cours, puis les `history` mois passés, du
 * plus récent au plus ancien.
 */
export function expenseMonths(currentMonth: string, history: number): string[] {
  return Array.from({ length: Math.max(0, history) + 1 }, (_, index) => addMonthsToIsoMonth(currentMonth, -index))
}

/* ------------------------------------------------------------------------ */
/* Lignes                                                                   */
/* ------------------------------------------------------------------------ */

export type ExpenseKind = 'fixed' | ConsumptionNature

/**
 * D'où vient le montant d'une ligne :
 *
 * - `contract` : le prix du contrat ;
 * - `quote` : le prix annoncé à la réservation (devis figé) ;
 * - `included` : compris dans le forfait du client, 0 € ;
 * - `subscription` : au prix du forfait, au-delà de ce qu'il comprend ;
 * - `catalogue` : au prix du centre ;
 * - `unpriced` : aucun prix connu du site, chiffré sur la facture.
 */
export type ExpensePricing = 'contract' | 'quote' | 'included' | 'subscription' | 'catalogue' | 'unpriced'

export const expensePricingLabels: Record<ExpensePricing, string> = {
  contract: 'Prix du contrat',
  quote: 'Prix annoncé à la réservation',
  included: 'Compris dans votre forfait',
  subscription: 'Au tarif de votre forfait',
  catalogue: 'Au tarif du centre',
  unpriced: 'Chiffré sur la facture',
}

export type ExpenseLine = {
  /** Unique dans le mois : nature et source. */
  key: string
  kind: ExpenseKind
  clientId: string
  /** Jour de la prestation, ou du début de la période facturée, dans le calendrier du centre. */
  day: string
  label: string
  detail: string
  quantity: number
  /** Montant HT estimé, en centimes ; nul : sans prix connu. */
  amountCents: number | null
  /** Frais refacturés (affranchissement), en centimes ; nuls : aucun, ou pas encore relevés. */
  feesCents: number | null
  currency: string | null
  pricing: ExpensePricing
  /** Pas encore faite : une réservation à venir, une période qui commence plus tard dans le mois. */
  upcoming: boolean
  /** Réexpédition faite dont l'affranchissement n'est pas encore relevé. */
  feesPending: boolean
}

/* ------------------------------------------------------------------------ */
/* Frais fixes                                                              */
/* ------------------------------------------------------------------------ */

/** Un contrat du compte, tel que les frais fixes le lisent (`contrats/compte-queries.ts`). */
export type ContractFeeSource = {
  contractId: string
  clientId: string
  reference: string
  contractType: ContractType
  billingPeriod: BillingPeriod
  currency: string
  startsOn: string
  /** Dernier jour (terme ou résiliation) ; nul : sans terme. */
  lastDay: string | null
  /** Versions de prix HT par période (`contract_price_versions`, avenants compris). */
  prices: readonly { startsOn: string; endsOn: string | null; amountCents: number }[]
}

export const billingPeriodMonths: Record<BillingPeriod, number> = { monthly: 1, quarterly: 3, yearly: 12 }

const periodWords: Record<BillingPeriod, string> = { monthly: 'Mois', quarterly: 'Trimestre', yearly: 'Année' }

/**
 * La période du contrat qui commence dans ce mois, s'il y en a une : les
 * périodes partent du premier jour du contrat (le 31 devient le 30 d'un mois
 * qui n'en a que 30) et s'arrêtent à son dernier jour. Choix par défaut (ADR
 * 081) : une période se compte le mois où elle commence, entière, sans
 * prorata.
 */
export function periodInMonth(
  contract: Pick<ContractFeeSource, 'startsOn' | 'billingPeriod' | 'lastDay'>,
  month: string,
): { startsOn: string; endsOn: string } | null {
  const step = billingPeriodMonths[contract.billingPeriod]
  const offset = monthIndex(month) - monthIndex(contract.startsOn.slice(0, 7))
  if (offset < 0 || offset % step !== 0) return null
  const day = Number(contract.startsOn.slice(8, 10))
  const startsOn = dayInMonth(month, day)
  if (contract.lastDay !== null && startsOn > contract.lastDay) return null
  let endsOn = addDaysToIsoDate(dayInMonth(addMonthsToIsoMonth(month, step), day), -1)
  if (contract.lastDay !== null && contract.lastDay < endsOn) endsOn = contract.lastDay
  return { startsOn, endsOn }
}

/** Le prix en vigueur ce jour-là : la dernière version commencée. */
export function priceOn(prices: ContractFeeSource['prices'], day: string): number | null {
  let found: { startsOn: string; amountCents: number } | null = null
  for (const version of prices) {
    if (version.startsOn <= day && (!found || version.startsOn > found.startsOn)) found = version
  }
  return found?.amountCents ?? null
}

/** Les frais fixes d'un mois : une ligne par contrat dont une période y commence. */
export function fixedFeeLines(contracts: readonly ContractFeeSource[], month: string, today: string): ExpenseLine[] {
  const lines: ExpenseLine[] = []
  for (const contract of contracts) {
    const period = periodInMonth(contract, month)
    if (!period) continue
    const amount = priceOn(contract.prices, period.startsOn)
    lines.push({
      key: `fixed|${contract.contractId}|${period.startsOn}`,
      kind: 'fixed',
      clientId: contract.clientId,
      day: period.startsOn,
      label: `Frais fixes — ${contractTypeLabels[contract.contractType]}`,
      detail: `Contrat ${contract.reference}, ${periodWords[contract.billingPeriod].toLowerCase()} du ${formatCalendarDate(period.startsOn)} au ${formatCalendarDate(period.endsOn)}`,
      quantity: 1,
      amountCents: amount,
      feesCents: null,
      currency: contract.currency,
      pricing: amount === null ? 'unpriced' : 'contract',
      upcoming: period.startsOn > today,
      feesPending: false,
    })
  }
  return lines
}

/* ------------------------------------------------------------------------ */
/* Prestations                                                              */
/* ------------------------------------------------------------------------ */

export const mailActNatures = ['mail_opening', 'mail_pages', 'mail_scan', 'mail_forward'] as const
export type MailActNature = (typeof mailActNatures)[number]

/** Ce qu'il faut pour estimer les actes du courrier. */
export type ActPricing = {
  /** Faux : aucun acte n'est chiffré (réglage du centre). */
  estimate: boolean
  /** Le service du catalogue de chaque acte, s'il existe (ADR 049). */
  catalogue: Partial<Record<MailActNature, ActCatalogueService>>
  /** Souscriptions vivantes de chaque entreprise au service de chaque acte (ADR 024). */
  subscriptions: Readonly<Record<string, Partial<Record<MailActNature, readonly ActSubscription[]>>>>
}

export const noActPricing: ActPricing = { estimate: false, catalogue: {}, subscriptions: {} }

export type ExpenseContext = {
  timeZone: string
  /** Pages comprises dans l'ouverture d'un pli (`tenants.mail_opening_included_pages`). */
  includedPages: number
  now: Date
  pricing: ActPricing
}

/** La source fait-elle une dépense de ce mois ? Les règles du registre, sans attendre qu'elle soit prête. */
export function isExpenseOfMonth(source: ConsumptionSource, month: string, context: ExpenseContext): boolean {
  if (!sourceValidity(source).valid) return false
  const at = occurredAt(source)
  if (!at || toIsoDate(at, context.timeZone).slice(0, 7) !== month) return false
  if (source.nature === 'mail_pages') return billablePages(source.pageCount, context.includedPages) > 0
  return true
}

/** Le montant d'un acte chiffré par `priceActs`, pour sa quantité (les pages en plus en ont plusieurs). */
function actAmount(priced: PricedAct, quantity: number): number | null {
  if (priced.source === 'unpriced' || priced.unitPriceCents === null) return null
  if (priced.source === 'included') return 0
  if (quantity === 1) return priced.netAmountCents
  return lineNetAmountCents({ quantity, unitPriceCents: priced.unitPriceCents, discountBp: priced.discountBp })
}

/**
 * Les prestations d'un mois. Les actes du courrier sont chiffrés mois par
 * mois et entreprise par entreprise, comme la règle les compte : les premiers
 * du mois sont compris dans le forfait, les suivants à son prix. Les pages en
 * plus n'ont pas d'inclus : celles comprises le sont déjà dans l'ouverture.
 */
export function serviceLines(
  sources: readonly ConsumptionSource[],
  month: string,
  context: ExpenseContext,
): ExpenseLine[] {
  const { timeZone, includedPages, now, pricing } = context
  const taken = sources
    .filter((source) => isExpenseOfMonth(source, month, context))
    .map((source) => ({ source, draft: consumptionDraft(source, { timeZone, includedPages }) }))

  const priced = new Map<string, PricedAct>()
  if (pricing.estimate) {
    const clientIds = [...new Set(taken.map((entry) => entry.draft.clientId))]
    for (const clientId of clientIds) {
      for (const nature of mailActNatures) {
        const acts = taken.filter((entry) => entry.draft.clientId === clientId && entry.source.nature === nature)
        if (acts.length === 0) continue
        const subscriptions = pricing.subscriptions[clientId]?.[nature] ?? []
        const rule =
          nature === 'mail_pages' ? subscriptions.map((subscription) => ({ ...subscription, includedQuantity: 0 })) : subscriptions
        const result = priceActs(
          acts.map((entry) => ({
            id: sourceKey(nature, entry.source.sourceId),
            day: toIsoDate(entry.draft.occurredAt, timeZone),
            at: entry.draft.occurredAt,
          })),
          rule,
          pricing.catalogue[nature] ?? null,
        )
        for (const act of result) priced.set(act.actId, act)
      }
    }
  }

  return taken.map(({ source, draft }): ExpenseLine => {
    const key = sourceKey(source.nature, source.sourceId)
    const base = {
      key,
      kind: source.nature,
      clientId: draft.clientId,
      day: toIsoDate(draft.occurredAt, timeZone),
      label: consumptionNatureLabels[source.nature],
      detail: draft.description,
      quantity: draft.quantity,
      feesCents: draft.feesCents,
    }
    if (source.nature === 'booking') {
      return {
        ...base,
        amountCents: draft.amountCents,
        currency: draft.currency,
        pricing: draft.amountCents === null ? 'unpriced' : 'quote',
        upcoming: source.startsAt > now,
        feesPending: false,
      }
    }
    const act = priced.get(key)
    const amountCents = act ? actAmount(act, draft.quantity) : null
    return {
      ...base,
      amountCents,
      currency: (amountCents !== null ? act?.currency : null) ?? draft.currency,
      pricing: amountCents === null ? 'unpriced' : act!.source,
      upcoming: false,
      feesPending: source.nature === 'mail_forward' && source.postageCents === null,
    }
  })
}

/* ------------------------------------------------------------------------ */
/* Le mois                                                                  */
/* ------------------------------------------------------------------------ */

export type ExpenseTotal = {
  currency: string
  fixedCents: number
  servicesCents: number
  totalCents: number
}

export type ExpenseMonth = {
  month: string
  /** Le mois en cours : ce qui s'y ajoute d'ici sa fin manque encore. */
  current: boolean
  lines: ExpenseLine[]
  /** Totaux des montants connus, par devise. */
  totals: ExpenseTotal[]
  /** Lignes sans montant connu, chiffrées sur la facture. */
  unpriced: number
  /** Réexpéditions dont l'affranchissement n'est pas encore relevé. */
  feesPending: number
}

/** Totaux d'un ensemble de lignes : les montants connus, par devise ; le reste compté à part. */
export function expenseTotals(lines: readonly ExpenseLine[]): Pick<ExpenseMonth, 'totals' | 'unpriced' | 'feesPending'> {
  const totals = new Map<string, ExpenseTotal>()
  let unpriced = 0
  let feesPending = 0
  for (const line of lines) {
    if (line.amountCents === null) unpriced += 1
    if (line.feesPending) feesPending += 1
    const cents = (line.amountCents ?? 0) + (line.feesCents ?? 0)
    if (!line.currency || (line.amountCents === null && line.feesCents === null)) continue
    const total = totals.get(line.currency) ?? { currency: line.currency, fixedCents: 0, servicesCents: 0, totalCents: 0 }
    if (line.kind === 'fixed') total.fixedCents += cents
    else total.servicesCents += cents
    total.totalCents += cents
    totals.set(line.currency, total)
  }
  return { totals: [...totals.values()], unpriced, feesPending }
}

const kindOrder = (kind: ExpenseKind) => (kind === 'fixed' ? 0 : 1)

/** Le mois d'une ou plusieurs entreprises : frais fixes d'abord, puis les prestations par jour. */
export function buildExpenseMonth(input: {
  month: string
  contracts: readonly ContractFeeSource[]
  sources: readonly ConsumptionSource[]
  context: ExpenseContext
}): ExpenseMonth {
  const today = toIsoDate(input.context.now, input.context.timeZone)
  const lines = [
    ...fixedFeeLines(input.contracts, input.month, today),
    ...serviceLines(input.sources, input.month, input.context),
  ].sort(
    (a, b) =>
      kindOrder(a.kind) - kindOrder(b.kind) ||
      (a.day < b.day ? -1 : a.day > b.day ? 1 : 0) ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  )
  return { month: input.month, current: input.month === today.slice(0, 7), lines, ...expenseTotals(lines) }
}
