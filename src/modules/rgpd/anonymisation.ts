import { and, asc, desc, eq, isNotNull, isNull, sql, type AnyColumn } from 'drizzle-orm'
import { alias } from 'drizzle-orm/mysql-core'

import { DB_ANONYMIZATION_REFUSED, dbErrorCode } from '../../db/errors.ts'
import { tenantContext } from '../../db/contexte.ts'
import { withTenant, type Database, type Transaction } from '../../db/index.ts'
import { updateReturning } from '../../db/returning.ts'
import { staffMembers, type AnonymizationBasis } from '../../db/staff.ts'
import { tenants } from '../../db/tenants.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { clientMembers, clients } from '../clients/schema.ts'
import type { OnRequestBasis } from './fondement.ts'

/**
 * Anonymisation RGPD (R29, ADR 040 et 041), côté application.
 *
 * La base décide de tout : ce qui part, ce qui reste, et les exclusions
 * (`client_anonymization_blockers()`). Le code déclenche les fonctions
 * `anonymize_*` (`src/db/regles/90-rgpd.sql`, ADR 040) et rapporte des
 * nombres — jamais un nom, une adresse ou un objet de message. Il ne pose
 * jamais `anonymized_at` ni la variable de session `@app_anonymization` : les
 * triggers de garde le refuseraient (`CA012`).
 *
 * Signatures : `docs/migration-mysql/routines-rgpd.md`.
 */

/* ------------------------------------------------------------------------ */
/* Tâche de nuit                                                            */
/* ------------------------------------------------------------------------ */

/**
 * Bilan d'un passage sur les entreprises : des nombres seulement, pour le
 * journal de la tâche et la réponse de la route.
 */
export type ExpiredClientsReport = {
  /** Entreprises (prospects et clients) anonymisées au terme de leur durée. */
  clients: number
  /** Leurs contacts. */
  contacts: number
  /** Leurs accès à l'espace client. */
  accesses: number
  /** Leurs plis dont l'expéditeur et la note sont partis. */
  mailSenders: number
}

export type RemovedMembersReport = {
  /** Accès à l'espace client retirés depuis plus que la durée du centre. */
  accesses: number
  /** Membres de l'équipe retirés depuis plus que la durée du centre. */
  staff: number
}

const count = (value: unknown) => Number(value ?? 0)

/**
 * Centre de la transaction en cours : celui que `withTenant()` a posé, qui peut
 * différer de `currentTenantId()` (la tâche de nuit reçoit le sien). La base ne
 * filtre plus les lectures : chaque requête le porte elle-même.
 */
const transactionTenantId = () => tenantContext.getStore() ?? currentTenantId()

/**
 * `client_anonymization_blockers()` rend un tableau JSON de phrases ; selon le
 * pilote il arrive déjà décodé ou en chaîne.
 */
function parseBlockers(value: string[] | string | null | undefined): string[] {
  if (value === null || value === undefined) return []
  return typeof value === 'string' ? (JSON.parse(value) as string[]) : value
}

/**
 * Prospects sans suite et clients partis, au terme des durées du centre
 * (`prospect_retention_months`, `client_retention_months`) :
 * `anonymize_expired_clients()` passe les entreprises sous exclusion sans
 * erreur — facture non soldée, contrat vivant, réservation à venir… — et
 * celles qu'une autre transaction tient (elles le seront au passage suivant).
 *
 * Le détail se compte par différence, dans la même transaction : on compte les
 * lignes déjà anonymisées avant et après l'appel. (PostgreSQL retrouvait les
 * lignes du passage par `anonymized_at = now()`, constant dans la transaction ;
 * `CURRENT_TIMESTAMP` de MySQL change à chaque instruction.)
 */
export async function anonymizeExpiredClients(tx: Transaction): Promise<ExpiredClientsReport> {
  const before = await countAnonymized(tx)
  const [rows] = (await tx.execute(
    sql`select anonymize_expired_clients() as clients`,
  )) as unknown as [{ clients: number | string | null }[]]
  const after = await countAnonymized(tx)
  return {
    clients: count(rows[0]?.clients),
    contacts: after.contacts - before.contacts,
    accesses: after.accesses - before.accesses,
    mailSenders: after.mailSenders - before.mailSenders,
  }
}

