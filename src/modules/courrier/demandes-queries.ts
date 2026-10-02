import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, or, sql, type SQL } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'

import {
  PG_CHECK_VIOLATION,
  PG_FOREIGN_KEY_VIOLATION,
  PG_MAIL_REQUEST_REFUSED,
  PG_UNIQUE_VIOLATION,
  pgConstraintName,
  pgErrorCode,
} from '../../db/errors.ts'
import { withTenant, type Transaction } from '../../db/index.ts'
import { tenants } from '../../db/tenants.ts'
import { dayRangeUtc, monthRangeUtc, toIsoDate, todayIsoDate } from '../../lib/dates.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { isUuid } from '../../lib/uuid.ts'
import { clients } from '../clients/schema.ts'
import { inClientSpace, type ClientAccount } from '../clients/comptes.ts'
import { subscribedServices } from '../facturation/schema-factures.ts'
import { serviceCodes, services } from '../facturation/schema.ts'
import type { ActOccurrence, ActSubscription } from '../facturation/souscriptions-regles.ts'
import {
  announceNextAct,
  pendingRequestStatuses,
  sameForwardAddress,
  type ActAnnouncement,
  type ClientMailFilters,
  type ForwardAddress,
} from './demandes-regles.ts'
import type { ScanFile } from './fichiers.ts'
import { discard, scanRows, store, type StoredScan } from './queries.ts'
import {
  mailItems,
  mailRequests,
  mailScans,
  type MailKind,
  type MailRequestKind,
  type MailRequestStatus,
  type MailStatus,
} from './schema.ts'

/**
 * Demandes sur un pli (R21, R24, ADR 037) : celles que le client dépose et
 * suit depuis son espace, celles que l'accueil traite.
 *
 * Côté client, tout passe par `inClientSpace` (ADR 019) en plus des filtres
 * sur `client_id` : la portée de la transaction tiendrait sans eux. Côté
 * centre, `withTenant`, après `requirePermission('courrier.gerer')` dans
 * l'action ou la page.
 *
 * La base tient les transitions, leurs dates et leurs auteurs
 * (`mail_requests_guard`, CA008), et l'unicité d'une demande en cours par pli
 * et par nature (`mail_requests_pending_key`). Chaque écriture rejoue l'état
 * attendu dans son `where` : deux clics, deux collègues, une transition.
 */

/* -------------------------------------------------------------------------- */
/* Refus de la base                                                           */
/* -------------------------------------------------------------------------- */

/** Le message français d'une garde de la base (CA008), tel qu'elle l'a écrit. */
function databaseMessage(error: unknown, code: string): string | undefined {
  for (let cause: unknown = error, depth = 0; cause && depth < 10; depth++) {
    const { code: causeCode, message } = cause as { code?: unknown; message?: unknown }
    if (causeCode === code && typeof message === 'string') return message
    cause = (cause as { cause?: unknown }).cause
  }
  return undefined
}

const constraintMessages: Record<string, string> = {
  mail_requests_pending_key: 'Une demande de cette nature est déjà en cours pour ce courrier.',
  mail_requests_forward_address: 'L’adresse de réexpédition est incomplète.',
  mail_requests_postage_valid: 'Les frais d’affranchissement ne se notent que sur une réexpédition faite.',
  mail_requests_status_consistent: 'Un refus porte toujours son motif.',
  mail_requests_mail_item_fk: 'Ce courrier n’est pas adressé à cette entreprise.',
  mail_requests_requested_by_member_fk: 'Cette personne ne relève pas de l’entreprise destinataire.',
  mail_requests_cancelled_by_member_fk: 'Cette personne ne relève pas de l’entreprise destinataire.',
}

/**
 * Refus de la base, dit à l'écran ; `undefined` pour une panne, qui doit
 * remonter. Les gardes (CA008) écrivent leur message en français, repris tel
 * quel ; les contraintes, par leur nom.
 */
export function mailRequestRefusal(error: unknown): string | undefined {
  const code = pgErrorCode(error)
  const constraint = pgConstraintName(error)
  if (constraint && constraintMessages[constraint]) return constraintMessages[constraint]
  if (code === PG_MAIL_REQUEST_REFUSED) {
    return databaseMessage(error, code) ?? 'Le centre ne peut pas enregistrer cette demande dans l’état actuel du courrier.'
  }
  if (code === PG_UNIQUE_VIOLATION) return 'Une demande de cette nature est déjà en cours pour ce courrier.'
  if (code === PG_CHECK_VIOLATION) return 'La demande est incomplète.'
  if (code === PG_FOREIGN_KEY_VIOLATION) return 'Ce courrier n’est pas adressé à cette entreprise.'
  return undefined
}

/** Refus métier, côté centre : la demande a changé d'état entre-temps, ou la base l'a refusé. */
export class MailRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MailRequestError'
  }
}

async function refusing<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    const message = mailRequestRefusal(error)
    if (message) throw new MailRequestError(message)
    throw error
  }
}

/* -------------------------------------------------------------------------- */
/* Fragments de requête                                                       */
/* -------------------------------------------------------------------------- */

const pending = sql.raw(`('requested', 'in_progress')`)

/** Nom affiché d'une personne de l'entreprise. */
const memberName = (column: AnyPgColumn) =>
  sql<string | null>`(select coalesce(m.full_name, m.email) from client_members as m where m.id = ${column})`

/** Nom affiché d'un membre de l'équipe. */
const staffName = (column: AnyPgColumn) =>
  sql<string | null>`(select coalesce(s.full_name, s.email) from staff_members as s where s.id = ${column})`

