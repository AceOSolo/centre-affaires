import { formatDateTime, formatLongDate, formatTime, toIsoDate } from '../../lib/dates.ts'
import type { OfferRequestStatus } from '../contrats/schema.ts'
import type { MailKind, MailRequestKind, MailRequestStatus } from '../courrier/schema.ts'
import { inspectionKindTitles } from '../etats-des-lieux/labels.ts'
import type { InspectionKind } from '../etats-des-lieux/schema.ts'
import { clientInvoiceState, type ClientInvoiceTone } from '../facturation/compte-regles.ts'
import type { Invoice } from '../facturation/schema-factures.ts'
import { formatCents } from '../facturation/tarifs.ts'
import type { BookingChannel, BookingStatus } from '../reservations/schema.ts'

/**
 * Historique du compte, vu depuis l'espace client (R24) : chaque demande et
 * chaque document des entreprises du compte, du plus récent au plus ancien.
 *
 * Il se lit dans les tables elles-mêmes, qui ne perdent rien : une
 * réservation annulée garde son créneau, sa date et son auteur d'annulation
 * (ADR 036) ; une demande de courrier annulée ou refusée reste une demande,
 * avec chaque transition datée (ADR 037) ; une demande d'offre reste, traitée
 * par un contrat ou écartée (ADR 041) ; un document de contrat ne se réécrit
 * pas (ADR 025) ; une facture émise ne s'efface jamais (ADR 026) ; un état des
 * lieux clos est figé, sa validation par le client aussi (ADR 039).
 *
 * Ce module est pur : il met en forme des lignes déjà lues, pour être éprouvé
 * sans base. La lecture est dans `historique-compte-queries.ts`.
 */

export const historyCategories = ['reservations', 'courrier', 'contrats', 'factures', 'etats-des-lieux'] as const
export type HistoryCategory = (typeof historyCategories)[number]

export const historyCategoryLabels: Record<HistoryCategory, string> = {
  reservations: 'Réservations',
  courrier: 'Courrier',
  contrats: 'Contrats',
  factures: 'Factures',
  'etats-des-lieux': 'États des lieux',
}

export function isHistoryCategory(value: string | undefined): value is HistoryCategory {
  return historyCategories.includes(value as HistoryCategory)
}

/**
 * Où en est ce que l'entrée retrace, pour la pastille :
 * - `waiting` : une demande attend le centre, ou un état des lieux attend la
 *   validation du client ;
 * - `progress` : le centre s'en occupe ;
 * - `done` : faite, confirmée, émise ;
 * - `closed` : annulée, refusée, arrivée à son terme ;
 * - `due` : une facture à régler.
 * Toujours accompagnée de son libellé (jamais l'information par la couleur seule).
 */
export type HistoryTone = 'waiting' | 'progress' | 'done' | 'closed' | 'due'

export type HistoryStep = {
  label: string
  /** Nulle : l'étape est connue, pas sa date (ex. confirmation d'une réservation). */
  at: Date | null
}

export type HistoryEntry = {
  /** Unique sur la page : la catégorie et l'identifiant de la ligne. */
  key: string
  category: HistoryCategory
  /** Date de l'entrée : dépôt de la demande, archivage du document, émission. */
  at: Date
  title: string
  /** Précision : le créneau, le pli, le montant. */
  detail: string | null
  clientId: string
  clientName: string
  outcome: { label: string; tone: HistoryTone }
  /** Chaque étape datée, dans l'ordre où elle est arrivée. */
  steps: HistoryStep[]
  /** Motif d'une annulation ou d'un refus, numéro de suivi : tels que saisis. */
  notes: string[]
  link: { href: string; label: string } | null
}

/* -------------------------------------------------------------------------- */
/* Réservations                                                               */
/* -------------------------------------------------------------------------- */

export type HistoryBookingRow = {
  id: string
  clientId: string
  clientName: string
  resourceName: string
  title: string
  status: BookingStatus
  channel: BookingChannel
  createdAt: Date
  startsAt: Date
  endsAt: Date
  /** La personne de l'entreprise qui l'a faite depuis son espace (ADR 036) ; nulle sinon. */
  bookedByName: string | null
  /**
   * Confirmation, datée par la base (ADR 041) ; nulle pour une réservation
   * en attente, ou confirmée avant que la base ne la date.
   */
  confirmedAt: Date | null
  /** Confirmée par un membre de l'équipe : une demande acceptée par l'accueil. */
  confirmedByStaff: boolean
  cancelledAt: Date | null
  cancellationReason: string | null
  /** La personne de l'entreprise qui l'a annulée ; nulle sinon. */
  cancelledByMemberName: string | null
  /** Annulée par un membre de l'équipe. */
  cancelledByStaff: boolean
}

