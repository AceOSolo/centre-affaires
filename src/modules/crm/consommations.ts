import { createHash } from 'node:crypto'

import { addMonthsToIsoMonth, dayRangeUtc, formatCalendarDate, monthRangeUtc, toIsoDate } from '../../lib/dates.ts'
import { billablePages } from '../courrier/regles.ts'
import { mailKindLabels } from '../courrier/labels.ts'
import type { MailKind } from '../courrier/schema.ts'
import { basisPointsToPercent, centsToDecimal, describeSlot } from '../facturation/propositions.ts'
import { serviceCodes, type RateUnit } from '../facturation/schema.ts'
import { products } from '../ressources/produits.ts'
import type { ResourceType } from '../ressources/schema.ts'
import type { ConsumptionNature, ConsumptionStatus } from './schema-consommations.ts'

/**
 * Consommations facturables transmises au CRM (ADR 066) : règles pures, sans
 * base. Le site ne facture rien (`CLAUDE.md`, Facturation) : il dit au CRM ce
 * qu'il a fait pour qui, le CRM en tire ses factures, avec ses prix et ce que
 * ses contrats comprennent.
 *
 * **Ce qui est une consommation**, par nature :
 *
 * | Nature | Source | Valide tant que | Prête quand |
 * |---|---|---|---|
 * | réservation | `bookings` | confirmée, d'un client, sans devis vivant | elle est terminée |
 * | ouverture | `mail_items` | ouvert, pas retiré | son mois est clos |
 * | pages | `mail_scans` | contenu numérisé à l'ouverture, compté, pli pas retiré | son mois est clos, et des pages dépassent celles comprises |
 * | numérisation | `mail_requests` (`scan`) | faite, pli pas retiré | son mois est clos |
 * | réexpédition | `mail_requests` (`forward`) | faite, pli pas retiré | son mois est clos, et ses frais sont relevés |
 *
 * Les réservations sont **de toute ressource** : salle, bureau, camion,
 * matériel… Aucune liste de types n'est écrite ici ; le produit du site
 * (`produits.ts`) s'en déduit à la lecture, jamais en base.
 *
 * « Prête » : quand la consommation ne peut plus changer. Une réservation se
 * déplace ou s'annule jusqu'à sa fin ; les pages d'un pli se corrigent jusqu'à
 * la fin de son mois (`canCorrectPages`, `CA017`) — le courrier part donc au
 * mois, comme le relevé que l'accueil reportait à la main dans Dolibarr.
 *
 * Une réservation qui a un **devis vivant** (`proposals`, non annulé) est
 * facturée par le CRM à partir du devis (ADR 043) : elle n'est jamais une
 * consommation, sans quoi elle serait payée deux fois.
 */

/* ------------------------------------------------------------------------ */
/* Sources                                                                  */
/* ------------------------------------------------------------------------ */

/** Le devis figé d'une réservation (ADR 023), complet. */
export type FrozenQuote = {
  unit: RateUnit
  quantity: number
  unitPriceCents: number
  discountBp: number | null
  discountAmountCents: number | null
  vatRateBp: number
  currency: string
  /** Montant HT calculé par la base (`quote_amount_cents`). */
  amountCents: number
}

export type BookingSource = {
  nature: 'booking'
  sourceId: string
  clientId: string | null
  kind: string
  status: string
  startsAt: Date
  endsAt: Date
  resourceId: string
  resourceName: string
  resourceCode: string
  resourceType: ResourceType
  contractId: string | null
  contractReference: string | null
  /** Un devis non annulé tient la réservation : le CRM la facture à partir de lui. */
  coveredByProposal: boolean
  quote: FrozenQuote | null
}

type MailItemFacts = {
  clientId: string
  mailItemId: string
  mailKind: MailKind
  receivedAt: Date
  /** Pli retiré (enregistré par erreur) : il sort de la facturation (ADR 015). */
  removed: boolean
}

export type MailOpeningSource = MailItemFacts & {
  nature: 'mail_opening'
  sourceId: string
  openedAt: Date | null
}

