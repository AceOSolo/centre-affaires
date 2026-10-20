import { rateUnitLabels } from './labels.ts'
import type { LineDraft } from './propositions.ts'
import type { RateUnit } from './schema.ts'
import type { ProposalProduct, ProposalStatus } from './schema-devis.ts'
import { parseAmountToCents, parsePercentToBasisPoints } from './tarifs.ts'

/**
 * Écrans des devis au back-office (ADR 043) : lecture des formulaires et
 * textes d'aide, sans base, pour être éprouvés par `node --test`.
 *
 * Les saisies sont relues ici côté serveur ; la base revérifie (`CA016`,
 * contraintes de `proposal_lines`).
 */

// --- Onglets de la liste -----------------------------------------------------

export const proposalStatusGroups = ['a-completer', 'prets', 'transmis', 'clos', 'tous'] as const
export type ProposalStatusGroup = (typeof proposalStatusGroups)[number]

export const proposalStatusGroupLabels: Record<ProposalStatusGroup, string> = {
  'a-completer': 'À compléter',
  prets: 'Prêts',
  transmis: 'Transmis',
  clos: 'Clos',
  tous: 'Tous',
}

/** États de chaque onglet ; vide : tous les états. */
export const proposalStatusGroupStatuses: Record<ProposalStatusGroup, readonly ProposalStatus[]> = {
  'a-completer': ['draft'],
  prets: ['ready'],
  transmis: ['sent'],
  clos: ['accepted', 'refused', 'cancelled'],
  tous: [],
}

/** L'onglet demandé par `?statut=`, « À compléter » par défaut ou sur une valeur inconnue. */
export function parseStatusGroup(value: string | string[] | undefined): ProposalStatusGroup {
  const raw = Array.isArray(value) ? value[0] : value
  return (proposalStatusGroups as readonly string[]).includes(raw ?? '') ? (raw as ProposalStatusGroup) : 'a-completer'
}

/** Ce que dit un onglet vide, et ce qu'il y a à faire ensuite. */
export const emptyGroupMessages: Record<ProposalStatusGroup, string> = {
  'a-completer':
    'Aucun devis à compléter. Les demandes du site et de l’espace client en déposent ici ; vous pouvez aussi établir un devis vous-même.',
  prets: 'Aucun devis en attente de Dolibarr. Un devis validé apparaît ici jusqu’à ce que Dolibarr le reprenne.',
  transmis: 'Aucun devis transmis en attente de signature. Dolibarr y range les devis qu’il a repris.',
  clos: 'Aucun devis clos : signés, refusés et annulés se rangent ici.',
  tous: 'Aucun devis pour l’instant. Établissez le premier, ou attendez les demandes du site.',
}

// --- Ce qui manque à un brouillon --------------------------------------------

/**
 * La phrase en tête d'un devis : ce qui manque, ou ce qui va se passer.
 * Une seule phrase, la plus utile : l'accueil sait quoi faire en arrivant.
 */
export function proposalGuidance(proposal: {
  status: ProposalStatus
  product: ProposalProduct
  lines: readonly { unitPriceCents: number }[]
  hasBooking: boolean
  dolibarrRef: string | null
}): string {
  switch (proposal.status) {
    case 'draft':
      if (proposal.lines.length === 0) {
        return proposal.hasBooking
          ? 'Aucune ligne : la réservation n’a pas de prix figé, ajoutez le prix avant de valider.'
          : 'Aucune ligne : ajoutez le prix avant de valider.'
      }
      if (proposal.lines.some((line) => line.unitPriceCents === 0)) {
        return 'Une ligne est à 0 € : vérifiez son prix, puis validez le devis pour qu’il parte vers Dolibarr.'
      }
      return 'Relisez les réponses et les lignes, puis validez le devis : il partira vers Dolibarr.'
    case 'ready':
      return 'Validé : Dolibarr le reprendra à son prochain passage. Remettez-le en brouillon pour le modifier d’ici là.'
    case 'sent':
      return `Repris par Dolibarr${proposal.dolibarrRef ? ` sous la référence ${proposal.dolibarrRef}` : ''} : la suite (envoi, signature) se fait dans Dolibarr.`
    case 'accepted':
      return 'Signé, d’après Dolibarr. La facture se fait dans Dolibarr.'
    case 'refused':
      return 'Refusé, d’après Dolibarr.'
    case 'cancelled':
      return 'Annulé : ce devis reste consultable, il ne change plus.'
  }
}

