import { isCalendarDate } from '../../lib/dates.ts'
import {
  priceActs,
  type ActCatalogueService,
  type ActOccurrence,
  type ActSubscription,
} from '../facturation/souscriptions-regles.ts'
import { formatCents, parseAmountToCents } from '../facturation/tarifs.ts'
import type { MailKind, MailRequestKind, MailRequestStatus, MailStatus } from './schema.ts'

/**
 * Règles des demandes sur un pli (R21, R24, ADR 037), sans base ni framework,
 * pour être éprouvées seules.
 *
 * La base tient les transitions, les dates et l'unicité (`mail_requests_guard`,
 * `mail_requests_pending_key`) : ces règles ne décident que de ce que l'écran
 * propose. Une action proposée à tort serait refusée par la base, et le refus
 * dit à l'écran (CA008).
 */

/* -------------------------------------------------------------------------- */
/* États                                                                      */
/* -------------------------------------------------------------------------- */

/** Une demande en cours : le centre doit encore agir. */
export const pendingRequestStatuses = ['requested', 'in_progress'] as const satisfies readonly MailRequestStatus[]

export function isPendingRequest(status: MailRequestStatus): boolean {
  return (pendingRequestStatuses as readonly MailRequestStatus[]).includes(status)
}

/** Ce que l'on sait d'un pli pour décider des demandes qu'il peut recevoir. */
export type MailRequestContext = {
  status: MailStatus
  openedAt: Date | null
  /** Une réexpédition faite : le pli a quitté le centre. */
  forwarded: boolean
  /** Natures des demandes en cours sur le pli. */
  pendingKinds: readonly MailRequestKind[]
}

/**
 * Ce qu'une personne de l'entreprise peut encore demander sur un pli :
 *
 * - l'ouverture et la numérisation d'un pli fermé, sans demande d'ouverture en
 *   cours ;
 * - la numérisation seule d'un pli déjà ouvert (pages oubliées, numérisation
 *   effacée au terme de sa conservation) ;
 * - la réexpédition, ouvert ou non.
 *
 * Une demande de chaque nature au plus en cours ; rien sur un pli réexpédié.
 */
export function clientRequestOptions(item: MailRequestContext): Record<MailRequestKind, boolean> {
  if (item.forwarded) return { open_and_scan: false, scan: false, forward: false }
  const pending = new Set(item.pendingKinds)
  return {
    open_and_scan: item.status === 'received' && item.openedAt === null && !pending.has('open_and_scan'),
    scan: item.openedAt !== null && !pending.has('scan'),
    forward: !pending.has('forward'),
  }
}

/**
 * Le client annule une demande tant que le centre ne l'a pas prise en charge.
 * Après, le travail est commencé : il s'adresse au centre.
 */
export function canClientCancelRequest(status: MailRequestStatus): boolean {
  return status === 'requested'
}

/** Ce que l'accueil peut faire d'une demande, et pourquoi pas encore. */
export type StaffRequestActions = {
  start: boolean
  refuse: boolean
  /** Annuler à la demande du client (consigne par téléphone). */
  cancel: boolean
  /**
   * Comment la clore : en ouvrant le pli (une ouverture se clôt avec lui), en
   * déposant la numérisation, ou en notant l'envoi. Nul : rien à clore.
   */
  complete: 'open' | 'scan' | 'forward' | null
  /** Pourquoi elle ne peut pas encore être close. */
  blockedBy: string | null
  /** Frais et suivi d'une réexpédition faite : modifiables tant que rien ne la facture. */
  editShipping: boolean
}

export function staffRequestActions(
  request: { kind: MailRequestKind; status: MailRequestStatus },
  context: {
    /** Autres demandes en cours sur le même pli. */
    otherPending: number
    /** Pli retiré : ses demandes en cours ont été refusées par la base. */
    withdrawn: boolean
    /** Une ligne de facture vivante tient la demande. */
    billed: boolean
  },
): StaffRequestActions {
  const pending = isPendingRequest(request.status)
  const open = pending && !context.withdrawn
  let complete: StaffRequestActions['complete'] = null
  let blockedBy: string | null = null
  if (open) {
    if (request.kind === 'open_and_scan') complete = 'open'
    else if (request.kind === 'scan') complete = 'scan'
    else if (context.otherPending > 0) {
      // Réexpédié, le pli quitte le centre : les autres demandes d'abord.
      blockedBy =
        context.otherPending > 1
          ? `${context.otherPending} autres demandes attendent sur ce pli : traitez-les ou refusez-les avant de le réexpédier.`
          : 'Une autre demande attend sur ce pli : traitez-la ou refusez-la avant de le réexpédier.'
    } else complete = 'forward'
  }
  return {
    start: open && request.status === 'requested',
    refuse: open,
    cancel: open && request.status === 'requested',
    complete,
    blockedBy,
    editShipping: request.kind === 'forward' && request.status === 'done' && !context.billed,
  }
}