export type MailPagesSource = MailItemFacts & {
  nature: 'mail_pages'
  sourceId: string
  openedAt: Date | null
  /** Pages du contenu numérisé à l'ouverture ; nul s'il n'est pas compté. */
  pageCount: number | null
}

export type MailRequestSource = MailItemFacts & {
  nature: 'mail_scan' | 'mail_forward'
  sourceId: string
  status: string
  completedAt: Date | null
  postageCents: number | null
  postageCurrency: string | null
}

export type ConsumptionSource = BookingSource | MailOpeningSource | MailPagesSource | MailRequestSource

/** Clé d'une source, toutes natures confondues. */
export function sourceKey(nature: ConsumptionNature, sourceId: string): string {
  return `${nature}|${sourceId}`
}

/* ------------------------------------------------------------------------ */
/* Validité, empreinte, maturité                                            */
/* ------------------------------------------------------------------------ */

export type Validity = { valid: true } | { valid: false; reason: string }

/**
 * La source fait-elle encore une consommation ? Sans regard au temps : une
 * consommation prise ne s'annule pas parce que la date de départ du centre a
 * changé, seulement parce que sa source a changé.
 */
export function sourceValidity(source: ConsumptionSource | undefined): Validity {
  if (!source) return { valid: false, reason: 'Source introuvable sur le site.' }
  switch (source.nature) {
    case 'booking':
      if (source.kind !== 'booking') return { valid: false, reason: 'Ce n’est plus une réservation.' }
      if (source.status === 'cancelled') return { valid: false, reason: 'Réservation annulée.' }
      if (source.status !== 'confirmed') return { valid: false, reason: 'Réservation qui n’est plus confirmée.' }
      if (!source.clientId) return { valid: false, reason: 'Réservation détachée de son client.' }
      if (source.coveredByProposal) {
        return { valid: false, reason: 'Réservation passée par un devis : elle se facture à partir du devis.' }
      }
      return { valid: true }
    case 'mail_opening':
      if (source.removed) return { valid: false, reason: 'Pli retiré (enregistré par erreur).' }
      if (!source.openedAt) return { valid: false, reason: 'Pli qui n’est plus ouvert.' }
      return { valid: true }
    case 'mail_pages':
      if (source.removed) return { valid: false, reason: 'Pli retiré (enregistré par erreur).' }
      if (!source.openedAt || source.pageCount === null) return { valid: false, reason: 'Pages qui ne sont plus comptées.' }
      return { valid: true }
    case 'mail_scan':
    case 'mail_forward':
      if (source.removed) return { valid: false, reason: 'Pli retiré (enregistré par erreur).' }
      if (source.status !== 'done' || !source.completedAt) return { valid: false, reason: 'Demande qui n’est plus faite.' }
      return { valid: true }
  }
}

/**
 * Empreinte de ce qui fait la consommation dans sa source. Une consommation
 * dont la source a une autre empreinte est annulée, et la source en refait
 * une : client changé, réservation déplacée, pages recomptées, frais corrigés.
 * Le réglage des pages comprises n'y entre pas : le changer ne refait pas ce
 * qui est déjà pris.
 */
export function sourceFingerprint(source: ConsumptionSource): string {
  const iso = (date: Date | null) => date?.toISOString() ?? null
  const facts: unknown[] = (() => {
    switch (source.nature) {
      case 'booking':
        return [
          source.clientId,
          source.resourceId,
          iso(source.startsAt),
          iso(source.endsAt),
          source.contractId,
          source.quote
            ? [
                source.quote.unit,
                source.quote.quantity,
                source.quote.unitPriceCents,
                source.quote.discountBp,
                source.quote.discountAmountCents,
                source.quote.vatRateBp,
                source.quote.currency,
              ]
            : null,
        ]
      case 'mail_opening':
        return [source.clientId, source.mailItemId, iso(source.openedAt)]
      case 'mail_pages':
        return [source.clientId, source.mailItemId, iso(source.openedAt), source.pageCount]
      case 'mail_scan':
        return [source.clientId, source.mailItemId, iso(source.completedAt)]
      case 'mail_forward':
        return [source.clientId, source.mailItemId, iso(source.completedAt), source.postageCents, source.postageCurrency]
    }
  })()
  return createHash('sha256').update(JSON.stringify([source.nature, ...facts])).digest('hex')
}