/** Lignes déjà anonymisées du centre courant, par famille. */
async function countAnonymized(tx: Transaction) {
  const tenantId = transactionTenantId()
  const [rows] = (await tx.execute(sql`
    select
      (select count(*) from client_contacts
        where tenant_id = ${tenantId} and anonymized_at is not null) as contacts,
      (select count(*) from client_members
        where tenant_id = ${tenantId} and anonymized_at is not null) as accesses,
      (select count(*) from mail_items
        where tenant_id = ${tenantId} and sender_anonymized_at is not null) as mail_senders,
      (select count(*) from staff_members
        where tenant_id = ${tenantId} and anonymized_at is not null) as staff`)) as unknown as [
    { contacts: unknown; accesses: unknown; mail_senders: unknown; staff: unknown }[],
  ]
  const row = rows[0]
  return {
    contacts: count(row?.contacts),
    accesses: count(row?.accesses),
    mailSenders: count(row?.mail_senders),
    staff: count(row?.staff),
  }
}

/**
 * Traces des accès à l'espace client et des membres de l'équipe retirés
 * depuis plus que `removed_member_retention_months` : nom et adresse partent,
 * la ligne reste (elle signe des demandes, des ouvertures, des consultations).
 */
export async function anonymizeRemovedMembers(tx: Transaction): Promise<RemovedMembersReport> {
  const before = await countAnonymized(tx)
  await tx.execute(sql`select anonymize_removed_members()`)
  const after = await countAnonymized(tx)
  return { accesses: after.accesses - before.accesses, staff: after.staff - before.staff }
}

/* ------------------------------------------------------------------------ */
/* À la demande                                                             */
/* ------------------------------------------------------------------------ */

export type AnonymizationOutcome = { ok: true } | { ok: false; reason: string }

/**
 * Conseil donné après l'énumération des exclusions. PostgreSQL le portait en
 * `HINT` ; `SIGNAL` de MySQL n'a qu'un message (et court), il est donc ajouté
 * ici, pour le seul refus qui énumère des exclusions.
 */
const BLOCKERS_HINT =
  'Soldez ou annulez par avoir, terminez les contrats et services, révoquez le mandat, traitez les demandes, puis recommencez.'

/**
 * Message d'un refus `CA012`, sans son préfixe de code, avec le conseil quand
 * le refus énumère des exclusions. Seulement pour ce code : le message d'une
 * autre erreur pourrait citer une valeur saisie.
 */
export function refusalMessage(error: unknown): string | undefined {
  if (dbErrorCode(error) !== DB_ANONYMIZATION_REFUSED) return undefined
  for (let cause: unknown = error, depth = 0; cause && depth < 10; depth++) {
    const { sqlMessage } = cause as { sqlMessage?: unknown }
    if (typeof sqlMessage === 'string') {
      const message = sqlMessage.replace(/^CA\d{3}:\s*/, '')
      return message.startsWith('Anonymisation refusée') ? `${message} ${BLOCKERS_HINT}` : message
    }
    cause = (cause as { cause?: unknown }).cause
  }
  return undefined
}

/**
 * Appelle une fonction `anonymize_*` dans sa propre transaction. Le refus est
 * lu hors de la transaction, déjà annulée : rien n'a changé.
 */
async function attempt(
  run: (tx: Transaction) => Promise<unknown>,
  database?: Database,
): Promise<AnonymizationOutcome> {
  try {
    await withTenant(currentTenantId(), run, database)
    return { ok: true }
  } catch (error) {
    if (dbErrorCode(error) !== DB_ANONYMIZATION_REFUSED) throw error
    return { ok: false, reason: refusalMessage(error) ?? 'Anonymisation refusée par la base.' }
  }
}

/**
 * Ce qu'une anonymisation à la demande dit d'elle-même (ADR 041) : qui la
 * décide, sur quel fondement, et pour une demande d'effacement le jour où le
 * centre l'a reçue. La base le trace sur la ligne anonymisée.
 */
