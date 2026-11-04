import { isCalendarDate } from '../../lib/dates.ts'
import { isUuid } from '../../lib/uuid.ts'
import { readCrmId, type Read } from '../clients/tiers-crm.ts'
import {
  CONTRACT_REFERENCE_AUTO,
  contractTypes,
  type BillingPeriod,
  type ContractStatus,
  type ContractType,
} from './schema.ts'

/**
 * Contrats reçus du CRM (ADR 066) : lecture de l'envoi et rapprochement avec
 * les contrats du site. Règles pures ; `contrats-crm-queries.ts` les applique.
 *
 * Le CRM tient les contrats (ADR 046) ; le site en garde une copie pour
 * l'**occupation** : qui occupe quel bureau ou quelle boîte aux lettres, qui
 * est domicilié, du … au …. L'occupation passe par les réservations, tenues
 * par la base à partir du contrat (ADR 018, `apply_contract_occupation`) :
 * recevoir un contrat en cours pose l'occupation de sa ressource, le résilier
 * la raccourcit, et un chevauchement est refusé comme partout (décision 3).
 *
 * Un contrat du site a au plus une ressource : un contrat du CRM qui loue un
 * bureau et un casier s'envoie en deux, chacun sous l'identifiant de sa ligne.
 *
 * Le prix reçu est celui que l'espace client affiche ; il ne sert à aucune
 * facture (le site ne facture rien). Pas de reconduction tacite sur le site :
 * le terme est celui que le CRM envoie.
 */

/** Statut du contrat dans l'API. */
export const crmContractStatuses = ['brouillon', 'en_cours', 'termine'] as const
type CrmContractStatus = (typeof crmContractStatuses)[number]

/** Statut du contrat, vers l'API. */
export const crmContractStatusWords: Record<ContractStatus, CrmContractStatus> = {
  draft: 'brouillon',
  active: 'en_cours',
  terminated: 'termine',
}

/** Périodicité du prix dans l'API. */
export const crmBillingPeriods: Record<string, BillingPeriod> = {
  mensuel: 'monthly',
  trimestriel: 'quarterly',
  annuel: 'yearly',
}

export type ReceivedContractFields = {
  reference: string
  contractType: ContractType
  status: ContractStatus
  startsOn: string
  endsOn: string | null
  terminatedOn: string | null
  terminationReason: string | null
  amountCents: number
  billingPeriod: BillingPeriod
  vatRateBp: number
  currency: string
  /** Absents de l'envoi : inchangés sur un contrat connu, valeurs du site sur un nouveau. */
  commitmentMonths?: number | null
  noticeDays?: number
}

export type ReceivedContract =
  | { removed: true; crmId: string }
  | {
      removed: false
      crmId: string
      /** Identifiant du tiers dans le CRM : il doit être déjà reçu. */
      thirdPartyCrmId: string
      /** Contrat du site désigné par le CRM : le rapprochement explicite. */
      contractId: string | null
      /** Code de la ressource du site (écran Ressources) ; nul : aucune ressource. */
      resourceCode: string | null
      fields: ReceivedContractFields
    }

/** « 20 », « 5.5 », 20 → points de base ; `undefined` si illisible. */
export function percentToBasisPoints(value: unknown): number | undefined {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim().replace(',', '.') : ''
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(text)) return undefined
  const bp = Math.round(Number(text) * 100)
  return bp >= 0 && bp <= 10000 ? bp : undefined
}

function readDate(value: unknown): string | null | 'invalid' {
  if (value === undefined || value === null || value === '') return null
  return typeof value === 'string' && isCalendarDate(value) ? value : 'invalid'
}