// --- Lignes ------------------------------------------------------------------

export const MAX_LINE_LABEL_LENGTH = 300
export const MAX_LINE_DESCRIPTION_LENGTH = 2000
export const MAX_QUANTITY = 100_000
export const MAX_NOTE_LENGTH = 5000
export const MAX_CANCEL_REASON_LENGTH = 500

const rateUnitValues = Object.keys(rateUnitLabels) as RateUnit[]

/** Saisie d'une ligne, telle que le formulaire l'envoie : à renvoyer au formulaire après un refus. */
export type LineFormValues = {
  mode: 'service' | 'manual'
  serviceId: string
  label: string
  description: string
  unit: string
  quantity: string
  unitPrice: string
  vatRate: string
  discountPercent: string
  discountAmount: string
}

export type LineFormErrors = Partial<Record<keyof LineFormValues, string>>

export const lineFieldLabels: Record<keyof LineFormValues, string> = {
  mode: 'Type de ligne',
  serviceId: 'Service du catalogue',
  label: 'Désignation',
  description: 'Description',
  unit: 'Unité',
  quantity: 'Quantité',
  unitPrice: 'Prix unitaire HT',
  vatRate: 'TVA',
  discountPercent: 'Remise en pourcentage',
  discountAmount: 'Remise en euros',
}

type FormSource = { get(name: string): unknown }

const text = (source: FormSource, name: string) => String(source.get(name) ?? '').trim()

export function lineFormValues(source: FormSource): LineFormValues {
  return {
    mode: text(source, 'mode') === 'service' ? 'service' : 'manual',
    serviceId: text(source, 'serviceId'),
    label: text(source, 'label'),
    description: text(source, 'description'),
    unit: text(source, 'unit'),
    quantity: text(source, 'quantity'),
    unitPrice: text(source, 'unitPrice'),
    vatRate: text(source, 'vatRate'),
    discountPercent: text(source, 'discountPercent'),
    discountAmount: text(source, 'discountAmount'),
  }
}

function parseQuantity(raw: string): number | string {
  if (!raw) return 'Saisissez une quantité.'
  const value = Number(raw.replace(/\s/g, ''))
  if (!Number.isInteger(value) || value < 1) return 'Saisissez un nombre entier, au moins 1.'
  if (value > MAX_QUANTITY) return `Au plus ${MAX_QUANTITY.toLocaleString('fr-FR')}.`
  return value
}

/** Les champs chiffrés d'une ligne, communs à l'ajout manuel et à la modification. */
export type LinePricing = Pick<
  LineDraft,
  'label' | 'description' | 'unit' | 'quantity' | 'unitPriceCents' | 'discountBp' | 'discountAmountCents' | 'vatRateBp'
>

/**
 * Ligne saisie à la main (ou modifiée) : désignation, unité, quantité, prix
 * HT en euros (rendu en centimes), TVA en % (rendue en points de base), une
 * remise facultative, en % ou en euros, pas les deux.
 */