/** Motif posé par l'annulation depuis l'espace client : l'étape le dit déjà. */
const CLIENT_CANCELLATION_REASON = 'Annulée par le client'

function slotLabel(startsAt: Date, endsAt: Date, timeZone: string): string {
  const firstDay = toIsoDate(startsAt, timeZone)
  const lastDay = toIsoDate(new Date(endsAt.getTime() - 1), timeZone)
  if (firstDay === lastDay) {
    return `${formatLongDate(firstDay, timeZone)}, ${formatTime(startsAt, timeZone)} – ${formatTime(endsAt, timeZone)}`
  }
  return `du ${formatDateTime(startsAt, timeZone)} au ${formatDateTime(endsAt, timeZone)}`
}

export function bookingHistoryEntry(row: HistoryBookingRow, timeZone: string): HistoryEntry {
  const fromSpace = row.bookedByName !== null
  const requested: HistoryStep = fromSpace
    ? { label: `Demandée depuis l’espace client par ${row.bookedByName}`, at: row.createdAt }
    : row.channel === 'staff'
      ? { label: 'Enregistrée par le centre', at: row.createdAt }
      : { label: 'Demandée depuis le site', at: row.createdAt }

  const steps: HistoryStep[] = [requested]
  const notes: string[] = []
  // Une demande (site ou espace client) a une étape de confirmation ; une
  // réservation saisie par le centre est ferme dès son enregistrement. Sans
  // date pour une confirmation antérieure à la migration 0044.
  const confirmation: HistoryStep = {
    label: row.confirmedByStaff
      ? 'Confirmée par le centre'
      : fromSpace && row.confirmedAt
        ? 'Confirmée immédiatement'
        : 'Confirmée',
    at: row.confirmedAt,
  }
  let outcome: HistoryEntry['outcome']
  if (row.status === 'pending') {
    outcome = { label: 'En attente de validation', tone: 'waiting' }
  } else if (row.status === 'confirmed') {
    outcome = { label: 'Confirmée', tone: 'done' }
    if (row.channel !== 'staff') steps.push(confirmation)
  } else {
    // Confirmée puis annulée : les deux étapes restent.
    if (row.channel !== 'staff' && row.confirmedAt) steps.push(confirmation)
    const by = row.cancelledByMemberName
      ? ` par ${row.cancelledByMemberName}`
      : row.cancelledByStaff
        ? ' par le centre'
        : ''
    outcome = { label: 'Annulée', tone: 'closed' }
    steps.push({ label: `Annulée${by}`, at: row.cancelledAt })
    if (row.cancellationReason && row.cancellationReason !== CLIENT_CANCELLATION_REASON) {
      notes.push(`Motif : ${row.cancellationReason}`)
    }
  }

  return {
    key: `reservations:${row.id}`,
    category: 'reservations',
    at: row.createdAt,
    title: `Réservation — ${row.resourceName}`,
    detail: `${slotLabel(row.startsAt, row.endsAt, timeZone)} · ${row.title}`,
    clientId: row.clientId,
    clientName: row.clientName,
    outcome,
    steps,
    notes,
    link: null,
  }
}

/* -------------------------------------------------------------------------- */
/* Demandes de courrier                                                       */
/* -------------------------------------------------------------------------- */

export type HistoryMailRequestRow = {
  id: string
  clientId: string
  clientName: string
  kind: MailRequestKind
  status: MailRequestStatus
  mailKind: MailKind
  /** Expéditeur du pli ; nul s'il n'est pas précisé ou a été anonymisé. */
  sender: string | null
  /**
   * Pli retiré par le centre (attribué au mauvais client, ADR 015) : la
   * demande reste, refusée, mais l'expéditeur n'est plus montré — le pli
   * n'était peut-être pas celui de l'entreprise.
   */
  mailItemRemoved: boolean
  receivedAt: Date
  requestedAt: Date
  /** Personne de l'entreprise qui l'a déposée ; nulle : l'accueil, sur consigne. */
  requestedByMemberName: string | null
  startedAt: Date | null
  completedAt: Date | null
  refusedAt: Date | null
  refusalReason: string | null
  cancelledAt: Date | null
  cancelledByMemberName: string | null
  cancelledByStaff: boolean
  forwardTrackingNumber: string | null
}