export type AnonymizationRequest = {
  /** Membre de l'équipe, vivant, qui la décide. */
  staffMemberId: string
  basis: OnRequestBasis
  /** Jour de réception d'une demande d'effacement ; nul pour une fin de relation. */
  erasureRequestedOn: string | null
}

const requestArguments = (request: AnonymizationRequest) =>
  sql`${request.staffMemberId}, ${request.basis}, ${request.erasureRequestedOn}`

/**
 * Droit à l'effacement d'une entreprise (ou fin de relation constatée) : sans
 * attendre sa durée, jamais contre une exclusion. Le refus énumère ce qui
 * l'empêche.
 */
export async function anonymizeClientOnRequest(
  clientId: string,
  request: AnonymizationRequest,
  database?: Database,
): Promise<AnonymizationOutcome> {
  const outcome = await attempt(
    (tx) => tx.execute(sql`select anonymize_client(${clientId}, ${requestArguments(request)})`),
    database,
  )
  if (outcome.ok || !outcome.reason.startsWith('Anonymisation refusée')) return outcome

  // Le `SIGNAL` de MySQL tient en 128 caractères : le message de la base est
  // abrégé. L'énumération complète des exclusions se relit par la fonction qui
  // les calcule — la transaction du refus est annulée, rien n'a changé.
  const blockers = await withTenant(
    currentTenantId(),
    async (tx) => {
      const [rows] = (await tx.execute(
        sql`select client_anonymization_blockers(${clientId}) as raisons`,
      )) as unknown as [{ raisons: string[] | string | null }[]]
      return parseBlockers(rows[0]?.raisons)
    },
    database,
  )
  if (blockers.length === 0) return outcome
  return { ok: false, reason: `Anonymisation refusée : ${blockers.join(' ')} ${BLOCKERS_HINT}` }
}

/** Un accès à l'espace client **déjà retiré**, à la demande de la personne. */
export function anonymizeClientMemberOnRequest(
  memberId: string,
  request: AnonymizationRequest,
  database?: Database,
) {
  return attempt(
    (tx) => tx.execute(sql`select anonymize_client_member(${memberId}, ${requestArguments(request)})`),
    database,
  )
}

/** Un membre de l'équipe **déjà retiré**, à sa demande. */
export function anonymizeStaffMemberOnRequest(
  staffMemberId: string,
  request: AnonymizationRequest,
  database?: Database,
) {
  return attempt(
    (tx) => tx.execute(sql`select anonymize_staff_member(${staffMemberId}, ${requestArguments(request)})`),
    database,
  )
}

/* ------------------------------------------------------------------------ */
/* Ce que montrent les écrans                                               */
/* ------------------------------------------------------------------------ */

/** Où en est une entreprise de sa durée de conservation. */
export type ClientRetention = {
  /** Dernière activité, jour du centre (`client_last_activity_on`). */
  lastActivityOn: string
  /** Durée qui s'applique : prospect ou client. */
  retentionMonths: number
  /** Jour après lequel la tâche de nuit l'anonymise, sauf exclusion ou activité nouvelle. */
  dueAfter: string
  /** Ce qui empêche l'anonymisation, en phrases ; vide : rien. */
  blockers: string[]
}

export async function readClientRetention(
  tx: Transaction,
  clientId: string,
): Promise<ClientRetention | undefined> {
  const [rows] = (await tx.execute(sql`
    select cast(activity.day as char) as last_activity_on,
           activity.months as retention_months,
           cast(date_add(activity.day, interval activity.months month) as char) as due_after,
           client_anonymization_blockers(activity.id) as blockers
      from (
        select c.id,
               client_last_activity_on(c.id) as day,
               case when c.status = 'prospect' then t.prospect_retention_months
                    else t.client_retention_months end as months
          from clients as c
          join tenants as t on t.id = c.tenant_id
         where c.id = ${clientId} and c.tenant_id = ${transactionTenantId()}
      ) as activity`)) as unknown as [
    {
      last_activity_on: string | null
      retention_months: number | string
      due_after: string | null
      blockers: string[] | string | null
    }[],
  ]
  const row = rows[0]
  if (!row?.last_activity_on || !row.due_after) return undefined
  return {
    lastActivityOn: row.last_activity_on,
    retentionMonths: count(row.retention_months),
    dueAfter: row.due_after,
    blockers: parseBlockers(row.blockers),
  }
}