export function parseManualLine(values: LineFormValues): { line?: LinePricing; errors: LineFormErrors } {
  const errors: LineFormErrors = {}

  if (!values.label) errors.label = 'Saisissez la désignation, telle que Dolibarr la reprendra.'
  else if (values.label.length > MAX_LINE_LABEL_LENGTH) errors.label = `${MAX_LINE_LABEL_LENGTH} caractères au plus.`
  if (values.description.length > MAX_LINE_DESCRIPTION_LENGTH) {
    errors.description = `${MAX_LINE_DESCRIPTION_LENGTH} caractères au plus.`
  }

  const unit = rateUnitValues.find((candidate) => candidate === values.unit)
  if (!unit) errors.unit = 'Choisissez une unité.'

  const quantity = parseQuantity(values.quantity)
  if (typeof quantity === 'string') errors.quantity = quantity

  const unitPriceCents = values.unitPrice ? parseAmountToCents(values.unitPrice) : undefined
  if (!values.unitPrice) errors.unitPrice = 'Saisissez le prix unitaire HT, en euros.'
  else if (unitPriceCents === undefined) errors.unitPrice = 'Saisissez un montant en euros, par exemple 120 ou 85,50.'

  const vatRateBp = values.vatRate ? parsePercentToBasisPoints(values.vatRate) : undefined
  if (!values.vatRate) errors.vatRate = 'Saisissez le taux de TVA, par exemple 20.'
  else if (vatRateBp === undefined) errors.vatRate = 'Saisissez un taux entre 0 et 100, par exemple 20 ou 5,5.'

  let discountBp: number | null = null
  let discountAmountCents: number | null = null
  if (values.discountPercent && values.discountAmount) {
    errors.discountAmount = 'Une seule remise : en pourcentage ou en euros, pas les deux.'
  } else if (values.discountPercent) {
    const parsed = parsePercentToBasisPoints(values.discountPercent)
    if (parsed === undefined) errors.discountPercent = 'Saisissez un pourcentage entre 0 et 100.'
    else discountBp = parsed
  } else if (values.discountAmount) {
    const parsed = parseAmountToCents(values.discountAmount)
    if (parsed === undefined) errors.discountAmount = 'Saisissez un montant en euros.'
    else discountAmountCents = parsed
  }
  if (
    discountAmountCents !== null &&
    typeof quantity === 'number' &&
    unitPriceCents !== undefined &&
    discountAmountCents > quantity * unitPriceCents
  ) {
    errors.discountAmount = 'La remise dépasse le montant de la ligne.'
  }

  if (Object.keys(errors).length > 0 || !unit || typeof quantity !== 'number' || unitPriceCents === undefined || vatRateBp === undefined) {
    return { errors }
  }
  return {
    line: {
      label: values.label,
      description: values.description || null,
      unit,
      quantity,
      unitPriceCents,
      discountBp,
      discountAmountCents,
      vatRateBp,
    },
    errors,
  }
}

/** Un service du catalogue, tel que le devis le copie. */
export type CatalogueService = {
  id: string
  name: string
  unit: RateUnit
  unitPriceCents: number
  vatRateBp: number
  description: string | null
}

/**
 * Ligne tirée du catalogue : désignation, prix et TVA copiés du service, la
 * quantité seule saisie. La copie fige le prix : changer le service ensuite
 * ne change pas le devis.
 */
export function parseServiceLine(
  values: LineFormValues,
  service: CatalogueService | undefined,
): { line?: LineDraft; errors: LineFormErrors } {
  const errors: LineFormErrors = {}
  if (!values.serviceId) errors.serviceId = 'Choisissez un service.'
  else if (!service) errors.serviceId = 'Ce service n’est plus proposé : choisissez-en un autre.'
  const quantity = parseQuantity(values.quantity)
  if (typeof quantity === 'string') errors.quantity = quantity
  if (!service || typeof quantity !== 'number') return { errors }
  return {
    line: {
      source: 'service',
      label: service.name,
      description: service.description,
      unit: service.unit,
      quantity,
      unitPriceCents: service.unitPriceCents,
      discountBp: null,
      discountAmountCents: null,
      vatRateBp: service.vatRateBp,
      resourceId: null,
      serviceId: service.id,
      ratePlanItemId: null,
    },
    errors,
  }
}