/** Une réexpédition faite : le pli a quitté le centre. */
const forwardedAt = () =>
  sql<Date | null>`(
    select max(r.completed_at) from mail_requests as r
     where r.tenant_id = ${mailItems.tenantId} and r.mail_item_id = ${mailItems.id}
       and r.kind = 'forward' and r.status = 'done')`.mapWith(mailRequests.completedAt)

/** « id:kind:status,… » : les demandes en cours du pli, en une colonne. */
const pendingRequests = () =>
  sql<string | null>`(
    select string_agg(r.id::text || ':' || r.kind::text || ':' || r.status::text, ',' order by r.kind)
      from mail_requests as r
     where r.tenant_id = ${mailItems.tenantId} and r.mail_item_id = ${mailItems.id}
       and r.status in ${pending})`

const latestScan = (side: 'envelope' | 'content', column: 'id' | 'content_type') =>
  sql<string | null>`(
    select s.${sql.raw(column)} from mail_scans as s
     where s.tenant_id = ${mailItems.tenantId} and s.mail_item_id = ${mailItems.id}
       and s.side = ${side} and s.deleted_at is null
     order by s.created_at desc limit 1)`

const contentScanCount = () =>
  sql<number>`(
    select count(*)::int from mail_scans as s
     where s.tenant_id = ${mailItems.tenantId} and s.mail_item_id = ${mailItems.id}
       and s.side = 'content' and s.deleted_at is null)`

const splitPending = (value: string | null): ClientMailCard['pendingRequests'] =>
  value
    ? value.split(',').map((entry) => {
        const [id, kind, status] = entry.split(':')
        return { id, kind: kind as MailRequestKind, status: status as MailRequestStatus }
      })
    : []

/* -------------------------------------------------------------------------- */
/* Espace client : la boîte aux lettres                                       */
/* -------------------------------------------------------------------------- */

export type ClientMailCard = {
  id: string
  kind: MailKind
  sender: string | null
  receivedAt: Date
  note: string | null
  status: MailStatus
  openingRequestedAt: Date | null
  openedAt: Date | null
  clientId: string
  clientName: string
  envelopeScanId: string | null
  envelopeContentType: string | null
  /** Le contenu le plus récent : un pli peut en porter un par numérisation demandée. */
  contentScanId: string | null
  contentScanCount: number
  forwardedAt: Date | null
  /** Demandes en cours sur le pli, une au plus par nature. */
  pendingRequests: { id: string; kind: MailRequestKind; status: MailRequestStatus }[]
  pendingKinds: MailRequestKind[]
}

const cardColumns = {
  id: mailItems.id,
  kind: mailItems.kind,
  sender: mailItems.sender,
  receivedAt: mailItems.receivedAt,
  note: mailItems.note,
  status: mailItems.status,
  openingRequestedAt: mailItems.openingRequestedAt,
  openedAt: mailItems.openedAt,
  clientId: mailItems.clientId,
  clientName: clients.name,
}

function cardSelection() {
  return {
    ...cardColumns,
    envelopeScanId: latestScan('envelope', 'id'),
    envelopeContentType: latestScan('envelope', 'content_type'),
    contentScanId: latestScan('content', 'id'),
    contentScanCount: contentScanCount(),
    forwardedAt: forwardedAt(),
    pendingRequests: pendingRequests(),
  }
}

type CardRow = Omit<ClientMailCard, 'pendingRequests' | 'pendingKinds' | 'contentScanCount'> & {
  pendingRequests: string | null
  contentScanCount: number
}

const toCard = (row: CardRow): ClientMailCard => {
  const requests = splitPending(row.pendingRequests)
  return {
    ...row,
    contentScanCount: Number(row.contentScanCount),
    pendingRequests: requests,
    pendingKinds: requests.map((request) => request.kind),
  }
}

/** Conditions des filtres de la boîte aux lettres ; période en jours du centre. */
function mailFilterWhere(
  clientIds: string[],
  filters: ClientMailFilters,
  timeZone: string,
): SQL | undefined {
  const forwarded = sql`exists (
    select 1 from mail_requests as r
     where r.tenant_id = ${mailItems.tenantId} and r.mail_item_id = ${mailItems.id}
       and r.kind = 'forward' and r.status = 'done')`
  const state = {
    'non-ouvert': and(isNull(mailItems.openedAt), sql`not ${forwarded}`),
    numerise: isNotNull(mailItems.openedAt),
    'demande-en-cours': sql`exists (
      select 1 from mail_requests as r
       where r.tenant_id = ${mailItems.tenantId} and r.mail_item_id = ${mailItems.id}
         and r.status in ${pending})`,
    reexpedie: forwarded,
  } as const
  return and(
    inArray(mailItems.clientId, clientIds),
    isNull(mailItems.deletedAt),
    filters.kind ? eq(mailItems.kind, filters.kind) : undefined,
    filters.from ? gte(mailItems.receivedAt, dayRangeUtc(filters.from, timeZone).startsAt) : undefined,
    filters.to ? lt(mailItems.receivedAt, dayRangeUtc(filters.to, timeZone).endsAt) : undefined,
    filters.state ? state[filters.state] : undefined,
  )
}

/**
 * Boîte aux lettres paginée et filtrée (R21) : type de pli, période de
 * réception, état. Remplace la limite fixe de 200 plis : l'historique entier
 * reste accessible, page par page.
 */