export function findClientRetention(clientId: string) {
  return withTenant(currentTenantId(), (tx) => readClientRetention(tx, clientId))
}

/** Une personne retirée : accès à l'espace client ou membre de l'équipe. */
export type RemovedPerson = {
  id: string
  email: string
  fullName: string | null
  removedAt: Date
  anonymizedAt: Date | null
  /** Fondement de l'anonymisation, sa date de demande et son auteur (ADR 041). */
  anonymizationBasis: AnonymizationBasis | null
  erasureRequestedOn: string | null
  anonymizedByName: string | null
  /** Instant après lequel la tâche de nuit l'anonymise. */
  dueAfter: Date
}

/** Le membre de l'équipe qui a décidé une anonymisation, par son nom (ou son adresse). */
const anonymizer = alias(staffMembers, 'anonymizer')
const anonymizerName = sql<string | null>`coalesce(${anonymizer.fullName}, ${anonymizer.email})`

const dueAfter = (removedAt: AnyColumn) =>
  sql<Date>`date_add(${removedAt}, interval ${tenants.removedMemberRetentionMonths} month)`

/** Accès retirés d'une entreprise, les plus récents d'abord. */
export function readRemovedClientMembers(tx: Transaction, clientId: string): Promise<RemovedPerson[]> {
  return tx
    .select({
      id: clientMembers.id,
      email: clientMembers.email,
      fullName: clientMembers.fullName,
      removedAt: sql<Date>`${clientMembers.deletedAt}`.mapWith(clientMembers.deletedAt),
      anonymizedAt: clientMembers.anonymizedAt,
      anonymizationBasis: clientMembers.anonymizationBasis,
      erasureRequestedOn: clientMembers.erasureRequestedOn,
      anonymizedByName: anonymizerName,
      dueAfter: dueAfter(clientMembers.deletedAt).mapWith(clientMembers.deletedAt),
    })
    .from(clientMembers)
    .innerJoin(tenants, eq(tenants.id, clientMembers.tenantId))
    .leftJoin(anonymizer, eq(anonymizer.id, clientMembers.anonymizedBy))
    .where(
      and(
        eq(clientMembers.tenantId, transactionTenantId()),
        eq(clientMembers.clientId, clientId),
        isNotNull(clientMembers.deletedAt),
      ),
    )
    .orderBy(desc(clientMembers.deletedAt), asc(clientMembers.email))
}

export function listRemovedClientMembers(clientId: string) {
  return withTenant(currentTenantId(), (tx) => readRemovedClientMembers(tx, clientId))
}

/** Membres retirés de l'équipe, les plus récents d'abord. */
export function readRemovedStaffMembers(tx: Transaction): Promise<RemovedPerson[]> {
  return tx
    .select({
      id: staffMembers.id,
      email: staffMembers.email,
      fullName: staffMembers.fullName,
      removedAt: sql<Date>`${staffMembers.deletedAt}`.mapWith(staffMembers.deletedAt),
      anonymizedAt: staffMembers.anonymizedAt,
      anonymizationBasis: staffMembers.anonymizationBasis,
      erasureRequestedOn: staffMembers.erasureRequestedOn,
      anonymizedByName: anonymizerName,
      dueAfter: dueAfter(staffMembers.deletedAt).mapWith(staffMembers.deletedAt),
    })
    .from(staffMembers)
    .innerJoin(tenants, eq(tenants.id, staffMembers.tenantId))
    .leftJoin(anonymizer, eq(anonymizer.id, staffMembers.anonymizedBy))
    .where(and(eq(staffMembers.tenantId, transactionTenantId()), isNotNull(staffMembers.deletedAt)))
    .orderBy(desc(staffMembers.deletedAt), asc(staffMembers.email))
}

export function listRemovedStaffMembers() {
  return withTenant(currentTenantId(), readRemovedStaffMembers)
}

