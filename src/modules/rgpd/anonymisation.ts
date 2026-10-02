import { and, asc, desc, eq, isNotNull, sql, type AnyColumn } from 'drizzle-orm'

import { PG_ANONYMIZATION_REFUSED, pgErrorCode } from '../../db/errors.ts'
import { withTenant, type Database, type Transaction } from '../../db/index.ts'
import { staffMembers } from '../../db/staff.ts'
import { tenants } from '../../db/tenants.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { clientMembers, clients } from '../clients/schema.ts'

/**
 * Anonymisation RGPD (R29, ADR 040), côté application.
 *
 * La base décide de tout : ce qui part, ce qui reste, et les exclusions
 * (`client_anonymization_blockers()`). Le code déclenche les fonctions
 * `anonymize_*` de la migration 0043 et rapporte des nombres — jamais un nom,
 * une adresse ou un objet de message. Il ne pose jamais `anonymized_at` ni le
 * drapeau de session `app.anonymization` : le garde `anonymized_rows_guard`
 * le refuserait (`CA012`).
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
 * Prospects sans suite et clients partis, au terme des durées du centre
 * (`prospect_retention_months`, `client_retention_months`) :
 * `anonymize_expired_clients()` passe les entreprises sous exclusion sans
 * erreur — facture non soldée, contrat vivant, réservation à venir… — et
 * celles qu'une autre transaction tient (elles le seront au passage suivant).
 *
 * Le détail se compte après coup, dans la même transaction : la fonction pose
 * `anonymized_at = now()`, et `now()` est l'heure de début de la transaction.
 * Les lignes marquées à cet instant sont exactement celles de ce passage.
 */
export async function anonymizeExpiredClients(tx: Transaction): Promise<ExpiredClientsReport> {
  const [done] = await tx.execute<{ clients: number }>(
    sql`select anonymize_expired_clients() as clients`,
  )
  const [detail] = await tx.execute<{ contacts: number; accesses: number; mail_senders: number }>(sql`
    select
      (select count(*) from client_contacts where anonymized_at = now()) as contacts,
      (select count(*) from client_members where anonymized_at = now()) as accesses,
      (select count(*) from mail_items where sender_anonymized_at = now()) as mail_senders`)
  return {
    clients: count(done?.clients),
    contacts: count(detail?.contacts),
    accesses: count(detail?.accesses),
    mailSenders: count(detail?.mail_senders),
  }
}

/**
 * Traces des accès à l'espace client et des membres de l'équipe retirés
 * depuis plus que `removed_member_retention_months` : nom et adresse partent,
 * la ligne reste (elle signe des demandes, des ouvertures, des consultations).
 */
export async function anonymizeRemovedMembers(tx: Transaction): Promise<RemovedMembersReport> {
  await tx.execute(sql`select anonymize_removed_members()`)
  const [detail] = await tx.execute<{ accesses: number; staff: number }>(sql`
    select
      (select count(*) from client_members where anonymized_at = now()) as accesses,
      (select count(*) from staff_members where anonymized_at = now()) as staff`)
  return { accesses: count(detail?.accesses), staff: count(detail?.staff) }
}

/* ------------------------------------------------------------------------ */
/* À la demande                                                             */
/* ------------------------------------------------------------------------ */

export type AnonymizationOutcome = { ok: true } | { ok: false; reason: string }

/**
 * Message d'un refus `CA012`, avec son conseil (`HINT`) quand la base en
 * donne un : il énumère les exclusions, puis dit quoi faire. Seulement pour ce
 * code : le message d'une autre erreur pourrait citer une valeur saisie.
 */