export async function searchMailForAccounts(
  accounts: ClientAccount[],
  filters: ClientMailFilters,
  page: { number: number; size: number },
  timeZone: string,
): Promise<{ rows: ClientMailCard[]; total: number }> {
  if (accounts.length === 0) return { rows: [], total: 0 }
  const where = mailFilterWhere(
    accounts.map((account) => account.clientId),
    filters,
    timeZone,
  )
  return inClientSpace(accounts, async (tx) => {
    const [counted] = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(mailItems)
      .where(where)
    const rows = await tx
      .select(cardSelection())
      .from(mailItems)
      .innerJoin(clients, eq(clients.id, mailItems.clientId))
      .where(where)
      .orderBy(desc(mailItems.receivedAt), desc(mailItems.id))
      .limit(page.size)
      .offset((page.number - 1) * page.size)
    return { rows: rows.map(toCard), total: Number(counted?.total ?? 0) }
  })
}

export type ClientMailScan = {
  id: string
  side: 'envelope' | 'content'
  contentType: string
  createdAt: Date
  mailRequestId: string | null
}

export type ClientMailDetail = ClientMailCard & {
  /** Toutes les numérisations encore conservées : l'historique numérisé du pli. */
  scans: ClientMailScan[]
  requests: MailRequestRow[]
}

/** Un pli de l'entreprise, ses numérisations et ses demandes ; `undefined` s'il n'est pas à elle. */
export async function findMailForAccounts(
  id: string,
  accounts: ClientAccount[],
): Promise<ClientMailDetail | undefined> {
  if (accounts.length === 0 || !isUuid(id)) return undefined
  const clientIds = accounts.map((account) => account.clientId)
  return inClientSpace(accounts, async (tx) => {
    const [row] = await tx
      .select(cardSelection())
      .from(mailItems)
      .innerJoin(clients, eq(clients.id, mailItems.clientId))
      .where(and(eq(mailItems.id, id), inArray(mailItems.clientId, clientIds), isNull(mailItems.deletedAt)))
      .limit(1)
    if (!row) return undefined
    const scans = await tx
      .select({
        id: mailScans.id,
        side: mailScans.side,
        contentType: mailScans.contentType,
        createdAt: mailScans.createdAt,
        mailRequestId: mailScans.mailRequestId,
      })
      .from(mailScans)
      .where(and(eq(mailScans.mailItemId, id), isNull(mailScans.deletedAt)))
      .orderBy(asc(mailScans.side), asc(mailScans.createdAt))
    const requests = await selectRequests(tx, and(eq(mailRequests.mailItemId, id)), {
      order: 'asc',
      staff: false,
    })
    return { ...toCard(row), scans, requests }
  })
}

/* -------------------------------------------------------------------------- */
/* Demandes : lecture commune                                                 */
/* -------------------------------------------------------------------------- */

export type MailRequestRow = {
  id: string
  kind: MailRequestKind
  status: MailRequestStatus
  requestedAt: Date
  /** Personne de l'entreprise, ou membre de l'équipe pour une consigne par téléphone. */
  requestedByName: string | null
  requestedByStaff: boolean
  clientNote: string | null
  startedAt: Date | null
  completedAt: Date | null
  refusedAt: Date | null
  refusalReason: string | null
  cancelledAt: Date | null
  /** Nul pour une annulation par le centre. */
  cancelledByName: string | null
  forwardAddress: ForwardAddress | null
  forwardTrackingNumber: string | null
  postageCents: number | null
  postageCurrency: string | null
  /** Contenu numérisé produit par la demande, s'il est encore conservé. */
  contentScanId: string | null
  mailItemId: string
  mailKind: MailKind
  mailSender: string | null
  mailReceivedAt: Date
  clientId: string
  clientName: string
}

/** Vu du centre : les auteurs de chaque étape, et ce qui conditionne le traitement. */
export type StaffMailRequestRow = MailRequestRow & {
  startedByName: string | null
  completedByName: string | null
  /** Nul pour un refus posé par la base (pli retiré). */
  refusedByName: string | null
  mailOpenedAt: Date | null
  mailDeletedAt: Date | null
  /** Autres demandes en cours sur le même pli. */
  otherPending: number
  /** Une ligne de facture vivante tient la demande. */
  billed: boolean
}

function requestSelection(staff: boolean) {
  const base = {
    id: mailRequests.id,
    kind: mailRequests.kind,
    status: mailRequests.status,
    requestedAt: mailRequests.requestedAt,
    requestedByMemberName: memberName(mailRequests.requestedByMemberId),
    requestedByStaffId: mailRequests.requestedByStaffId,
    clientNote: mailRequests.clientNote,
    startedAt: mailRequests.startedAt,
    completedAt: mailRequests.completedAt,
    refusedAt: mailRequests.refusedAt,
    refusalReason: mailRequests.refusalReason,
    cancelledAt: mailRequests.cancelledAt,
    cancelledByMemberName: memberName(mailRequests.cancelledByMemberId),
    forwardRecipient: mailRequests.forwardRecipient,
    forwardAddressLine1: mailRequests.forwardAddressLine1,
    forwardAddressLine2: mailRequests.forwardAddressLine2,
    forwardPostalCode: mailRequests.forwardPostalCode,
    forwardCity: mailRequests.forwardCity,
    forwardCountry: mailRequests.forwardCountry,
    forwardTrackingNumber: mailRequests.forwardTrackingNumber,
    postageCents: mailRequests.postageCents,
    postageCurrency: mailRequests.postageCurrency,
    contentScanId: sql<string | null>`(
      select s.id from mail_scans as s
       where s.tenant_id = ${mailRequests.tenantId} and s.mail_request_id = ${mailRequests.id}
         and s.deleted_at is null
       order by s.created_at desc limit 1)`,
    mailItemId: mailRequests.mailItemId,
    mailKind: mailItems.kind,
    mailSender: mailItems.sender,
    mailReceivedAt: mailItems.receivedAt,
    clientId: mailRequests.clientId,
    clientName: clients.name,
  }
  if (!staff) return base
  return {
    ...base,
    requestedByStaffName: staffName(mailRequests.requestedByStaffId),
    cancelledByStaffName: staffName(mailRequests.cancelledByStaffId),
    startedByName: staffName(mailRequests.startedByStaffId),
    completedByName: staffName(mailRequests.completedByStaffId),
    refusedByName: staffName(mailRequests.refusedByStaffId),
    mailOpenedAt: mailItems.openedAt,
    mailDeletedAt: mailItems.deletedAt,
    otherPending: sql<number>`(
      select count(*)::int from mail_requests as o
       where o.tenant_id = ${mailRequests.tenantId} and o.mail_item_id = ${mailRequests.mailItemId}
         and o.id <> ${mailRequests.id} and o.status in ${pending})`,
    billed: sql<boolean>`exists (
      select 1 from invoice_lines as l
       where l.tenant_id = ${mailRequests.tenantId} and l.mail_request_id = ${mailRequests.id}
         and l.deleted_at is null and l.released_at is null)`,
  }
}

