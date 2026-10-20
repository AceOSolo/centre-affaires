import { formatLongDate, formatTime, toIsoDate } from '../../lib/dates.ts'
import { describeAnswers, questionnaires, type Answers } from '../reservations/questionnaires.ts'
import { productOf, type ProductKey } from '../ressources/produits.ts'
import type { ResourceType } from '../ressources/schema.ts'
import { lineNetAmountCents, vatAmountCents } from './montants.ts'
import type { RateUnit } from './schema.ts'
import type { ProposalLineSource, ProposalProduct, ProposalStatus } from './schema-devis.ts'

/**
 * Devis transmis à Dolibarr (ADR 043) : règles pures, sans base.
 *
 * Le montant d'une ligne est celui de la base (`proposal_lines.amount_cents`,
 * règle d'arrondi unique de l'ADR 023) ; ce module le recalcule par son
 * jumeau TypeScript pour l'annoncer avant l'écriture.
 */

export const proposalStatusLabels: Record<ProposalStatus, string> = {
  draft: 'À compléter',
  ready: 'Prêt pour Dolibarr',
  sent: 'Transmis à Dolibarr',
  accepted: 'Signé',
  refused: 'Refusé',
  cancelled: 'Annulé',
}

export const proposalProductLabels: Record<ProposalProduct, string> = {
  espace: 'Salle ou bureau',
  vehicule: 'Véhicule',
  domiciliation: 'Domiciliation',
}

export const proposalLineSourceLabels: Record<ProposalLineSource, string> = {
  booking: 'Réservation',
  service: 'Service du catalogue',
  manual: 'Saisie de l’accueil',
}

/** Ce qu'il faut d'une ligne pour la chiffrer. */
export type PricedLine = {
  quantity: number
  unitPriceCents: number
  discountBp: number | null
  discountAmountCents: number | null
  vatRateBp: number
}

export type ProposalTotals = {
  netCents: number
  /** TVA par taux, sur la somme des bases du taux (comme la facture). */
  vat: { vatRateBp: number; baseCents: number; vatCents: number }[]
  vatCents: number
  totalCents: number
}

export function lineAmountCents(line: PricedLine): number {
  return lineNetAmountCents(line)
}

/**
 * Totaux d'un devis. La TVA se calcule par taux sur la somme des bases, comme
 * `invoiceAmounts` : Dolibarr, qui fera la facture, ventile de même.
 */
export function proposalTotals(lines: readonly PricedLine[]): ProposalTotals {
  const bases = new Map<number, number>()
  let netCents = 0
  for (const line of lines) {
    const amount = lineAmountCents(line)
    netCents += amount
    bases.set(line.vatRateBp, (bases.get(line.vatRateBp) ?? 0) + amount)
  }
  const vat = [...bases.entries()]
    .sort(([a], [b]) => b - a)
    .map(([vatRateBp, baseCents]) => ({ vatRateBp, baseCents, vatCents: vatAmountCents(baseCents, vatRateBp) }))
  const vatCents = vat.reduce((total, group) => total + group.vatCents, 0)
  return { netCents, vat, vatCents, totalCents: netCents + vatCents }
}

/** Le prix figé d'une réservation (colonnes `quote_*`, ADR 023). */
export type BookingForLine = {
  startsAt: Date
  endsAt: Date
  quoteUnit: RateUnit | null
  quoteQuantity: number | null
  quoteUnitPriceCents: number | null
  quoteDiscountBp: number | null
  quoteDiscountAmountCents: number | null
  quoteVatRateBp: number | null
  quoteRatePlanItemId: string | null
  quotedAt: Date | null
  resource: { id: string; name: string }
}

export type LineDraft = PricedLine & {
  source: ProposalLineSource
  label: string
  description: string | null
  unit: RateUnit
  resourceId: string | null
  serviceId: string | null
  ratePlanItemId: string | null
}

/** Le créneau en toutes lettres, au fuseau du centre : « mardi 3 novembre 2026, 9 h 00 – 12 h 00 ». */
export function describeSlot(startsAt: Date, endsAt: Date, timeZone: string): string {
  const startDay = toIsoDate(startsAt, timeZone)
  const endDay = toIsoDate(endsAt, timeZone)
  if (startDay === endDay) {
    return `${formatLongDate(startDay, timeZone)}, ${formatTime(startsAt, timeZone)} – ${formatTime(endsAt, timeZone)}`
  }
  return `du ${formatLongDate(startDay, timeZone)} ${formatTime(startsAt, timeZone)} au ${formatLongDate(endDay, timeZone)} ${formatTime(endsAt, timeZone)}`
}

/**
 * La ligne de devis d'une réservation chiffrée : son prix figé, tel quel. La
 * facture Dolibarr reprendra donc le prix annoncé au demandeur (R11).
 * `undefined` pour une réservation non chiffrée : l'accueil la chiffrera.
 */