/** Bornes de la prise des consommations, calculées par l'appelant dans le fuseau du centre. */
export type ConsumptionWindow = {
  /** Premier instant transmis (`crm_connections.consumptions_from`) ; nul : rien n'est pris. */
  startAt: Date | null
  now: Date
  /** Premier instant du mois en cours, dans le fuseau du centre : le courrier antérieur est clos. */
  mailCutoff: Date
  /** Pages comprises dans l'ouverture d'un pli (`tenants.mail_opening_included_pages`). */
  includedPages: number
}

/**
 * Au-delà de ce nombre de mois clos, une consommation transmise ne bouge plus :
 * une correction se fait alors dans le CRM. Les prêtes sont toujours revues.
 */
export const SENT_REVIEW_MONTHS = 3

/**
 * Les bornes d'un passage, dans le calendrier du centre : la date de départ
 * réglée à l'écran, le début du mois en cours (le courrier d'avant est clos)
 * et le début du mois à partir duquel les consommations transmises sont
 * encore revues.
 */
export function consumptionWindow(input: {
  from: string | null
  now: Date
  timeZone: string
  includedPages: number
}): ConsumptionWindow & { reviewSentFrom: Date } {
  const month = toIsoDate(input.now, input.timeZone).slice(0, 7)
  return {
    startAt: input.from ? dayRangeUtc(input.from, input.timeZone).startsAt : null,
    now: input.now,
    mailCutoff: monthRangeUtc(month, input.timeZone).startsAt,
    includedPages: input.includedPages,
    reviewSentFrom: monthRangeUtc(addMonthsToIsoMonth(month, -SENT_REVIEW_MONTHS), input.timeZone).startsAt,
  }
}

/** Instant de la prestation, celui que la date de départ et le mois comparent. */
export function occurredAt(source: ConsumptionSource): Date | null {
  switch (source.nature) {
    case 'booking':
      return source.startsAt
    case 'mail_opening':
    case 'mail_pages':
      return source.openedAt
    case 'mail_scan':
    case 'mail_forward':
      return source.completedAt
  }
}

/** La source est valide et ne peut plus changer : elle devient une consommation prête. */
export function isReady(source: ConsumptionSource, window: ConsumptionWindow): boolean {
  if (!window.startAt || !sourceValidity(source).valid) return false
  const at = occurredAt(source)
  if (!at || at < window.startAt) return false
  switch (source.nature) {
    case 'booking':
      return source.endsAt <= window.now
    case 'mail_opening':
    case 'mail_scan':
      return at < window.mailCutoff
    case 'mail_pages':
      return at < window.mailCutoff && billablePages(source.pageCount, window.includedPages) > 0
    case 'mail_forward':
      return at < window.mailCutoff && source.postageCents !== null
  }
}

/** Une consommation vivante, telle que la relit le passage de synchronisation. */
export type LiveConsumption = { id: string; nature: ConsumptionNature; sourceId: string; fingerprint: string }

/**
 * Les consommations vivantes à annuler, et pourquoi : celles dont la source ne
 * fait plus de consommation, ou a changé depuis l'instantané. Les autres
 * restent telles quelles, prêtes ou transmises.
 */
export function plannedCancellations(
  live: readonly LiveConsumption[],
  sources: ReadonlyMap<string, ConsumptionSource>,
): { id: string; reason: string }[] {
  const cancellations: { id: string; reason: string }[] = []
  for (const consumption of live) {
    const source = sources.get(sourceKey(consumption.nature, consumption.sourceId))
    const validity = sourceValidity(source)
    if (!validity.valid) {
      cancellations.push({ id: consumption.id, reason: validity.reason })
    } else if (sourceFingerprint(source!) !== consumption.fingerprint) {
      cancellations.push({
        id: consumption.id,
        reason: 'Modifiée sur le site : remplacée par une nouvelle consommation.',
      })
    }
  }
  return cancellations
}

