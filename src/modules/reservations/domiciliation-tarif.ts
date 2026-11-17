import { vatAmountCents } from '../facturation/montants.ts'
import type { LineDraft } from '../facturation/propositions.ts'
import { formatCents } from '../facturation/tarifs.ts'
import type { DescribedAnswer } from './questionnaires.ts'

/**
 * Tarif annoncé par le formulaire de domiciliation (ADR 074) : le forfait du
 * centre, plus les options que le demandeur coche, au mois.
 *
 * - le **forfait** est le prix au mois de la boîte aux lettres dans la grille
 *   par défaut (`tarif.boite_aux_lettres.month` reçu de Dolibarr, ADR 049) :
 *   celui que la page d'accueil annonce déjà « à partir de » ;
 * - les **options** sont des forfaits mensuels du catalogue de services, reçus
 *   de Dolibarr, que le centre choisit de proposer (Réglages > Formulaires de
 *   demande > Domiciliation).
 *
 * Montants en centimes (décision 5) ; la TVA se calcule par taux sur la somme
 * des bases, comme une facture (EN 16931, `montants.ts`). Sans forfait connu,
 * rien n'est inventé : « tarif communiqué par l'accueil ».
 *
 * Module pur, éprouvé par `domiciliation-tarif.test.ts`.
 */

export type PricedItem = { label: string; amountCents: number; vatRateBp: number }

export type DomiciliationOption = PricedItem & { code: string; description: string | null; serviceId: string }

export type DomiciliationOffer = {
  currency: string
  /** Forfait mensuel du centre ; nul quand la grille ne le chiffre pas. */
  base: (PricedItem & { ratePlanItemId: string }) | null
  /** Options proposées, dans l'ordre réglé par le centre. */
  options: DomiciliationOption[]
}

export type DomiciliationTotal =
  | {
      status: 'priced'
      lines: PricedItem[]
      netCents: number
      vatCents: number
      grossCents: number
    }
  | { status: 'unpriced' }

export const UNPRICED_MESSAGE = 'Tarif communiqué par l’accueil.'

/** Le total mensuel du forfait et des options choisies ; sans forfait connu, pas de total. */
export function domiciliationTotal(offer: DomiciliationOffer, chosen: readonly string[]): DomiciliationTotal {
  if (!offer.base) return { status: 'unpriced' }
  const picked = new Set(chosen)
  const lines: PricedItem[] = [
    { label: offer.base.label, amountCents: offer.base.amountCents, vatRateBp: offer.base.vatRateBp },
    ...offer.options.filter((option) => picked.has(option.code)),
  ]
  const netCents = lines.reduce((total, line) => total + line.amountCents, 0)
  const bases = new Map<number, number>()
  for (const line of lines) bases.set(line.vatRateBp, (bases.get(line.vatRateBp) ?? 0) + line.amountCents)
  const vatCents = [...bases].reduce((total, [rate, base]) => total + vatAmountCents(base, rate), 0)
  return { status: 'priced', lines, netCents, vatCents, grossCents: netCents + vatCents }
}

/**
 * Les options cochées, relues contre celles que le centre propose : un code
 * inconnu est refusé (le formulaire peut mentir), un doublon ignoré.
 */
export function parseChosenServices(
  offer: Pick<DomiciliationOffer, 'options'>,
  values: readonly unknown[],
): { codes: string[]; error?: undefined } | { codes?: undefined; error: string } {
  const offered = new Set(offer.options.map((option) => option.code))
  const codes = [...new Set(values.map((value) => String(value).trim()).filter(Boolean))]
  if (codes.some((code) => !offered.has(code))) return { error: 'Cette option n’est plus proposée : rechargez la page.' }
  // Dans l'ordre du centre, pas dans celui de l'envoi.
  return { codes: offer.options.map((option) => option.code).filter((code) => codes.includes(code)) }
}

/**
 * Les lignes du devis de domiciliation : le forfait (repère : sa ligne de
 * grille), puis chaque option (repère : son service), une par mois. Le devis
 * naît brouillon : l'accueil les relit avant de le valider (ADR 043).
 */
export function domiciliationLines(offer: DomiciliationOffer, codes: readonly string[]): LineDraft[] {
  const common = { quantity: 1, discountBp: null, discountAmountCents: null, unit: 'month', resourceId: null } as const
  const lines: LineDraft[] = []
  if (offer.base) {
    lines.push({
      ...common,
      source: 'manual',
      label: offer.base.label,
      description: null,
      unitPriceCents: offer.base.amountCents,
      vatRateBp: offer.base.vatRateBp,
      serviceId: null,
      ratePlanItemId: offer.base.ratePlanItemId,
    })
  }
  for (const option of offer.options.filter((candidate) => codes.includes(candidate.code))) {
    lines.push({
      ...common,
      source: 'service',
      label: option.label,
      description: option.description,
      unitPriceCents: option.amountCents,
      vatRateBp: option.vatRateBp,
      serviceId: option.serviceId,
      ratePlanItemId: null,
    })
  }
  return lines
}

/** « 105,00 € HT, soit 126,00 € TTC par mois » */
export function totalSentence(total: DomiciliationTotal, currency: string): string {
  if (total.status === 'unpriced') return UNPRICED_MESSAGE
  return `${formatCents(total.netCents, currency)} HT, soit ${formatCents(total.grossCents, currency)} TTC par mois`
}

/**
 * Les options et le total en clair, à la suite des réponses figées du devis
 * (`described_answers`) : l'accueil lit ce que le demandeur a vu.
 */
export function describeDomiciliationPrice(offer: DomiciliationOffer, codes: readonly string[]): DescribedAnswer[] {
  const chosen = offer.options.filter((option) => codes.includes(option.code))
  const described: DescribedAnswer[] = []
  if (chosen.length > 0) {
    described.push({
      name: 'services',
      label: 'Options choisies',
      value: chosen.map((option) => `${option.label} (${formatCents(option.amountCents, offer.currency)} HT par mois)`).join(', '),
    })
  }
  described.push({ name: 'tarif', label: 'Tarif annoncé', value: totalSentence(domiciliationTotal(offer, codes), offer.currency) })
  return described
}