/* -------------------------------------------------------------------------- */
/* Réexpédition : adresse figée à la demande                                  */
/* -------------------------------------------------------------------------- */

export type ForwardAddress = {
  recipient: string
  line1: string
  line2: string | null
  postalCode: string
  city: string
  /** ISO 3166-1 alpha-2. */
  country: string
}

/**
 * Pays proposés à la réexpédition : l'Union européenne et ses voisins, puis
 * l'Amérique du Nord. Une liste fermée : le code est stocké tel quel
 * (`char(2)`), et un pays saisi à la main finirait illisible pour La Poste.
 */
export const forwardCountries = [
  'FR', 'BE', 'LU', 'CH', 'MC', 'DE', 'AT', 'ES', 'PT', 'IT', 'NL', 'IE', 'GB', 'DK', 'SE', 'FI',
  'NO', 'PL', 'CZ', 'SK', 'SI', 'HR', 'HU', 'RO', 'BG', 'GR', 'CY', 'MT', 'EE', 'LV', 'LT', 'IS',
  'US', 'CA',
] as const

const regionNames = new Intl.DisplayNames(['fr'], { type: 'region' })

/** « France », « Belgique » : le nom du pays en français, son code s'il est inconnu. */
export function countryName(code: string): string {
  try {
    return regionNames.of(code) ?? code
  } catch {
    return code
  }
}

/** Noms des champs du formulaire, qui sont aussi leurs `id` (résumé d'erreurs). */
export const forwardAddressFieldLabels = {
  forwardRecipient: 'Destinataire',
  forwardAddressLine1: 'Adresse',
  forwardAddressLine2: 'Complément d’adresse',
  forwardPostalCode: 'Code postal',
  forwardCity: 'Ville',
  forwardCountry: 'Pays',
} as const

type ForwardField = keyof typeof forwardAddressFieldLabels

const LIMITS: Record<ForwardField, number> = {
  forwardRecipient: 120,
  forwardAddressLine1: 120,
  forwardAddressLine2: 120,
  forwardPostalCode: 16,
  forwardCity: 80,
  forwardCountry: 2,
}

/**
 * Lit l'adresse saisie. Destinataire, adresse, code postal, ville et pays sont
 * obligatoires, comme en base (`mail_requests_forward_address`) ; le code
 * postal français a cinq chiffres.
 */
export function readForwardAddress(
  values: Partial<Record<ForwardField, string>>,
): { address: ForwardAddress; fieldErrors?: undefined } | { address?: undefined; fieldErrors: Record<string, string> } {
  const value = (field: ForwardField) => (values[field] ?? '').replace(/\s+/g, ' ').trim()
  const fieldErrors: Record<string, string> = {}
  const required: [ForwardField, string][] = [
    ['forwardRecipient', 'Indiquez le nom du destinataire.'],
    ['forwardAddressLine1', 'Indiquez l’adresse.'],
    ['forwardPostalCode', 'Indiquez le code postal.'],
    ['forwardCity', 'Indiquez la ville.'],
  ]
  for (const [field, message] of required) {
    if (!value(field)) fieldErrors[field] = message
  }
  for (const field of Object.keys(LIMITS) as ForwardField[]) {
    if (field !== 'forwardCountry' && value(field).length > LIMITS[field]) {
      fieldErrors[field] = `${LIMITS[field]} caractères au plus.`
    }
  }
  const country = value('forwardCountry').toUpperCase()
  if (!(forwardCountries as readonly string[]).includes(country)) {
    fieldErrors.forwardCountry = 'Choisissez le pays dans la liste.'
  }
  const postalCode = value('forwardPostalCode').toUpperCase()
  if (!fieldErrors.forwardPostalCode && postalCode) {
    if (country === 'FR' && !/^\d{5}$/.test(postalCode)) {
      fieldErrors.forwardPostalCode = 'Un code postal français a cinq chiffres.'
    } else if (!/^[A-Z0-9][A-Z0-9 -]*$/.test(postalCode)) {
      fieldErrors.forwardPostalCode = 'Lettres, chiffres, espaces et tirets seulement.'
    }
  }
  if (Object.keys(fieldErrors).length > 0) return { fieldErrors }
  return {
    address: {
      recipient: value('forwardRecipient'),
      line1: value('forwardAddressLine1'),
      line2: value('forwardAddressLine2') || null,
      postalCode,
      city: value('forwardCity'),
      country,
    },
  }
}