export const mailRequestHistoryTitles: Record<MailRequestKind, string> = {
  open_and_scan: 'Demande d’ouverture et de numérisation',
  scan: 'Demande de numérisation',
  forward: 'Demande de réexpédition',
}

const mailKindNouns: Record<MailKind, string> = {
  lettre: 'Lettre',
  recommande: 'Recommandé',
  colis: 'Colis',
  autre: 'Pli',
}

const mailRequestOutcomes: Record<MailRequestStatus, HistoryEntry['outcome']> = {
  requested: { label: 'Déposée', tone: 'waiting' },
  in_progress: { label: 'En cours', tone: 'progress' },
  done: { label: 'Faite', tone: 'done' },
  refused: { label: 'Refusée', tone: 'closed' },
  cancelled: { label: 'Annulée', tone: 'closed' },
}

const mailRequestDoneLabels: Record<MailRequestKind, string> = {
  open_and_scan: 'Pli ouvert et numérisé',
  scan: 'Numérisation faite',
  forward: 'Pli réexpédié',
}

export function mailRequestHistoryEntry(row: HistoryMailRequestRow, timeZone: string): HistoryEntry {
  const steps: HistoryStep[] = [
    {
      label: row.requestedByMemberName
        ? `Déposée par ${row.requestedByMemberName}`
        : 'Déposée par l’accueil, à votre demande',
      at: row.requestedAt,
    },
  ]
  const notes: string[] = []
  if (row.startedAt) steps.push({ label: 'Prise en charge par le centre', at: row.startedAt })
  if (row.completedAt) steps.push({ label: mailRequestDoneLabels[row.kind], at: row.completedAt })
  if (row.refusedAt) {
    steps.push({ label: 'Refusée par le centre', at: row.refusedAt })
    if (row.refusalReason) notes.push(`Motif : ${row.refusalReason}`)
  }
  if (row.cancelledAt) {
    const by = row.cancelledByMemberName
      ? ` par ${row.cancelledByMemberName}`
      : row.cancelledByStaff
        ? ' par l’accueil'
        : ''
    steps.push({ label: `Annulée${by}`, at: row.cancelledAt })
  }
  if (row.forwardTrackingNumber) notes.push(`Numéro de suivi : ${row.forwardTrackingNumber}`)

  return {
    key: `courrier:${row.id}`,
    category: 'courrier',
    at: row.requestedAt,
    title: mailRequestHistoryTitles[row.kind],
    detail: row.mailItemRemoved
      ? `${mailKindNouns[row.mailKind]} reçu le ${formatDateTime(row.receivedAt, timeZone)}, retiré par le centre`
      : `${mailKindNouns[row.mailKind]} de ${row.sender ?? 'expéditeur non précisé'}, reçu le ${formatDateTime(row.receivedAt, timeZone)}`,
    clientId: row.clientId,
    clientName: row.clientName,
    outcome: mailRequestOutcomes[row.status],
    steps,
    notes,
    link: row.mailItemRemoved ? null : { href: '/compte/courrier', label: 'Voir le courrier' },
  }
}

/* -------------------------------------------------------------------------- */
/* Documents de contrat                                                       */
/* -------------------------------------------------------------------------- */

export type HistoryContractDocumentRow = {
  contractId: string
  clientId: string
  clientName: string
  reference: string
  version: number
  /** Nul : le contrat initial. */
  amendmentNumber: number | null
  createdAt: Date
}