/* ------------------------------------------------------------------------ */
/* Instantané                                                               */
/* ------------------------------------------------------------------------ */

/** Ce que le passage écrit pour une source prête. */
export type ConsumptionDraft = {
  nature: ConsumptionNature
  sourceId: string
  clientId: string
  occurredAt: Date
  quantity: number
  unit: RateUnit | null
  productRef: string | null
  description: string
  unitPriceCents: number | null
  discountBp: number | null
  discountAmountCents: number | null
  vatRateBp: number | null
  amountCents: number | null
  feesCents: number | null
  currency: string | null
  details: Record<string, unknown>
  fingerprint: string
}

/** Unités des références de tarif de Dolibarr (ADR 049) : `tarif.salle.demi-journee`. */
export const tariffUnitRefs: Record<RateUnit, string> = {
  hour: 'heure',
  half_day: 'demi-journee',
  day: 'journee',
  week: 'semaine',
  month: 'mois',
  unit: 'unite',
}

/** Unités lisibles, comme dans les devis. */
export const unitWords: Record<RateUnit, string> = {
  hour: 'heure',
  half_day: 'demi-journée',
  day: 'journée',
  week: 'semaine',
  month: 'mois',
  unit: 'unité',
}

/** « (lettre, reçu le 12/10/2026) » : le pli, comme l'accueil le retrouve. */
function mailItemWords(source: MailItemFacts, timeZone: string): string {
  return `(${mailKindLabels[source.mailKind].toLowerCase()}, reçu le ${formatCalendarDate(toIsoDate(source.receivedAt, timeZone))})`
}

function mailDetails(source: MailItemFacts, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pliId: source.mailItemId,
    typePli: source.mailKind,
    recuLe: source.receivedAt.toISOString(),
    ...extra,
  }
}

const noPrice = {
  unitPriceCents: null,
  discountBp: null,
  discountAmountCents: null,
  vatRateBp: null,
  amountCents: null,
  feesCents: null,
  currency: null,
} as const

/**
 * L'instantané d'une source prête : quantité, produit du CRM, désignation et,
 * pour une réservation, le prix figé annoncé au client (ADR 023). Les actes du
 * courrier partent sans prix : ce que coûte un acte, et ce que le contrat du
 * client en comprend, sont tenus par le CRM.
 */