/** Ligne brute de `requestSelection`, lue champ à champ par les deux vues. */
type RawRequest = Record<string, unknown>

function toRequestRow(row: RawRequest): MailRequestRow {
  const address: ForwardAddress | null =
    row.kind === 'forward' && row.forwardRecipient
      ? {
          recipient: row.forwardRecipient as string,
          line1: row.forwardAddressLine1 as string,
          line2: (row.forwardAddressLine2 as string | null) ?? null,
          postalCode: row.forwardPostalCode as string,
          city: row.forwardCity as string,
          country: row.forwardCountry as string,
        }
      : null
  const requestedByStaff = row.requestedByStaffId !== null
  return {
    id: row.id as string,
    kind: row.kind as MailRequestKind,
    status: row.status as MailRequestStatus,
    requestedAt: row.requestedAt as Date,
    requestedByName: requestedByStaff
      ? ((row.requestedByStaffName as string | null | undefined) ?? 'le centre')
      : ((row.requestedByMemberName as string | null) ?? null),
    requestedByStaff,
    clientNote: row.clientNote as string | null,
    startedAt: row.startedAt as Date | null,
    completedAt: row.completedAt as Date | null,
    refusedAt: row.refusedAt as Date | null,
    refusalReason: row.refusalReason as string | null,
    cancelledAt: row.cancelledAt as Date | null,
    cancelledByName: (row.cancelledByMemberName as string | null) ?? null,
    forwardAddress: address,
    forwardTrackingNumber: row.forwardTrackingNumber as string | null,
    postageCents: row.postageCents as number | null,
    postageCurrency: row.postageCurrency as string | null,
    contentScanId: row.contentScanId as string | null,
    mailItemId: row.mailItemId as string,
    mailKind: row.mailKind as MailKind,
    mailSender: row.mailSender as string | null,
    mailReceivedAt: row.mailReceivedAt as Date,
    clientId: row.clientId as string,
    clientName: row.clientName as string,
  }
}

function toStaffRequestRow(row: RawRequest): StaffMailRequestRow {
  return {
    ...toRequestRow(row),
    cancelledByName:
      (row.cancelledByMemberName as string | null) ?? (row.cancelledByStaffName as string | null) ?? null,
    startedByName: row.startedByName as string | null,
    completedByName: row.completedByName as string | null,
    refusedByName: row.refusedByName as string | null,
    mailOpenedAt: row.mailOpenedAt as Date | null,
    mailDeletedAt: row.mailDeletedAt as Date | null,
    otherPending: Number(row.otherPending ?? 0),
    billed: Boolean(row.billed),
  }
}

async function selectRequests(
  tx: Transaction,
  where: SQL | undefined,
  options: { order: 'asc' | 'desc'; staff: false; limit?: number; offset?: number },
): Promise<MailRequestRow[]>
async function selectRequests(
  tx: Transaction,
  where: SQL | undefined,
  options: { order: 'asc' | 'desc'; staff: true; limit?: number; offset?: number },
): Promise<StaffMailRequestRow[]>
async function selectRequests(
  tx: Transaction,
  where: SQL | undefined,
  options: { order: 'asc' | 'desc'; staff: boolean; limit?: number; offset?: number },
): Promise<MailRequestRow[] | StaffMailRequestRow[]> {
  const order = options.order === 'asc' ? asc : desc
  let query = tx
    .select(requestSelection(options.staff))
    .from(mailRequests)
    .innerJoin(mailItems, eq(mailItems.id, mailRequests.mailItemId))
    .innerJoin(clients, eq(clients.id, mailRequests.clientId))
    .where(where)
    .orderBy(order(mailRequests.requestedAt), order(mailRequests.id))
    .$dynamic()
  if (options.limit !== undefined) query = query.limit(options.limit)
  if (options.offset !== undefined) query = query.offset(options.offset)
  const rows = (await query) as unknown as RawRequest[]
  return options.staff ? rows.map(toStaffRequestRow) : rows.map(toRequestRow)
}

/* -------------------------------------------------------------------------- */
/* Espace client : les demandes                                               */
/* -------------------------------------------------------------------------- */