/** Lignes d'une adresse, telles qu'on les écrit sur l'enveloppe. */
export function forwardAddressLines(address: ForwardAddress): string[] {
  return [
    address.recipient,
    address.line1,
    ...(address.line2 ? [address.line2] : []),
    `${address.postalCode} ${address.city}`,
    countryName(address.country),
  ]
}

/** Deux adresses identiques à la casse et aux espaces près. */
export function sameForwardAddress(a: ForwardAddress, b: ForwardAddress): boolean {
  const key = (address: ForwardAddress) =>
    [address.recipient, address.line1, address.line2 ?? '', address.postalCode, address.city, address.country]
      .map((part) => part.replace(/\s+/g, ' ').trim().toLowerCase())
      .join('|')
  return key(a) === key(b)
}

/* -------------------------------------------------------------------------- */
/* Saisies de l'accueil                                                        */
/* -------------------------------------------------------------------------- */

/** 1 000 € : au-delà, c'est une faute de frappe, pas un affranchissement. */
export const MAX_POSTAGE_CENTS = 100_000

/** Frais d'affranchissement saisis en euros, en centimes (décision 5). Vide : pas encore relevés. */
export function readPostage(input: string): { cents: number | null; error?: undefined } | { error: string } {
  const trimmed = input.trim()
  if (!trimmed) return { cents: null }
  const cents = parseAmountToCents(trimmed)
  if (cents === undefined) return { error: 'Montant illisible : en euros, par exemple 4,35.' }
  if (cents > MAX_POSTAGE_CENTS) return { error: `${formatCents(MAX_POSTAGE_CENTS)} au plus.` }
  return { cents }
}

/** Numéro de suivi de La Poste ou d'un transporteur : lettres, chiffres, espaces, tirets. */
export function readTrackingNumber(input: string): { value: string | null; error?: undefined } | { error: string } {
  const value = input.replace(/\s+/g, ' ').trim()
  if (!value) return { value: null }
  if (value.length > 64) return { error: '64 caractères au plus.' }
  if (!/^[A-Za-z0-9][A-Za-z0-9 -]*$/.test(value)) {
    return { error: 'Lettres, chiffres, espaces et tirets seulement.' }
  }
  return { value: value.toUpperCase() }
}

/** Motif d'un refus : obligatoire, montré au client (ADR 037). */
export function readRefusalReason(input: string): { value: string; error?: undefined } | { error: string } {
  const value = input.trim()
  if (!value) return { error: 'Indiquez le motif : le client le lira dans son espace.' }
  if (value.length > 500) return { error: '500 caractères au plus.' }
  return { value }
}

/** Consigne du client, facultative et figée avec la demande. */
export function readClientNote(input: string): { value: string | null; error?: undefined } | { error: string } {
  const value = input.trim()
  if (!value) return { value: null }
  if (value.length > 500) return { error: '500 caractères au plus.' }
  return { value }
}

/* -------------------------------------------------------------------------- */
/* Filtres et pages                                                           */
/* -------------------------------------------------------------------------- */

type SearchParams = Record<string, string | string[] | undefined>

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)

/** Page demandée dans l'URL : un entier de 1 à 10 000, 1 sinon. */
export function readPage(value: string | string[] | undefined): number {
  const page = Number(first(value))
  return Number.isInteger(page) && page >= 1 && page <= 10_000 ? page : 1
}

/** Nombre de pages, au moins une : une liste vide a sa page, qui dit quoi faire. */
export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize))
}

/** Plis par page dans la boîte aux lettres du client. */
export const CLIENT_MAIL_PAGE_SIZE = 20
/** Demandes par page, côté client comme côté centre. */
export const REQUEST_PAGE_SIZE = 25

/** État d'un pli, tel que le client le filtre. */
export const clientMailStates = ['non-ouvert', 'numerise', 'demande-en-cours', 'reexpedie'] as const
export type ClientMailState = (typeof clientMailStates)[number]