export function lineFromBooking(booking: BookingForLine, timeZone: string): LineDraft | undefined {
  if (
    !booking.quotedAt ||
    booking.quoteUnit === null ||
    booking.quoteQuantity === null ||
    booking.quoteUnitPriceCents === null ||
    booking.quoteVatRateBp === null
  ) {
    return undefined
  }
  return {
    source: 'booking',
    label: `${booking.resource.name} — ${describeSlot(booking.startsAt, booking.endsAt, timeZone)}`,
    description: null,
    unit: booking.quoteUnit,
    quantity: booking.quoteQuantity,
    unitPriceCents: booking.quoteUnitPriceCents,
    discountBp: booking.quoteDiscountBp,
    discountAmountCents: booking.quoteDiscountAmountCents,
    vatRateBp: booking.quoteVatRateBp,
    resourceId: booking.resource.id,
    serviceId: null,
    ratePlanItemId: booking.quoteRatePlanItemId,
  }
}

/**
 * Le devis part seul vers Dolibarr si son produit le permet et s'il est
 * chiffré ; sinon il attend l'accueil (ADR 043, *à valider*).
 */
export function validatesOnCreation(product: ProposalProduct, lineCount: number): boolean {
  return questionnaires[product].autoValidate && lineCount > 0
}

/**
 * Rayon d'un devis dans les filtres par produit du back-office (ADR 046) :
 * celui de la ressource réservée, ou la domiciliation, qui n'en réserve pas.
 */
export function proposalProductKey(proposal: { product: ProposalProduct; resourceType: ResourceType | null }): ProductKey | undefined {
  if (proposal.product === 'domiciliation') return 'domiciliation'
  return proposal.resourceType ? productOf(proposal.resourceType).key : undefined
}

/**
 * Devis du produit choisi par les pastilles (`?produit=`, ADR 046 et 048),
 * avec les clés de partout ailleurs : `salles`, `bureaux`, `domiciliation`,
 * `vehicules`. Sans produit : tous.
 */
export function proposalsOfProduct<T extends { product: ProposalProduct; resourceType: ResourceType | null }>(
  proposals: readonly T[],
  product: ProductKey | undefined,
): T[] {
  return proposals.filter((proposal) => !product || proposalProductKey(proposal) === product)
}

/**
 * Un devis attend l'accueil dans « Demandes » (ADR 048) : à compléter, et pas
 * déjà présenté avec la demande de réservation qu'il accompagne — la carte de
 * cette demande y mène, il n'apparaît pas deux fois.
 */
export function awaitsReception(proposal: { status: ProposalStatus; bookingStatus: string | null }): boolean {
  return proposal.status === 'draft' && proposal.bookingStatus !== 'pending'
}

/** Ce que l'accueil peut faire d'un devis, selon son état. */
export function proposalActions(status: ProposalStatus): {
  edit: boolean
  validate: boolean
  reopen: boolean
  cancel: boolean
} {
  return {
    edit: status === 'draft',
    validate: status === 'draft',
    reopen: status === 'ready',
    cancel: status === 'draft' || status === 'ready' || status === 'sent',
  }
}

// --- Ce que Dolibarr reçoit -------------------------------------------------

/** Unités Dolibarr : libellé lisible, la quantité restant un entier. */
const unitLabels: Record<RateUnit, string> = {
  hour: 'heure',
  half_day: 'demi-journée',
  day: 'journée',
  week: 'semaine',
  month: 'mois',
  unit: 'unité',
}

export type DolibarrProposal = {
  /** Identifiant du devis dans l'application, à renvoyer à la transmission. */
  id: string
  /** `DV-2026-0001` : à porter en référence client de la proposition Dolibarr. */
  reference: string
  produit: ProposalProduct
  canal: 'staff' | 'client' | 'public'
  statut: ProposalStatus
  creeLe: string
  valideLe: string | null
  annuleLe: string | null
  motifAnnulation: string | null
  devise: string
  /** Le tiers : la fiche client connue, sinon le demandeur tel qu'il s'est présenté. */
  tiers: {
    clientId: string | null
    nom: string
    siret: string | null
    numeroTva: string | null
    email: string | null
    telephone: string | null
    adresse: { ligne1: string | null; ligne2: string | null; codePostal: string | null; ville: string | null; pays: string } | null
  }
  contact: { nom: string | null; email: string | null; telephone: string | null }
  reservation: { id: string; debut: string; fin: string; ressource: string } | null
  /** Réponses au questionnaire, en clair, et brutes pour qui veut les ranger en extrafields. */
  reponses: { libelle: string; valeur: string }[]
  reponsesBrutes: Answers
  message: string | null
  noteAccueil: string | null
  lignes: {
    position: number
    designation: string
    description: string | null
    /** 0 : produit, 1 : service — `product_type` de Dolibarr. Tout ce que vend le centre est un service. */
    typeProduit: 1
    unite: string
    quantite: number
    prixUnitaireHtCentimes: number
    /** Prix unitaire HT en euros, comme l'attend `subprice`. */
    prixUnitaireHt: string
    remisePourcent: string | null
    remiseMontantCentimes: number | null
    tauxTva: string
    montantHtCentimes: number
    ressourceId: string | null
    serviceId: string | null
  }[]
  totaux: { htCentimes: number; tvaCentimes: number; ttcCentimes: number }
}