export function consumptionDraft(
  source: ConsumptionSource,
  context: { timeZone: string; includedPages: number },
): ConsumptionDraft {
  const fingerprint = sourceFingerprint(source)
  const base = { nature: source.nature, sourceId: source.sourceId, fingerprint }
  switch (source.nature) {
    case 'booking': {
      const quote = source.quote
      return {
        ...base,
        clientId: source.clientId!,
        occurredAt: source.startsAt,
        quantity: quote?.quantity ?? 1,
        unit: quote?.unit ?? null,
        productRef: quote ? `tarif.${source.resourceType}.${tariffUnitRefs[quote.unit]}` : null,
        description: `${source.resourceName} — ${describeSlot(source.startsAt, source.endsAt, context.timeZone)}`,
        unitPriceCents: quote?.unitPriceCents ?? null,
        discountBp: quote?.discountBp ?? null,
        discountAmountCents: quote?.discountAmountCents ?? null,
        vatRateBp: quote?.vatRateBp ?? null,
        amountCents: quote?.amountCents ?? null,
        feesCents: null,
        currency: quote?.currency ?? null,
        details: {
          reservationId: source.sourceId,
          debut: source.startsAt.toISOString(),
          fin: source.endsAt.toISOString(),
          ressourceId: source.resourceId,
          ressource: source.resourceName,
          ressourceCode: source.resourceCode,
          typeRessource: source.resourceType,
          contratId: source.contractId,
          contratReference: source.contractReference,
        },
      }
    }
    case 'mail_opening':
      return {
        ...base,
        ...noPrice,
        clientId: source.clientId,
        occurredAt: source.openedAt!,
        quantity: 1,
        unit: 'unit',
        productRef: serviceCodes.mailOpening,
        description: `Ouverture et numérisation d’un pli ${mailItemWords(source, context.timeZone)}`,
        details: mailDetails(source),
      }
    case 'mail_pages': {
      const pages = billablePages(source.pageCount, context.includedPages)
      const beyond = context.includedPages > 0 ? ` au-delà des ${context.includedPages} comprises` : ''
      return {
        ...base,
        ...noPrice,
        clientId: source.clientId,
        occurredAt: source.openedAt!,
        quantity: pages,
        unit: 'unit',
        productRef: serviceCodes.mailPage,
        description: `${pages} ${pages > 1 ? 'pages numérisées' : 'page numérisée'}${beyond} à l’ouverture d’un pli ${mailItemWords(source, context.timeZone)}`,
        details: mailDetails(source, { pages: source.pageCount, pagesComprises: context.includedPages }),
      }
    }
    case 'mail_scan':
      return {
        ...base,
        ...noPrice,
        clientId: source.clientId,
        occurredAt: source.completedAt!,
        quantity: 1,
        unit: 'unit',
        productRef: serviceCodes.mailScan,
        description: `Numérisation d’un pli déjà ouvert ${mailItemWords(source, context.timeZone)}`,
        details: mailDetails(source, { demandeId: source.sourceId }),
      }
    case 'mail_forward':
      return {
        ...base,
        ...noPrice,
        clientId: source.clientId,
        occurredAt: source.completedAt!,
        quantity: 1,
        unit: 'unit',
        productRef: serviceCodes.mailForwarding,
        description: `Réexpédition d’un pli ${mailItemWords(source, context.timeZone)}`,
        feesCents: source.postageCents,
        currency: source.postageCurrency,
        details: mailDetails(source, { demandeId: source.sourceId }),
      }
  }
}

/* ------------------------------------------------------------------------ */
/* Ce que le CRM lit                                                        */
/* ------------------------------------------------------------------------ */

/** Natures, en français, dans l'API. */
export const consumptionNatureWords: Record<ConsumptionNature, string> = {
  booking: 'reservation',
  mail_opening: 'ouverture',
  mail_pages: 'pages',
  mail_scan: 'numerisation',
  mail_forward: 'reexpedition',
}

/** Natures, pour l'écran. */
export const consumptionNatureLabels: Record<ConsumptionNature, string> = {
  booking: 'Réservation',
  mail_opening: 'Ouverture d’un pli',
  mail_pages: 'Pages en plus',
  mail_scan: 'Numérisation',
  mail_forward: 'Réexpédition',
}

/** Une consommation relue pour le CRM : la ligne, son client et ses références dans le CRM. */
export type ConsumptionForCrm = {
  id: string
  nature: ConsumptionNature
  status: ConsumptionStatus
  occurredAt: Date
  quantity: number
  unit: RateUnit | null
  productRef: string | null
  description: string
  unitPriceCents: number | null
  discountBp: number | null
  discountAmountCents: number | null
  vatRateBp: number | null
  amountCents: number | null
  feesCents: number | null
  currency: string | null
  details: Record<string, unknown>
  crmId: string | null
  crmRef: string | null
  createdAt: Date
  sentAt: Date | null
  cancelledAt: Date | null
  cancellationReason: string | null
  client: { id: string; name: string; siret: string | null; crmId: string | null }
  /** Identifiant dans le CRM du contrat de la réservation, s'il en a un et qu'il en vient. */
  contractCrmId: string | null
}