export const clientMailStateLabels: Record<ClientMailState, string> = {
  'non-ouvert': 'Non ouvert',
  numerise: 'Ouvert et numérisé',
  'demande-en-cours': 'Avec une demande en cours',
  reexpedie: 'Réexpédié',
}

const mailKindValues: readonly MailKind[] = ['lettre', 'recommande', 'colis', 'autre']

export type ClientMailFilters = {
  kind?: MailKind
  /** Jours du centre, bornes comprises. */
  from?: string
  to?: string
  state?: ClientMailState
}

/**
 * Filtres de la boîte aux lettres, lus dans l'URL : type de pli, période de
 * réception, état. Une valeur illisible est ignorée, pas refusée ; une période
 * à l'envers est remise dans l'ordre.
 */
export function readClientMailFilters(params: SearchParams): ClientMailFilters & { page: number } {
  const kind = first(params.type)
  const state = first(params.etat)
  let from = first(params.du)
  let to = first(params.au)
  if (!isCalendarDate(from)) from = undefined
  if (!isCalendarDate(to)) to = undefined
  if (from && to && from > to) [from, to] = [to, from]
  return {
    kind: mailKindValues.includes(kind as MailKind) ? (kind as MailKind) : undefined,
    from,
    to,
    state: (clientMailStates as readonly string[]).includes(state ?? '') ? (state as ClientMailState) : undefined,
    page: readPage(params.page),
  }
}

/** Chaîne de requête d'une page de la boîte aux lettres, filtres gardés. */
export function clientMailQuery(filters: ClientMailFilters, page = 1): string {
  const query = new URLSearchParams()
  if (filters.kind) query.set('type', filters.kind)
  if (filters.from) query.set('du', filters.from)
  if (filters.to) query.set('au', filters.to)
  if (filters.state) query.set('etat', filters.state)
  if (page > 1) query.set('page', String(page))
  const text = query.toString()
  return text ? `?${text}` : ''
}

/** Filtre d'état des demandes, dans l'URL : en français, stable. */
export const requestStateFilters = {
  'a-traiter': ['requested', 'in_progress'],
  demandee: ['requested'],
  'en-cours': ['in_progress'],
  faite: ['done'],
  refusee: ['refused'],
  annulee: ['cancelled'],
  toutes: ['requested', 'in_progress', 'done', 'refused', 'cancelled'],
} as const satisfies Record<string, readonly MailRequestStatus[]>
export type RequestStateFilter = keyof typeof requestStateFilters

export const requestStateFilterLabels: Record<RequestStateFilter, string> = {
  'a-traiter': 'À traiter',
  demandee: 'Pas encore prises en charge',
  'en-cours': 'En cours',
  faite: 'Faites',
  refusee: 'Refusées',
  annulee: 'Annulées',
  toutes: 'Toutes',
}

export const requestKindSlugs = {
  ouverture: 'open_and_scan',
  numerisation: 'scan',
  reexpedition: 'forward',
} as const satisfies Record<string, MailRequestKind>
export type RequestKindSlug = keyof typeof requestKindSlugs

export type RequestFilters = {
  state: RequestStateFilter
  statuses: readonly MailRequestStatus[]
  kindSlug?: RequestKindSlug
  kind?: MailRequestKind
  page: number
}

/** Filtres d'une liste de demandes ; `fallback` : l'état montré sans filtre. */
export function readRequestFilters(
  params: SearchParams,
  fallback: RequestStateFilter = 'a-traiter',
): RequestFilters {
  const stateParam = first(params.etat)
  const state = stateParam && stateParam in requestStateFilters ? (stateParam as RequestStateFilter) : fallback
  const kindParam = first(params.nature)
  const kindSlug = kindParam && kindParam in requestKindSlugs ? (kindParam as RequestKindSlug) : undefined
  return {
    state,
    statuses: requestStateFilters[state],
    kindSlug,
    kind: kindSlug ? requestKindSlugs[kindSlug] : undefined,
    page: readPage(params.page),
  }
}

/** Chaîne de requête d'une liste de demandes. */
export function requestFiltersQuery(
  filters: { state?: RequestStateFilter; kindSlug?: RequestKindSlug; clientId?: string },
  page = 1,
): string {
  const query = new URLSearchParams()
  if (filters.state) query.set('etat', filters.state)
  if (filters.kindSlug) query.set('nature', filters.kindSlug)
  if (filters.clientId) query.set('client', filters.clientId)
  if (page > 1) query.set('page', String(page))
  const text = query.toString()
  return text ? `?${text}` : ''
}