export type ProposalForDolibarr = {
  id: string
  number: string
  product: ProposalProduct
  channel: 'staff' | 'client' | 'public'
  status: ProposalStatus
  createdAt: Date
  validatedAt: Date | null
  cancelledAt: Date | null
  cancellationReason: string | null
  currency: string
  requesterName: string | null
  requesterEmail: string | null
  requesterPhone: string | null
  requesterCompany: string | null
  answers: Answers
  message: string | null
  staffNote: string | null
  client: {
    id: string
    name: string
    siret: string | null
    vatNumber: string | null
    email: string | null
    phone: string | null
    addressLine1: string | null
    addressLine2: string | null
    postalCode: string | null
    city: string | null
    country: string
  } | null
  booking: { id: string; startsAt: Date; endsAt: Date; resourceName: string } | null
  lines: (LineDraft & { position: number; amountCents: number })[]
}

/** Centimes en décimal à deux chiffres, point décimal : `12345` → `"123.45"`. */
export function centsToDecimal(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

/** Points de base en pourcentage décimal : `2000` → `"20"`, `550` → `"5.5"`. */
export function basisPointsToPercent(bp: number): string {
  return String(bp / 100)
}

/**
 * Le devis tel que Dolibarr le lit (`GET /api/dolibarr/devis`). Un format à
 * nous, stable et documenté (`docs/integrations/dolibarr.md`) : le
 * développeur Dolibarr le traduit en `POST /proposals`, l'application ne
 * dépend d'aucune version de Dolibarr.
 */
export function toDolibarrProposal(proposal: ProposalForDolibarr): DolibarrProposal {
  const lines = [...proposal.lines].sort((a, b) => a.position - b.position)
  const totals = proposalTotals(lines)
  const client = proposal.client
  return {
    id: proposal.id,
    reference: proposal.number,
    produit: proposal.product,
    canal: proposal.channel,
    statut: proposal.status,
    creeLe: proposal.createdAt.toISOString(),
    valideLe: proposal.validatedAt?.toISOString() ?? null,
    annuleLe: proposal.cancelledAt?.toISOString() ?? null,
    motifAnnulation: proposal.cancellationReason,
    devise: proposal.currency,
    tiers: client
      ? {
          clientId: client.id,
          nom: client.name,
          siret: client.siret,
          numeroTva: client.vatNumber,
          email: client.email,
          telephone: client.phone,
          adresse: {
            ligne1: client.addressLine1,
            ligne2: client.addressLine2,
            codePostal: client.postalCode,
            ville: client.city,
            pays: client.country,
          },
        }
      : {
          clientId: null,
          nom: proposal.requesterCompany || proposal.requesterName || 'Prospect',
          siret: typeof proposal.answers.siren === 'string' ? proposal.answers.siren : null,
          numeroTva: null,
          email: proposal.requesterEmail,
          telephone: proposal.requesterPhone,
          adresse: null,
        },
    contact: { nom: proposal.requesterName, email: proposal.requesterEmail, telephone: proposal.requesterPhone },
    reservation: proposal.booking
      ? {
          id: proposal.booking.id,
          debut: proposal.booking.startsAt.toISOString(),
          fin: proposal.booking.endsAt.toISOString(),
          ressource: proposal.booking.resourceName,
        }
      : null,
    reponses: describeAnswers(proposal.product, proposal.answers).map(({ label, value }) => ({ libelle: label, valeur: value })),
    reponsesBrutes: proposal.answers,
    message: proposal.message,
    noteAccueil: proposal.staffNote,
    lignes: lines.map((line) => ({
      position: line.position,
      designation: line.label,
      description: line.description,
      typeProduit: 1,
      unite: unitLabels[line.unit],
      quantite: line.quantity,
      prixUnitaireHtCentimes: line.unitPriceCents,
      prixUnitaireHt: centsToDecimal(line.unitPriceCents),
      remisePourcent: line.discountBp === null ? null : basisPointsToPercent(line.discountBp),
      remiseMontantCentimes: line.discountAmountCents,
      tauxTva: basisPointsToPercent(line.vatRateBp),
      montantHtCentimes: line.amountCents,
      ressourceId: line.resourceId,
      serviceId: line.serviceId,
    })),
    totaux: { htCentimes: totals.netCents, tvaCentimes: totals.vatCents, ttcCentimes: totals.totalCents },
  }
}