export function refusalMessage(error: unknown): string | undefined {
  for (let cause: unknown = error, depth = 0; cause && depth < 10; depth++) {
    const { code, message, hint } = cause as { code?: unknown; message?: unknown; hint?: unknown }
    if (code === PG_ANONYMIZATION_REFUSED && typeof message === 'string') {
      return typeof hint === 'string' && hint ? `${message} ${hint}` : message
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
    if (pgErrorCode(error) !== PG_ANONYMIZATION_REFUSED) throw error
    return { ok: false, reason: refusalMessage(error) ?? 'Anonymisation refusée par la base.' }
  }
}

/**
 * Droit à l'effacement d'une entreprise (ou fin de relation constatée) : sans
 * attendre sa durée, jamais contre une exclusion. Le refus énumère ce qui
 * l'empêche.
 */
export function anonymizeClientOnRequest(clientId: string, database?: Database) {
  return attempt((tx) => tx.execute(sql`select anonymize_client(${clientId}::uuid)`), database)
}

/** Un accès à l'espace client **déjà retiré**, à la demande de la personne. */
export function anonymizeClientMemberOnRequest(memberId: string, database?: Database) {
  return attempt((tx) => tx.execute(sql`select anonymize_client_member(${memberId}::uuid)`), database)
}

/** Un membre de l'équipe **déjà retiré**, à sa demande. */
export function anonymizeStaffMemberOnRequest(staffMemberId: string, database?: Database) {
  return attempt(
    (tx) => tx.execute(sql`select anonymize_staff_member(${staffMemberId}::uuid)`),
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
  const [row] = await tx.execute<{
    last_activity_on: string | null
    retention_months: number
    due_after: string | null
    blockers: string[] | null
  }>(sql`
    select activity.day::text as last_activity_on,
           activity.months as retention_months,
           (activity.day + make_interval(months => activity.months))::date::text as due_after,
           client_anonymization_blockers(c.id) as blockers
      from clients as c
      join tenants as t on t.id = c.tenant_id
      cross join lateral (
        select client_last_activity_on(c.id) as day,
               case when c.status = 'prospect' then t.prospect_retention_months
                    else t.client_retention_months end as months
      ) as activity
     where c.id = ${clientId}`)
  if (!row?.last_activity_on || !row.due_after) return undefined
  return {
    lastActivityOn: row.last_activity_on,
    retentionMonths: count(row.retention_months),
    dueAfter: row.due_after,
    blockers: row.blockers ?? [],
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
  /** Instant après lequel la tâche de nuit l'anonymise. */
  dueAfter: Date
}

const dueAfter = (removedAt: AnyColumn) =>
  sql<Date>`${removedAt} + make_interval(months => ${tenants.removedMemberRetentionMonths})`

/** Accès retirés d'une entreprise, les plus récents d'abord. */
export function readRemovedClientMembers(tx: Transaction, clientId: string): Promise<RemovedPerson[]> {
  return tx
    .select({
      id: clientMembers.id,
      email: clientMembers.email,
      fullName: clientMembers.fullName,
      removedAt: sql<Date>`${clientMembers.deletedAt}`.mapWith(clientMembers.deletedAt),
      anonymizedAt: clientMembers.anonymizedAt,
      dueAfter: dueAfter(clientMembers.deletedAt).mapWith(clientMembers.deletedAt),
    })
    .from(clientMembers)
    .innerJoin(tenants, eq(tenants.id, clientMembers.tenantId))
    .where(and(eq(clientMembers.clientId, clientId), isNotNull(clientMembers.deletedAt)))
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
      dueAfter: dueAfter(staffMembers.deletedAt).mapWith(staffMembers.deletedAt),
    })
    .from(staffMembers)
    .innerJoin(tenants, eq(tenants.id, staffMembers.tenantId))
    .where(isNotNull(staffMembers.deletedAt))
    .orderBy(desc(staffMembers.deletedAt), asc(staffMembers.email))
}

export function listRemovedStaffMembers() {
  return withTenant(currentTenantId(), readRemovedStaffMembers)
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
  const rows = await tx.execute<{ id: string; name: string; blockers: string[] }>(sql`
    with t as (
      select id, prospect_retention_months, client_retention_months,
             (now() at time zone timezone)::date as today
        from tenants where id = current_tenant_id()
    )
    select c.id, c.name, client_anonymization_blockers(c.id) as blockers
      from clients as c
      join t on t.id = c.tenant_id
     where c.anonymized_at is null
       and client_last_activity_on(c.id) < (t.today - make_interval(months => case
             when c.status = 'prospect' then t.prospect_retention_months
             else t.client_retention_months end))::date
     order by c.name, c.id`)
  const [members] = await tx.execute<{ n: number }>(sql`
    select (
      (select count(*) from client_members as m join tenants as t on t.id = m.tenant_id
        where m.anonymized_at is null and m.deleted_at is not null
          and m.deleted_at < now() - make_interval(months => t.removed_member_retention_months))
      + (select count(*) from staff_members as s join tenants as t on t.id = s.tenant_id
        where s.anonymized_at is null and s.deleted_at is not null
          and s.deleted_at < now() - make_interval(months => t.removed_member_retention_months))
    ) as n`)
  const held = rows.filter((row) => (row.blockers ?? []).length > 0)
  return {
    clients: rows.length - held.length,
    members: count(members?.n),
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
  const updated = await tx
    .update(clients)
    .set({ lastContactOn: isoDate })
    .where(and(eq(clients.id, clientId), sql`${clients.anonymizedAt} is null`))
    .returning({ id: clients.id })
  return updated.length > 0
}

export function recordLastContact(clientId: string, isoDate: string) {
  return withTenant(currentTenantId(), (tx) => writeLastContact(tx, clientId, isoDate))
}