/** Nom (ou adresse) du membre de l'équipe qui a décidé l'anonymisation d'une fiche. */
export async function findClientAnonymizer(clientId: string): Promise<string | null> {
  const [row] = await withTenant(currentTenantId(), (tx) =>
    tx
      .select({ name: anonymizerName })
      .from(clients)
      .innerJoin(anonymizer, eq(anonymizer.id, clients.anonymizedBy))
      .where(and(eq(clients.tenantId, transactionTenantId()), eq(clients.id, clientId)))
      .limit(1),
  )
  return row?.name ?? null
}

/** Une entreprise arrivée au terme de sa durée, mais qu'une exclusion retient. */
export type HeldClient = { id: string; name: string; blockers: string[] }

/**
 * Ce que la prochaine tâche de nuit ferait avec les durées enregistrées :
 * mêmes critères que `anonymize_expired_clients()` et
 * `anonymize_removed_members()`, en lecture seule. Les entreprises retenues
 * par une exclusion sont nommées (au plus `limit`) : c'est à l'équipe de
 * solder, de terminer ou de révoquer.
 */
export type AnonymizationOutlook = {
  clients: number
  members: number
  held: number
  heldClients: HeldClient[]
}

export async function readAnonymizationOutlook(
  tx: Transaction,
  limit = 20,
): Promise<AnonymizationOutlook> {
  const tenantId = transactionTenantId()
  const [clientRows] = (await tx.execute(sql`
    select c.id, c.name, client_anonymization_blockers(c.id) as blockers
      from clients as c
      join tenants as t on t.id = c.tenant_id
     where c.tenant_id = ${tenantId} and c.anonymized_at is null
       and client_last_activity_on(c.id) < date_sub(
             rgpd_local_date(current_timestamp(3), t.timezone),
             interval case when c.status = 'prospect' then t.prospect_retention_months
                           else t.client_retention_months end month)
     order by c.name, c.id`)) as unknown as [
    { id: string; name: string; blockers: string[] | string | null }[],
  ]
  const [memberRows] = (await tx.execute(sql`
    select (
      (select count(*) from client_members as m join tenants as t on t.id = m.tenant_id
        where m.tenant_id = ${tenantId} and m.anonymized_at is null and m.deleted_at is not null
          and m.deleted_at < date_sub(current_timestamp(3), interval t.removed_member_retention_months month))
      + (select count(*) from staff_members as s join tenants as t on t.id = s.tenant_id
        where s.tenant_id = ${tenantId} and s.anonymized_at is null and s.deleted_at is not null
          and s.deleted_at < date_sub(current_timestamp(3), interval t.removed_member_retention_months month))
    ) as n`)) as unknown as [{ n: unknown }[]]
  const rows = clientRows.map((row) => ({ ...row, blockers: parseBlockers(row.blockers) }))
  const held = rows.filter((row) => row.blockers.length > 0)
  return {
    clients: rows.length - held.length,
    members: count(memberRows[0]?.n),
    held: held.length,
    heldClients: held.slice(0, limit).map((row) => ({
      id: row.id,
      name: row.name,
      blockers: row.blockers,
    })),
  }
}

export function findAnonymizationOutlook() {
  return withTenant(currentTenantId(), (tx) => readAnonymizationOutlook(tx))
}

/* ------------------------------------------------------------------------ */
/* Dernier contact                                                          */
/* ------------------------------------------------------------------------ */

/**
 * Note le dernier contact de l'équipe avec l'entreprise (R29, ADR 040) : une
 * des dates dont part la durée de conservation. Sans effet sur une fiche
 * anonymisée, qui ne change plus. Rend vrai si la fiche a été mise à jour.
 */
export async function writeLastContact(
  tx: Transaction,
  clientId: string,
  isoDate: string,
): Promise<boolean> {
  const updated = await updateReturning(
    tx,
    clients,
    { lastContactOn: isoDate },
    and(
      eq(clients.tenantId, transactionTenantId()),
      eq(clients.id, clientId),
      isNull(clients.anonymizedAt),
    ),
  )
  return updated.length > 0
}

export function recordLastContact(clientId: string, isoDate: string) {
  return withTenant(currentTenantId(), (tx) => writeLastContact(tx, clientId, isoDate))
}