/**
 * Historique des demandes de l'entreprise (R24) : déposées, en cours, faites,
 * refusées, annulées — une annulation ne l'efface plus. Les plis retirés (mal
 * attribués) en sont exclus, comme de la boîte aux lettres.
 */
export async function listRequestsForAccounts(
  accounts: ClientAccount[],
  filters: { statuses: readonly MailRequestStatus[]; kind?: MailRequestKind },
  page: { number: number; size: number },
): Promise<{ rows: MailRequestRow[]; total: number }> {
  if (accounts.length === 0) return { rows: [], total: 0 }
  const where = and(
    inArray(
      mailRequests.clientId,
      accounts.map((account) => account.clientId),
    ),
    inArray(mailRequests.status, [...filters.statuses]),
    filters.kind ? eq(mailRequests.kind, filters.kind) : undefined,
    isNull(mailItems.deletedAt),
  )
  return inClientSpace(accounts, async (tx) => {
    const [counted] = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(mailRequests)
      .innerJoin(mailItems, eq(mailItems.id, mailRequests.mailItemId))
      .where(where)
    const rows = await selectRequests(tx, where, {
      order: 'desc',
      staff: false,
      limit: page.size,
      offset: (page.number - 1) * page.size,
    })
    return { rows, total: Number(counted?.total ?? 0) }
  })
}

/** Résultat d'une demande déposée depuis l'espace client. */
export type RequestOutcome = { ok: true; requestId: string } | { ok: false; error: string }

const NOT_FOUND: RequestOutcome = { ok: false, error: 'Ce courrier est introuvable dans votre espace.' }

/**
 * Dépose une demande au nom de la personne de l'entreprise destinataire du
 * pli. La base date la demande, vérifie l'état du pli (fermé pour une
 * ouverture, ouvert pour une numérisation, ni retiré ni réexpédié) et refuse
 * une seconde demande de même nature en cours.
 */
async function submitRequest(
  mailItemId: string,
  accounts: ClientAccount[],
  values: (account: ClientAccount) => Omit<typeof mailRequests.$inferInsert, 'mailItemId' | 'clientId'>,
): Promise<RequestOutcome> {
  if (accounts.length === 0 || !isUuid(mailItemId)) return NOT_FOUND
  try {
    return await inClientSpace(accounts, async (tx) => {
      const [item] = await tx
        .select({ clientId: mailItems.clientId })
        .from(mailItems)
        .where(
          and(
            eq(mailItems.id, mailItemId),
            inArray(
              mailItems.clientId,
              accounts.map((account) => account.clientId),
            ),
            isNull(mailItems.deletedAt),
          ),
        )
        .limit(1)
      const account = item && accounts.find((candidate) => candidate.clientId === item.clientId)
      if (!account) return NOT_FOUND
      const [request] = await tx
        .insert(mailRequests)
        .values({ ...values(account), mailItemId, clientId: account.clientId })
        .returning({ id: mailRequests.id })
      return { ok: true as const, requestId: request.id }
    })
  } catch (error) {
    const message = mailRequestRefusal(error)
    if (message) return { ok: false, error: message }
    throw error
  }
}

/** Numérisation seule d'un pli déjà ouvert : pages oubliées, numérisation effacée. */
export function requestScan(
  mailItemId: string,
  accounts: ClientAccount[],
  note: string | null,
): Promise<RequestOutcome> {
  return submitRequest(mailItemId, accounts, (account) => ({
    kind: 'scan',
    requestedByMemberId: account.memberId,
    clientNote: note,
  }))
}

/** Réexpédition, à l'adresse figée dans la demande (ADR 037). */
export function requestForward(
  mailItemId: string,
  accounts: ClientAccount[],
  address: ForwardAddress,
  note: string | null,
): Promise<RequestOutcome> {
  return submitRequest(mailItemId, accounts, (account) => ({
    kind: 'forward',
    requestedByMemberId: account.memberId,
    clientNote: note,
    forwardRecipient: address.recipient,
    forwardAddressLine1: address.line1,
    forwardAddressLine2: address.line2,
    forwardPostalCode: address.postalCode,
    forwardCity: address.city,
    forwardCountry: address.country,
  }))
}

/**
 * Annulation d'une demande pas encore prise en charge, par toute personne de
 * l'entreprise : la demande passe `cancelled` à son nom, la trace reste. La
 * base pose la date et refuse toute autre transition sous portée client.
 */
export async function cancelMailRequest(
  requestId: string,
  accounts: ClientAccount[],
): Promise<RequestOutcome> {
  if (accounts.length === 0 || !isUuid(requestId)) {
    return { ok: false, error: 'Cette demande est introuvable dans votre espace.' }
  }
  try {
    return await inClientSpace(accounts, async (tx) => {
      const [request] = await tx
        .select({ id: mailRequests.id, clientId: mailRequests.clientId, status: mailRequests.status })
        .from(mailRequests)
        .innerJoin(mailItems, eq(mailItems.id, mailRequests.mailItemId))
        .where(
          and(
            eq(mailRequests.id, requestId),
            inArray(
              mailRequests.clientId,
              accounts.map((account) => account.clientId),
            ),
            isNull(mailItems.deletedAt),
          ),
        )
        .limit(1)
      const account = request && accounts.find((candidate) => candidate.clientId === request.clientId)
      if (!account) return { ok: false as const, error: 'Cette demande est introuvable dans votre espace.' }
      const updated = await tx
        .update(mailRequests)
        .set({ status: 'cancelled', cancelledByMemberId: account.memberId })
        .where(and(eq(mailRequests.id, request.id), eq(mailRequests.status, 'requested')))
        .returning({ id: mailRequests.id })
      if (updated.length === 0) {
        return {
          ok: false as const,
          error: 'Cette demande ne peut plus être annulée : le centre l’a déjà prise en charge.',
        }
      }
      return { ok: true as const, requestId: request.id }
    })
  } catch (error) {
    const message = mailRequestRefusal(error)
    if (message) return { ok: false, error: message }
    throw error
  }
}