/** Lit l'envoi `POST /api/dolibarr/contrats`. Le message dit quoi corriger. */
export function readCrmContract(body: unknown): Read<ReceivedContract> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, message: 'Corps illisible : un objet JSON est attendu.' }
  }
  const input = body as Record<string, unknown>
  const crmId = readCrmId(input.dolibarrId)
  if (!crmId) return { ok: false, message: '« dolibarrId » est obligatoire (64 caractères au plus).' }
  if (input.supprime !== undefined && typeof input.supprime !== 'boolean') {
    return { ok: false, message: '« supprime » vaut true ou false.' }
  }
  if (input.supprime === true) return { ok: true, value: { removed: true, crmId } }

  const reference = typeof input.reference === 'string' ? input.reference.trim() : ''
  if (!reference || reference.length > 64 || reference === CONTRACT_REFERENCE_AUTO) {
    return { ok: false, message: '« reference » est obligatoire (64 caractères au plus) : la référence du contrat dans le CRM.' }
  }
  const thirdPartyCrmId = readCrmId(input.tiersDolibarrId)
  if (!thirdPartyCrmId) return { ok: false, message: '« tiersDolibarrId » est obligatoire : le tiers du contrat.' }

  let contractId: string | null = null
  if (input.contratId !== undefined && input.contratId !== null) {
    if (typeof input.contratId !== 'string' || !isUuid(input.contratId)) {
      return { ok: false, message: '« contratId » : l’identifiant d’un contrat du site, tel que le site l’a donné.' }
    }
    contractId = input.contratId
  }

  if (typeof input.type !== 'string' || !(contractTypes as readonly string[]).includes(input.type)) {
    return { ok: false, message: `« type » vaut ${contractTypes.map((type) => `« ${type} »`).join(', ')}.` }
  }
  if (typeof input.statut !== 'string' || !(crmContractStatuses as readonly string[]).includes(input.statut)) {
    return { ok: false, message: '« statut » vaut « brouillon », « en_cours » ou « termine ».' }
  }

  const startsOn = readDate(input.debut)
  if (startsOn === null || startsOn === 'invalid') return { ok: false, message: '« debut » est obligatoire : une date AAAA-MM-JJ.' }
  const endsOn = readDate(input.fin)
  if (endsOn === 'invalid') return { ok: false, message: '« fin » : une date AAAA-MM-JJ, ou null sans terme.' }
  if (endsOn && endsOn < startsOn) return { ok: false, message: '« fin » précède « debut ».' }
  const terminationDate = readDate(input.resilieLe)
  if (terminationDate === 'invalid') return { ok: false, message: '« resilieLe » : une date AAAA-MM-JJ.' }
  const reasonText = typeof input.motifResiliation === 'string' ? input.motifResiliation.trim() : ''
  if (reasonText.length > 500) return { ok: false, message: '« motifResiliation » : 500 caractères au plus.' }

  // Résilié ou arrivé à terme, comme sur le site : le statut et le dernier
  // jour vont ensemble (`contracts_terminated_on_consistent`). Une résiliation
  // datée d'un contrat encore en cours l'est déjà sur le site : l'occupation
  // court jusqu'à cette date.
  let status: ContractStatus = input.statut === 'brouillon' ? 'draft' : 'active'
  let terminatedOn: string | null = null
  if (input.statut === 'termine' || (input.statut === 'en_cours' && terminationDate)) {
    terminatedOn = terminationDate ?? endsOn
    if (!terminatedOn) {
      return { ok: false, message: 'Un contrat terminé porte « resilieLe » ou « fin ».' }
    }
    status = 'terminated'
  }

  let resourceCode: string | null = null
  if (input.ressource !== undefined && input.ressource !== null && input.ressource !== '') {
    if (typeof input.ressource !== 'string' || input.ressource.trim().length > 64) {
      return { ok: false, message: '« ressource » : le code d’une ressource du site (64 caractères au plus), ou null.' }
    }
    resourceCode = input.ressource.trim()
  }

  const price = input.prix
  if (typeof price !== 'object' || price === null || Array.isArray(price)) {
    return {
      ok: false,
      message: '« prix » est obligatoire : { montantHtCentimes, periodicite, tauxTva, devise } — celui que l’espace client affiche.',
    }
  }
  const p = price as Record<string, unknown>
  if (typeof p.montantHtCentimes !== 'number' || !Number.isInteger(p.montantHtCentimes) || p.montantHtCentimes < 0) {
    return { ok: false, message: '« prix.montantHtCentimes » : un entier positif, en centimes, par période.' }
  }
  const billingPeriod =
    typeof p.periodicite === 'string' && Object.hasOwn(crmBillingPeriods, p.periodicite)
      ? crmBillingPeriods[p.periodicite]
      : undefined
  if (!billingPeriod) return { ok: false, message: '« prix.periodicite » vaut « mensuel », « trimestriel » ou « annuel ».' }
  const vatRateBp = p.tauxTva === undefined || p.tauxTva === null ? 2000 : percentToBasisPoints(p.tauxTva)
  if (vatRateBp === undefined) return { ok: false, message: '« prix.tauxTva » : un pourcentage, « 20 » ou « 5.5 ».' }
  const currency = p.devise === undefined || p.devise === null ? 'EUR' : p.devise
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
    return { ok: false, message: '« prix.devise » : un code ISO 4217 en capitales (EUR).' }
  }

  const fields: ReceivedContractFields = {
    reference,
    contractType: input.type as ContractType,
    status,
    startsOn,
    endsOn,
    terminatedOn,
    terminationReason: status === 'terminated' ? reasonText || null : null,
    amountCents: p.montantHtCentimes,
    billingPeriod,
    vatRateBp,
    currency,
  }
  if (input.engagementMois !== undefined) {
    if (input.engagementMois === null) fields.commitmentMonths = null
    else if (typeof input.engagementMois === 'number' && Number.isInteger(input.engagementMois) && input.engagementMois >= 1 && input.engagementMois <= 120) {
      fields.commitmentMonths = input.engagementMois
    } else return { ok: false, message: '« engagementMois » : de 1 à 120, ou null sans engagement.' }
  }
  if (input.preavisJours !== undefined) {
    if (typeof input.preavisJours === 'number' && Number.isInteger(input.preavisJours) && input.preavisJours >= 0 && input.preavisJours <= 3650) {
      fields.noticeDays = input.preavisJours
    } else return { ok: false, message: '« preavisJours » : un nombre de jours, de 0 à 3650.' }
  }

  return { ok: true, value: { removed: false, crmId, thirdPartyCrmId, contractId, resourceCode, fields } }
}