export function contractDocumentHistoryEntry(row: HistoryContractDocumentRow): HistoryEntry {
  const title =
    row.amendmentNumber === null
      ? `Contrat ${row.reference}`
      : `Avenant n° ${row.amendmentNumber} au contrat ${row.reference}`
  return {
    key: `contrats:${row.contractId}:${row.version}`,
    category: 'contrats',
    at: row.createdAt,
    title,
    detail: `Document version ${row.version}`,
    clientId: row.clientId,
    clientName: row.clientName,
    outcome: { label: 'Document archivé', tone: 'done' },
    steps: [{ label: 'Établi et archivé par le centre', at: row.createdAt }],
    notes: [],
    link: {
      href: `/compte/contrats/${row.contractId}/document?version=${row.version}`,
      label: 'Voir le document',
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Demandes d'offre                                                           */
/* -------------------------------------------------------------------------- */

/** Une offre groupée demandée depuis l'espace client (R23, ADR 041). */
export type HistoryOfferRequestRow = {
  id: string
  clientId: string
  clientName: string
  offerName: string
  status: OfferRequestStatus
  requestedAt: Date
  /** La personne de l'entreprise qui l'a déposée. */
  requestedByName: string | null
  /** Contrat établi, ou demande écartée : date posée par la base. */
  closedAt: Date | null
  /** Référence du contrat tiré de l'offre, quand l'entreprise peut le voir. */
  contractReference: string | null
  /** Motif d'une demande écartée, tel que l'accueil l'a saisi. */
  dismissalReason: string | null
}

export function offerRequestHistoryEntry(row: HistoryOfferRequestRow): HistoryEntry {
  const steps: HistoryStep[] = [
    {
      label: row.requestedByName
        ? `Demandée depuis l’espace client par ${row.requestedByName}`
        : 'Demandée depuis l’espace client',
      at: row.requestedAt,
    },
  ]
  const notes: string[] = []
  let outcome: HistoryEntry['outcome']
  if (row.status === 'contracted') {
    outcome = { label: 'Contrat préparé', tone: 'done' }
    steps.push({
      label: row.contractReference
        ? `Contrat ${row.contractReference} préparé par le centre`
        : 'Contrat préparé par le centre',
      at: row.closedAt,
    })
  } else if (row.status === 'dismissed') {
    outcome = { label: 'Écartée', tone: 'closed' }
    steps.push({ label: 'Écartée par le centre', at: row.closedAt })
    if (row.dismissalReason) notes.push(`Motif : ${row.dismissalReason}`)
  } else {
    outcome = { label: 'Transmise à l’accueil', tone: 'waiting' }
  }
  return {
    key: `contrats:offre:${row.id}`,
    category: 'contrats',
    at: row.requestedAt,
    title: `Demande d’offre — ${row.offerName}`,
    detail: null,
    clientId: row.clientId,
    clientName: row.clientName,
    outcome,
    steps,
    notes,
    link: { href: '/compte/offres', label: 'Voir les offres' },
  }
}

/* -------------------------------------------------------------------------- */
/* Factures et avoirs                                                         */
/* -------------------------------------------------------------------------- */

export type HistoryInvoiceRow = Pick<
  Invoice,
  | 'id'
  | 'kind'
  | 'number'
  | 'status'
  | 'clientId'
  | 'currency'
  | 'totalInclTaxCents'
  | 'paidCents'
  | 'creditedCents'
  | 'dueDate'
> & {
  clientName: string
  /** Instant d'émission ; une facture reprise sans instant prend sa date de création. */
  issuedAt: Date
}

const invoiceToneToHistory: Record<ClientInvoiceTone, HistoryTone> = {
  due: 'due',
  overdue: 'due',
  partial: 'due',
  settled: 'done',
  cancelled: 'closed',
  credit: 'done',
}

export function invoiceHistoryEntry(row: HistoryInvoiceRow, today: string): HistoryEntry {
  const state = clientInvoiceState(row, today)
  const noun = row.kind === 'credit_note' ? 'Avoir' : 'Facture'
  return {
    key: `factures:${row.id}`,
    category: 'factures',
    at: row.issuedAt,
    title: `${noun} ${row.number ?? ''}`.trim(),
    detail: `${formatCents(row.totalInclTaxCents, row.currency)} TTC`,
    clientId: row.clientId,
    clientName: row.clientName,
    outcome: { label: state.label, tone: invoiceToneToHistory[state.tone] },
    steps: [{ label: row.kind === 'credit_note' ? 'Émis' : 'Émise', at: row.issuedAt }],
    notes:
      state.amountDueCents > 0
        ? [`Reste à régler : ${formatCents(state.amountDueCents, row.currency)}`]
        : [],
    link: { href: `/compte/factures/${row.id}`, label: `Voir ${noun === 'Avoir' ? 'l’avoir' : 'la facture'}` },
  }
}

/* -------------------------------------------------------------------------- */
/* États des lieux                                                            */
/* -------------------------------------------------------------------------- */

/** Un état des lieux clos d'une entreprise du compte : seuls les clos lui sont montrés (ADR 039). */
export type HistoryInspectionRow = {
  id: string
  clientId: string
  clientName: string
  kind: InspectionKind
  resourceName: string
  /** Date de l'état des lieux, sur place. */
  performedAt: Date
  /** Clôture par le centre : l'état des lieux est alors montré au client. */
  closedAt: Date | null
  signedAt: Date | null
  /** La personne de l'entreprise qui l'a validé. */
  signedByName: string | null
  /** Des réserves ont été saisies à la validation ; leur texte se lit sur l'état des lieux. */
  hasRemarks: boolean
}

export function inspectionHistoryEntry(row: HistoryInspectionRow, timeZone: string): HistoryEntry {
  const closedAt = row.closedAt ?? row.performedAt
  const steps: HistoryStep[] = [{ label: 'Établi et clos par le centre', at: closedAt }]
  if (row.signedAt) {
    steps.push({
      label: row.signedByName ? `Validé par ${row.signedByName}` : 'Validé depuis l’espace client',
      at: row.signedAt,
    })
  }
  return {
    key: `etats-des-lieux:${row.id}`,
    category: 'etats-des-lieux',
    at: closedAt,
    title: `${inspectionKindTitles[row.kind]} — ${row.resourceName}`,
    detail: `Fait le ${formatDateTime(row.performedAt, timeZone)}`,
    clientId: row.clientId,
    clientName: row.clientName,
    outcome: row.signedAt ? { label: 'Validé', tone: 'done' } : { label: 'À valider', tone: 'waiting' },
    steps,
    notes: row.hasRemarks ? ['Réserves ajoutées à la validation'] : [],
    link: { href: `/compte/etats-des-lieux/${row.id}`, label: 'Voir l’état des lieux' },
  }
}

/* -------------------------------------------------------------------------- */
/* Assemblage                                                                 */
/* -------------------------------------------------------------------------- */

export type AccountHistorySources = {
  bookings: readonly HistoryBookingRow[]
  mailRequests: readonly HistoryMailRequestRow[]
  contractDocuments: readonly HistoryContractDocumentRow[]
  /** Offres demandées : rangées avec les contrats, qu'elles précèdent. */
  offerRequests: readonly HistoryOfferRequestRow[]
  invoices: readonly HistoryInvoiceRow[]
  inspections: readonly HistoryInspectionRow[]
}

/**
 * Toutes les entrées, de la plus récente à la plus ancienne. À instant égal,
 * l'ordre reste stable (par clé) : deux chargements de la page montrent la
 * même suite.
 */
export function buildAccountHistory(
  sources: AccountHistorySources,
  options: { timeZone: string; today: string },
): HistoryEntry[] {
  const entries = [
    ...sources.bookings.map((row) => bookingHistoryEntry(row, options.timeZone)),
    ...sources.mailRequests.map((row) => mailRequestHistoryEntry(row, options.timeZone)),
    ...sources.contractDocuments.map(contractDocumentHistoryEntry),
    ...sources.offerRequests.map(offerRequestHistoryEntry),
    ...sources.invoices.map((row) => invoiceHistoryEntry(row, options.today)),
    ...sources.inspections.map((row) => inspectionHistoryEntry(row, options.timeZone)),
  ]
  return entries.sort(
    (a, b) => b.at.getTime() - a.at.getTime() || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  )
}

/**
 * Entrées regroupées par mois du centre (« octobre 2026 »), dans l'ordre de la
 * liste : l'historique se parcourt comme un relevé.
 */
export function groupHistoryByMonth(
  entries: readonly HistoryEntry[],
  timeZone: string,
): { month: string; entries: HistoryEntry[] }[] {
  const groups: { month: string; entries: HistoryEntry[] }[] = []
  for (const entry of entries) {
    const month = toIsoDate(entry.at, timeZone).slice(0, 7)
    const last = groups.at(-1)
    if (last && last.month === month) last.entries.push(entry)
    else groups.push({ month, entries: [entry] })
  }
  return groups
}