export type PreviousForwardAddress = {
  requestId: string
  requestedAt: Date
  address: ForwardAddress
}

/**
 * Adresses des dernières réexpéditions de l'entreprise, sans doublon : le
 * portail les propose (ADR 037, pas d'adresse de réexpédition sur la fiche).
 */
export async function previousForwardAddresses(
  accounts: ClientAccount[],
  clientId: string,
  limit = 5,
): Promise<PreviousForwardAddress[]> {
  if (!accounts.some((account) => account.clientId === clientId)) return []
  const rows = await inClientSpace(accounts, (tx) =>
    tx
      .select({
        id: mailRequests.id,
        requestedAt: mailRequests.requestedAt,
        recipient: mailRequests.forwardRecipient,
        line1: mailRequests.forwardAddressLine1,
        line2: mailRequests.forwardAddressLine2,
        postalCode: mailRequests.forwardPostalCode,
        city: mailRequests.forwardCity,
        country: mailRequests.forwardCountry,
      })
      .from(mailRequests)
      .where(and(eq(mailRequests.clientId, clientId), eq(mailRequests.kind, 'forward')))
      .orderBy(desc(mailRequests.requestedAt))
      .limit(50),
  )
  const found: PreviousForwardAddress[] = []
  for (const row of rows) {
    if (!row.recipient || !row.line1 || !row.postalCode || !row.city || !row.country) continue
    const address: ForwardAddress = {
      recipient: row.recipient,
      line1: row.line1,
      line2: row.line2,
      postalCode: row.postalCode,
      city: row.city,
      country: row.country,
    }
    if (found.some((known) => sameForwardAddress(known.address, address))) continue
    found.push({ requestId: row.id, requestedAt: row.requestedAt, address })
    if (found.length >= limit) break
  }
  return found
}

/* -------------------------------------------------------------------------- */
/* Espace client : prix annoncé avant de demander                             */
/* -------------------------------------------------------------------------- */

/** Service du catalogue de chaque nature de demande (ADR 037). */
const requestServiceCodes: Record<MailRequestKind, string> = {
  // Une ouverture se facture par son pli, au service de l'ouverture.
  open_and_scan: serviceCodes.mailOpening,
  scan: serviceCodes.mailScan,
  forward: serviceCodes.mailForwarding,
}

export type ClientActAnnouncements = Record<MailRequestKind, ActAnnouncement>

/**
 * Ce que coûtera la prochaine demande de chaque nature, par entreprise du
 * compte : la règle de la facture (`priceActs`), appliquée aux actes déjà faits
 * ce mois-ci, souscriptions et inclus compris (ADR 024). Le client le sait
 * avant de cliquer, il ne le découvre pas sur la facture.
 */
export async function announceMailActs(
  accounts: ClientAccount[],
  timeZone: string,
  now: Date = new Date(),
): Promise<Map<string, ClientActAnnouncements>> {
  const result = new Map<string, ClientActAnnouncements>()
  if (accounts.length === 0) return result
  const clientIds = accounts.map((account) => account.clientId)
  const today = todayIsoDate(timeZone, now)
  const month = monthRangeUtc(today.slice(0, 7), timeZone)

  return inClientSpace(accounts, async (tx) => {
    const serviceRows = await tx
      .select({
        id: services.id,
        code: services.code,
        unitPriceCents: services.unitPriceCents,
        vatRateBp: services.vatRateBp,
        currency: services.currency,
      })
      .from(services)
      .where(and(inArray(services.code, Object.values(requestServiceCodes)), isNull(services.deletedAt)))
    const serviceIds = serviceRows.map((service) => service.id)

    const subscriptionRows = serviceIds.length
      ? await tx
          .select({
            id: subscribedServices.id,
            clientId: subscribedServices.clientId,
            serviceId: subscribedServices.serviceId,
            startsOn: subscribedServices.startsOn,
            endsOn: subscribedServices.endsOn,
            unitPriceCents: subscribedServices.unitPriceCents,
            discountBp: subscribedServices.discountBp,
            vatRateBp: subscribedServices.vatRateBp,
            currency: subscribedServices.currency,
            includedQuantity: subscribedServices.includedQuantity,
          })
          .from(subscribedServices)
          .where(
            and(
              inArray(subscribedServices.clientId, clientIds),
              inArray(subscribedServices.serviceId, serviceIds),
              isNull(subscribedServices.deletedAt),
              // Celles d'un contrat engagé, ou sans contrat, comme au lot.
              or(
                isNull(subscribedServices.contractId),
                sql`exists (
                  select 1 from contracts as k
                   where k.tenant_id = ${subscribedServices.tenantId}
                     and k.id = ${subscribedServices.contractId}
                     and k.deleted_at is null
                     and k.status in ('active', 'terminated'))`,
              ),
            ),
          )
      : []

    const openings = await tx
      .select({ id: mailItems.id, clientId: mailItems.clientId, at: mailItems.openedAt })
      .from(mailItems)
      .where(
        and(
          inArray(mailItems.clientId, clientIds),
          isNull(mailItems.deletedAt),
          gte(mailItems.openedAt, month.startsAt),
          lt(mailItems.openedAt, month.endsAt),
        ),
      )
    const doneRequests = await tx
      .select({
        id: mailRequests.id,
        clientId: mailRequests.clientId,
        kind: mailRequests.kind,
        at: mailRequests.completedAt,
      })
      .from(mailRequests)
      .innerJoin(mailItems, eq(mailItems.id, mailRequests.mailItemId))
      .where(
        and(
          inArray(mailRequests.clientId, clientIds),
          eq(mailRequests.status, 'done'),
          inArray(mailRequests.kind, ['scan', 'forward']),
          isNull(mailItems.deletedAt),
          gte(mailRequests.completedAt, month.startsAt),
          lt(mailRequests.completedAt, month.endsAt),
        ),
      )

    for (const clientId of clientIds) {
      const announcements = {} as ClientActAnnouncements
      for (const kind of Object.keys(requestServiceCodes) as MailRequestKind[]) {
        const service = serviceRows.find((candidate) => candidate.code === requestServiceCodes[kind]) ?? null
        const subscriptions: ActSubscription[] = service
          ? subscriptionRows.filter((row) => row.clientId === clientId && row.serviceId === service.id)
          : []
        const occurrences: { id: string; at: Date | null }[] =
          kind === 'open_and_scan'
            ? openings.filter((row) => row.clientId === clientId)
            : doneRequests.filter((row) => row.clientId === clientId && row.kind === kind)
        const done: ActOccurrence[] = []
        for (const row of occurrences) {
          if (row.at) done.push({ id: row.id, day: toIsoDate(row.at, timeZone), at: row.at })
        }
        announcements[kind] = announceNextAct(done, subscriptions, service, { day: today, at: now })
      }
      result.set(clientId, announcements)
    }
    return result
  })
}