export type DolibarrConsumption = {
  id: string
  nature: string
  statut: ConsumptionStatus
  faitLe: string
  /** Jour de la prestation, dans le calendrier du centre. */
  jour: string
  creeLe: string
  transmisLe: string | null
  annuleLe: string | null
  motifAnnulation: string | null
  dolibarrId: string | null
  dolibarrRef: string | null
  tiers: { clientId: string; dolibarrId: string | null; nom: string; siret: string | null }
  produit: string | null
  designation: string
  quantite: number
  unite: string | null
  prix: {
    prixUnitaireHtCentimes: number
    prixUnitaireHt: string
    remisePourcent: string | null
    remiseMontantCentimes: number | null
    tauxTva: string | null
    montantHtCentimes: number | null
    devise: string | null
  } | null
  frais: { libelle: string; montantCentimes: number; montant: string; devise: string | null } | null
  reservation: {
    id: string
    debut: string
    fin: string
    ressource: string
    ressourceCode: string | null
    typeRessource: string
    /** Rayon du back-office (`produits.ts`) : `salles`, `bureaux`… ; nul pour un type qui n'y est pas encore rangé. */
    produitSite: string | null
  } | null
  contrat: { id: string; reference: string | null; dolibarrId: string | null } | null
  courrier: { pliId: string; typePli: string; recuLe: string; demandeId: string | null } | null
}

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null)

/** Le rayon du site d'un type de ressource ; nul si aucun produit ne le range. */
function siteProductOf(type: string): string | null {
  return products.find((product) => (product.types as readonly string[]).includes(type))?.key ?? null
}

/**
 * La consommation telle que le CRM la lit (`GET /api/dolibarr/consommations`) :
 * un format à nous, stable, documenté dans `docs/integrations/dolibarr.md`.
 */
export function toDolibarrConsumption(row: ConsumptionForCrm, timeZone: string): DolibarrConsumption {
  const details = row.details
  const priced = row.unitPriceCents !== null
  return {
    id: row.id,
    nature: consumptionNatureWords[row.nature],
    statut: row.status,
    faitLe: row.occurredAt.toISOString(),
    jour: toIsoDate(row.occurredAt, timeZone),
    creeLe: row.createdAt.toISOString(),
    transmisLe: row.sentAt?.toISOString() ?? null,
    annuleLe: row.cancelledAt?.toISOString() ?? null,
    motifAnnulation: row.cancellationReason,
    dolibarrId: row.crmId,
    dolibarrRef: row.crmRef,
    tiers: { clientId: row.client.id, dolibarrId: row.client.crmId, nom: row.client.name, siret: row.client.siret },
    produit: row.productRef,
    designation: row.description,
    quantite: row.quantity,
    unite: row.unit ? unitWords[row.unit] : null,
    prix: priced
      ? {
          prixUnitaireHtCentimes: row.unitPriceCents!,
          prixUnitaireHt: centsToDecimal(row.unitPriceCents!),
          remisePourcent: row.discountBp === null ? null : basisPointsToPercent(row.discountBp),
          remiseMontantCentimes: row.discountAmountCents,
          tauxTva: row.vatRateBp === null ? null : basisPointsToPercent(row.vatRateBp),
          montantHtCentimes: row.amountCents,
          devise: row.currency,
        }
      : null,
    frais:
      row.feesCents !== null && row.feesCents > 0
        ? {
            libelle: 'Frais d’affranchissement',
            montantCentimes: row.feesCents,
            montant: centsToDecimal(row.feesCents),
            devise: row.currency,
          }
        : null,
    reservation:
      row.nature === 'booking'
        ? {
            id: text(details.reservationId) ?? '',
            debut: text(details.debut) ?? '',
            fin: text(details.fin) ?? '',
            ressource: text(details.ressource) ?? '',
            ressourceCode: text(details.ressourceCode),
            typeRessource: text(details.typeRessource) ?? '',
            produitSite: siteProductOf(text(details.typeRessource) ?? ''),
          }
        : null,
    contrat:
      row.nature === 'booking' && text(details.contratId)
        ? { id: text(details.contratId)!, reference: text(details.contratReference), dolibarrId: row.contractCrmId }
        : null,
    courrier:
      row.nature === 'booking'
        ? null
        : {
            pliId: text(details.pliId) ?? '',
            typePli: text(details.typePli) ?? '',
            recuLe: text(details.recuLe) ?? '',
            demandeId: text(details.demandeId),
          },
  }
}