/* ------------------------------------------------------------------------ */
/* Rapprochement                                                            */
/* ------------------------------------------------------------------------ */

export type ContractCandidate = {
  contractId: string
  reference: string
  clientId: string
  archived: boolean
  /** Objet du CRM auquel le contrat est déjà relié. */
  linkedTo: string | null
}

export type ContractMatchDecision =
  | { kind: 'update'; contractId: string; how: 'link' | 'explicit' | 'reference' }
  | { kind: 'create' }
  | { kind: 'remove'; contractId: string }
  | { kind: 'ignore'; contractId: string | null; message: string }
  | { kind: 'refuse'; status: 404 | 409; message: string }

/**
 * Quel contrat du site ce contrat du CRM est, dans l'ordre : celui qui lui est
 * déjà relié ; celui que le CRM désigne (`contratId`) ; le seul contrat
 * vivant, non relié, du même client et de même référence (repris d'avant le
 * CRM sous son numéro) ; sinon un nouveau. Un contrat archivé sur le site ne
 * se met plus à jour.
 */
export function decideContractMatch(
  input: ReceivedContract,
  candidates: {
    linked: ContractCandidate | null
    explicit: ContractCandidate | 'missing' | null
    byReference: ContractCandidate | null
    clientId: string | null
  },
): ContractMatchDecision {
  const { linked } = candidates
  if (input.removed) {
    if (!linked) return { kind: 'ignore', contractId: null, message: 'Contrat inconnu du site : rien à retirer.' }
    return linked.archived
      ? { kind: 'ignore', contractId: linked.contractId, message: 'Contrat déjà archivé sur le site.' }
      : { kind: 'remove', contractId: linked.contractId }
  }
  if (linked) {
    if (input.contractId && input.contractId !== linked.contractId) {
      return {
        kind: 'refuse',
        status: 409,
        message: `Ce contrat est déjà rapproché du contrat ${linked.reference} du site (${linked.contractId}).`,
      }
    }
    return linked.archived
      ? { kind: 'ignore', contractId: linked.contractId, message: `Le contrat ${linked.reference} est archivé sur le site : il ne se met plus à jour.` }
      : { kind: 'update', contractId: linked.contractId, how: 'link' }
  }
  const { explicit } = candidates
  if (input.contractId) {
    if (!explicit || explicit === 'missing') {
      return { kind: 'refuse', status: 404, message: `Aucun contrat du site n’a l’identifiant ${input.contractId}.` }
    }
    if (explicit.archived) return { kind: 'refuse', status: 409, message: `Le contrat ${explicit.reference} est archivé sur le site.` }
    if (explicit.linkedTo) {
      return {
        kind: 'refuse',
        status: 409,
        message: `Le contrat ${explicit.reference} est déjà rapproché de l’objet ${explicit.linkedTo} du CRM.`,
      }
    }
    return { kind: 'update', contractId: explicit.contractId, how: 'explicit' }
  }
  const { byReference } = candidates
  if (byReference && !byReference.archived) {
    if (byReference.linkedTo || byReference.clientId !== candidates.clientId) {
      return {
        kind: 'refuse',
        status: 409,
        message: `La référence ${input.fields.reference} est déjà celle d’un autre contrat du site : envoyer « contratId », ou changer la référence.`,
      }
    }
    return { kind: 'update', contractId: byReference.contractId, how: 'reference' }
  }
  return { kind: 'create' }
}