/* -------------------------------------------------------------------------- */
/* Back-office : la file des demandes                                         */
/* -------------------------------------------------------------------------- */

export type RequestQueueFilters = {
  statuses: readonly MailRequestStatus[]
  kind?: MailRequestKind
  clientId?: string
}

const isQueue = (statuses: readonly MailRequestStatus[]) =>
  statuses.length > 0 && statuses.every((status) => (pendingRequestStatuses as readonly string[]).includes(status))

function queueWhere(filters: RequestQueueFilters): SQL | undefined {
  return and(
    inArray(mailRequests.status, [...filters.statuses]),
    filters.kind ? eq(mailRequests.kind, filters.kind) : undefined,
    filters.clientId && isUuid(filters.clientId) ? eq(mailRequests.clientId, filters.clientId) : undefined,
  )
}

/**
 * File des demandes de l'accueil, par nature et par état (R21). Les demandes
 * à traiter se lisent dans l'ordre d'arrivée (`mail_requests_queue_idx`), le
 * reste du plus récent au plus ancien.
 */
export async function listMailRequests(
  filters: RequestQueueFilters,
  page: { number: number; size: number },
): Promise<{ rows: StaffMailRequestRow[]; total: number }> {
  if (filters.statuses.length === 0) return { rows: [], total: 0 }
  const where = queueWhere(filters)
  return withTenant(currentTenantId(), async (tx) => {
    const [counted] = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(mailRequests)
      .where(where)
    const rows = await selectRequests(tx, where, {
      order: isQueue(filters.statuses) ? 'asc' : 'desc',
      staff: true,
      limit: page.size,
      offset: (page.number - 1) * page.size,
    })
    return { rows, total: Number(counted?.total ?? 0) }
  })
}

/** Demandes à traiter, par nature : la navigation et les filtres de la file. */
export async function countPendingMailRequests(): Promise<Record<MailRequestKind, number> & { total: number }> {
  const rows = await withTenant(currentTenantId(), (tx) =>
    tx
      .select({ kind: mailRequests.kind, count: sql<number>`count(*)::int` })
      .from(mailRequests)
      .where(inArray(mailRequests.status, [...pendingRequestStatuses]))
      .groupBy(mailRequests.kind),
  )
  const counts = { open_and_scan: 0, scan: 0, forward: 0, total: 0 }
  for (const row of rows) {
    counts[row.kind] = Number(row.count)
    counts.total += Number(row.count)
  }
  return counts
}

/** Toutes les demandes d'un pli, dans l'ordre où elles ont été déposées. */
export async function listRequestsForMail(mailItemId: string): Promise<StaffMailRequestRow[]> {
  if (!isUuid(mailItemId)) return []
  return withTenant(currentTenantId(), (tx) =>
    selectRequests(tx, eq(mailRequests.mailItemId, mailItemId), { order: 'asc', staff: true }),
  )
}

export async function findMailRequest(id: string): Promise<StaffMailRequestRow | undefined> {
  if (!isUuid(id)) return undefined
  const [row] = await withTenant(currentTenantId(), (tx) =>
    selectRequests(tx, eq(mailRequests.id, id), { order: 'asc', staff: true, limit: 1 }),
  )
  return row
}

/* -------------------------------------------------------------------------- */
/* Back-office : traitement                                                   */
/* -------------------------------------------------------------------------- */

const MOVED = 'Cette demande a changé d’état entre-temps : rechargez la page.'

/** Écrit une transition ; aucune ligne touchée : la demande n'était plus dans l'état attendu. */
async function transition(
  id: string,
  run: (tx: Transaction) => Promise<{ id: string; mailItemId: string }[]>,
): Promise<{ id: string; mailItemId: string }> {
  if (!isUuid(id)) throw new MailRequestError('Demande introuvable.')
  return refusing(async () => {
    const [row] = await withTenant(currentTenantId(), run)
    if (!row) throw new MailRequestError(MOVED)
    return row
  })
}