// --- Demandeur d'un devis établi par l'accueil -------------------------------

export type RequesterFormValues = {
  recipient: 'client' | 'prospect'
  clientId: string
  requesterName: string
  requesterEmail: string
  requesterPhone: string
  requesterCompany: string
  message: string
  staffNote: string
}

export type RequesterFormErrors = Partial<Record<keyof RequesterFormValues, string>>

export const requesterFieldLabels: Record<keyof RequesterFormValues, string> = {
  recipient: 'Destinataire',
  clientId: 'Client',
  requesterName: 'Nom du demandeur',
  requesterEmail: 'Courriel',
  requesterPhone: 'Téléphone',
  requesterCompany: 'Entreprise',
  message: 'Demande du client',
  staffNote: 'Note de l’accueil',
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function requesterFormValues(source: FormSource): RequesterFormValues {
  return {
    recipient: text(source, 'recipient') === 'client' ? 'client' : 'prospect',
    clientId: text(source, 'clientId'),
    requesterName: text(source, 'requesterName'),
    requesterEmail: text(source, 'requesterEmail'),
    requesterPhone: text(source, 'requesterPhone'),
    requesterCompany: text(source, 'requesterCompany'),
    message: text(source, 'message'),
    staffNote: text(source, 'staffNote'),
  }
}

/**
 * Le destinataire du devis : une entreprise cliente, choisie dans la liste,
 * ou un prospect dont il faut au moins un courriel (Dolibarr crée son tiers
 * à partir de ces champs). `clientIds` : les clients que la liste proposait.
 */
export function parseRequester(
  values: RequesterFormValues,
  clientIds: ReadonlySet<string>,
): {
  requester?: {
    clientId: string | null
    requesterName: string | null
    requesterEmail: string | null
    requesterPhone: string | null
    requesterCompany: string | null
    message: string | null
    staffNote: string | null
  }
  errors: RequesterFormErrors
} {
  const errors: RequesterFormErrors = {}
  if (values.recipient === 'client') {
    if (!values.clientId) errors.clientId = 'Choisissez le client.'
    else if (!clientIds.has(values.clientId)) errors.clientId = 'Ce client n’existe plus : choisissez-en un autre.'
  } else {
    if (!values.requesterEmail) errors.requesterEmail = 'Saisissez le courriel du demandeur : Dolibarr lui enverra le devis.'
    else if (!EMAIL.test(values.requesterEmail) || values.requesterEmail.length > 320) {
      errors.requesterEmail = 'Saisissez un courriel valide, par exemple nom@entreprise.fr.'
    }
    if (!values.requesterName && !values.requesterCompany) {
      errors.requesterName = 'Saisissez le nom du demandeur ou celui de son entreprise.'
    }
  }
  if (values.requesterEmail && values.recipient === 'client' && !EMAIL.test(values.requesterEmail)) {
    errors.requesterEmail = 'Saisissez un courriel valide, par exemple nom@entreprise.fr.'
  }
  if (values.requesterPhone.length > 40) errors.requesterPhone = '40 caractères au plus.'
  if (values.message.length > MAX_NOTE_LENGTH) errors.message = `${MAX_NOTE_LENGTH} caractères au plus.`
  if (values.staffNote.length > MAX_NOTE_LENGTH) errors.staffNote = `${MAX_NOTE_LENGTH} caractères au plus.`
  if (Object.keys(errors).length > 0) return { errors }
  return {
    requester: {
      clientId: values.recipient === 'client' ? values.clientId : null,
      requesterName: values.requesterName || null,
      requesterEmail: values.requesterEmail || null,
      requesterPhone: values.requesterPhone || null,
      requesterCompany: values.recipient === 'client' ? null : values.requesterCompany || null,
      message: values.message || null,
      staffNote: values.staffNote || null,
    },
    errors,
  }
}