/* -------------------------------------------------------------------------- */
/* Suivi d'une demande                                                        */
/* -------------------------------------------------------------------------- */

export type RequestStep = {
  status: MailRequestStatus
  label: string
  at: Date
  /** Qui : une personne de l'entreprise, ou « le centre ». */
  by: string | null
  detail?: string
}

/**
 * Étapes d'une demande, dans l'ordre : déposée, prise en charge, puis faite,
 * refusée ou annulée. Chacune avec sa date — posée par la base — et son auteur.
 */
export function requestSteps(request: {
  requestedAt: Date
  requestedByName: string | null
  startedAt: Date | null
  completedAt: Date | null
  refusedAt: Date | null
  refusalReason: string | null
  cancelledAt: Date | null
  cancelledByName: string | null
}): RequestStep[] {
  const steps: RequestStep[] = [
    { status: 'requested', label: 'Demandée', at: request.requestedAt, by: request.requestedByName },
  ]
  if (request.startedAt) {
    steps.push({ status: 'in_progress', label: 'Prise en charge', at: request.startedAt, by: 'le centre' })
  }
  if (request.completedAt) {
    steps.push({ status: 'done', label: 'Faite', at: request.completedAt, by: 'le centre' })
  }
  if (request.refusedAt) {
    steps.push({
      status: 'refused',
      label: 'Refusée',
      at: request.refusedAt,
      by: 'le centre',
      detail: request.refusalReason ?? undefined,
    })
  }
  if (request.cancelledAt) {
    steps.push({
      status: 'cancelled',
      label: 'Annulée',
      at: request.cancelledAt,
      by: request.cancelledByName ?? 'le centre',
    })
  }
  return steps
}

/* -------------------------------------------------------------------------- */
/* Prix annoncé avant la demande                                              */
/* -------------------------------------------------------------------------- */

export type ActAnnouncement =
  | { source: 'included'; remainingAfter: number }
  | { source: 'subscription' | 'catalogue'; netCents: number; currency: string }
  | { source: 'unpriced' }

const NEXT_ACT = '￿-prochain'

/**
 * Ce que coûtera le prochain acte, annoncé avant que le client ne le demande :
 * la même règle que la facture (`priceActs`, ADR 024), appliquée aux actes
 * déjà faits ce mois-ci puis à celui-ci. Les premiers actes du mois sont
 * inclus dans le forfait du client, les suivants à son prix ; sans forfait,
 * le prix du catalogue ; sans service au catalogue, aucun prix n'est inventé.
 */
export function announceNextAct(
  done: readonly ActOccurrence[],
  subscriptions: readonly ActSubscription[],
  catalogue: ActCatalogueService | null,
  now: { day: string; at: Date },
): ActAnnouncement {
  const priced = priceActs([...done, { id: NEXT_ACT, ...now }], subscriptions, catalogue)
  const next = priced.find((act) => act.actId === NEXT_ACT)
  if (!next || next.source === 'unpriced') return { source: 'unpriced' }
  if (next.source === 'included') {
    const subscription = subscriptions.find((candidate) => candidate.id === next.subscriptionId)
    const used = priced.filter(
      (act) => act.source === 'included' && act.subscriptionId === next.subscriptionId,
    ).length
    return { source: 'included', remainingAfter: Math.max(0, (subscription?.includedQuantity ?? 0) - used) }
  }
  return { source: next.source, netCents: next.netAmountCents ?? 0, currency: next.currency ?? 'EUR' }
}

/** « Incluse dans votre forfait », « 3,50 € HT » : l'annonce, en une phrase. */
export function announcementText(announcement: ActAnnouncement): string {
  switch (announcement.source) {
    case 'included':
      return announcement.remainingAfter > 0
        ? `Inclus dans votre forfait (encore ${announcement.remainingAfter} ce mois-ci ensuite).`
        : 'Inclus dans votre forfait (le dernier de ce mois-ci).'
    case 'subscription':
      return `${formatCents(announcement.netCents, announcement.currency)} HT, au tarif de votre forfait.`
    case 'catalogue':
      return `${formatCents(announcement.netCents, announcement.currency)} HT, au tarif du centre.`
    default:
      return 'Prestation facturée selon le tarif du centre, communiqué sur demande.'
  }
}