const returningIds = { id: mailRequests.id, mailItemId: mailRequests.mailItemId }

/** Prise en charge : le client ne peut plus annuler, il voit que le centre s'en occupe. */
export function startMailRequest(id: string, staffMemberId: string) {
  return transition(id, (tx) =>
    tx
      .update(mailRequests)
      .set({ status: 'in_progress', startedByStaffId: staffMemberId })
      .where(and(eq(mailRequests.id, id), eq(mailRequests.status, 'requested')))
      .returning(returningIds),
  )
}

/** Refus, avec son motif, montré au client. Le résumé du pli suit (base). */
export function refuseMailRequest(id: string, staffMemberId: string, reason: string) {
  return transition(id, (tx) =>
    tx
      .update(mailRequests)
      .set({ status: 'refused', refusedByStaffId: staffMemberId, refusalReason: reason })
      .where(and(eq(mailRequests.id, id), inArray(mailRequests.status, [...pendingRequestStatuses])))
      .returning(returningIds),
  )
}

/** Annulation par l'accueil, à la demande du client (par téléphone) : tracée à son nom. */
export function cancelMailRequestForClient(id: string, staffMemberId: string) {
  return transition(id, (tx) =>
    tx
      .update(mailRequests)
      .set({ status: 'cancelled', cancelledByStaffId: staffMemberId })
      .where(and(eq(mailRequests.id, id), eq(mailRequests.status, 'requested')))
      .returning(returningIds),
  )
}

export type ForwardShipping = {
  trackingNumber: string | null
  /** Frais d'affranchissement réels, en centimes ; nuls : pas encore relevés. */
  postageCents: number | null
}

async function tenantCurrency(tx: Transaction): Promise<string> {
  const [tenant] = await tx
    .select({ currency: tenants.currency })
    .from(tenants)
    .where(eq(tenants.id, currentTenantId()))
    .limit(1)
  return tenant?.currency ?? 'EUR'
}

/**
 * Réexpédition faite : date posée par la base, numéro de suivi et frais
 * facultatifs, notés maintenant ou plus tard (`updateForwardShipping`). La base
 * refuse de clore une réexpédition tant qu'une autre demande attend sur le pli.
 */
export function completeForwardRequest(id: string, staffMemberId: string, shipping: ForwardShipping) {
  return transition(id, async (tx) => {
    const currency = await tenantCurrency(tx)
    return tx
      .update(mailRequests)
      .set({
        status: 'done',
        completedByStaffId: staffMemberId,
        forwardTrackingNumber: shipping.trackingNumber,
        postageCents: shipping.postageCents,
        postageCurrency: shipping.postageCents === null ? null : currency,
      })
      .where(
        and(
          eq(mailRequests.id, id),
          eq(mailRequests.kind, 'forward'),
          inArray(mailRequests.status, [...pendingRequestStatuses]),
        ),
      )
      .returning(returningIds)
  })
}

/**
 * Suivi et frais d'une réexpédition faite, relevés après l'envoi. Les frais ne
 * changent plus dès qu'une facture tient la demande (CA008).
 */
export function updateForwardShipping(id: string, shipping: ForwardShipping) {
  return transition(id, async (tx) => {
    const currency = await tenantCurrency(tx)
    return tx
      .update(mailRequests)
      .set({
        forwardTrackingNumber: shipping.trackingNumber,
        postageCents: shipping.postageCents,
        postageCurrency: shipping.postageCents === null ? null : currency,
      })
      .where(and(eq(mailRequests.id, id), eq(mailRequests.kind, 'forward'), eq(mailRequests.status, 'done')))
      .returning(returningIds)
  })
}

/**
 * Numérisation seule faite : le contenu est déposé (chiffré, ADR 020), puis
 * rattaché à la demande, qui passe faite. Un échec de l'écriture efface le
 * fichier déposé.
 */
export async function completeScanRequest(
  id: string,
  staffMemberId: string,
  content: ScanFile,
): Promise<{ id: string; mailItemId: string }> {
  if (!isUuid(id)) throw new MailRequestError('Demande introuvable.')
  const stored = await store(currentTenantId(), { content })
  try {
    return await recordScanRequestDone(id, staffMemberId, stored)
  } catch (error) {
    await discard(stored)
    throw error
  }
}

/**
 * Écriture d'une numérisation demandée, une fois le contenu déposé : séparée
 * du dépôt pour s'éprouver contre la base sans stockage réel.
 */
export function recordScanRequestDone(id: string, staffMemberId: string, stored: StoredScan[]) {
  return transition(id, async (tx) => {
    const [request] = await tx
      .select({ id: mailRequests.id, mailItemId: mailRequests.mailItemId })
      .from(mailRequests)
      .where(
        and(
          eq(mailRequests.id, id),
          eq(mailRequests.kind, 'scan'),
          inArray(mailRequests.status, [...pendingRequestStatuses]),
        ),
      )
      .limit(1)
      .for('update')
    if (!request) return []
    if (stored.length > 0) {
      await tx.insert(mailScans).values(
        scanRows(request.mailItemId, stored, staffMemberId).map((row) => ({
          ...row,
          mailRequestId: row.side === 'content' ? request.id : null,
        })),
      )
    }
    return tx
      .update(mailRequests)
      .set({ status: 'done', completedByStaffId: staffMemberId })
      .where(eq(mailRequests.id, request.id))
      .returning(returningIds)
  })
}
