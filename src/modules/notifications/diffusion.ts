import { and, asc, desc, eq, gte, inArray, isNull, lte, max, or, sql } from 'drizzle-orm'

import { withTenant, type Database, type Transaction } from '../../db/index.ts'
import { staffMembers } from '../../db/staff.ts'
import { toIsoDate } from '../../lib/dates.ts'
import { appUrl } from '../../lib/courriel.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { uuidv7 } from '../../lib/uuid.ts'
import { clientMembers, clients } from '../clients/schema.ts'
import { contracts, type ContractType } from '../contrats/schema.ts'
import {
  BROADCAST_BATCH_PAUSE_MS,
  BROADCAST_BATCH_SIZE,
  BROADCAST_STALE_MINUTES,
  tallyOf,
  type BroadcastAudience,
  type BroadcastInput,
  type BroadcastTally,
} from './diffusion-regles.ts'
import { centreTimeZone } from './faits.ts'
import { notify, type NotificationOutcome, type NotifyOptions } from './moteur.ts'
import { notificationPreferences } from './schema.ts'
import {
  clientBroadcastRecipients,
  clientBroadcasts,
  type BroadcastRecipientStatus,
  type BroadcastTarget,
} from './schema-diffusion.ts'

/**
 * Message groupé aux clients (ADR 060) : choix des destinataires, aperçu,
 * envoi par paquets par le moteur de notifications, historique.
 *
 * Chaque entreprise reçoit **son** message (`client_broadcast`), inscrit au
 * journal des envois comme tout autre : le moteur écarte les personnes qui
 * ont décoché « Informations du centre », et dit pourquoi rien n'est parti.
 *
 * Toute lecture porte son filtre `tenant_id` (`CLAUDE.md`, décision 1).
 */

type Options = { database?: Database; tenantId?: string }

/** Types de contrat en cours qui font la clientèle d'un produit. */
const targetContractTypes: Record<Exclude<BroadcastTarget, 'selection'>, ContractType[]> = {
  domiciliation: ['domiciliation'],
  bureaux: ['bureau', 'coworking'],
}

/** Entreprises vivantes qui ont, ce jour du centre, un contrat en cours de ces types. */
async function clientsUnderContract(
  tx: Transaction,
  tenantId: string,
  types: readonly ContractType[],
  day: string,
): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ clientId: contracts.clientId })
    .from(contracts)
    .innerJoin(clients, and(eq(clients.tenantId, contracts.tenantId), eq(clients.id, contracts.clientId)))
    .where(
      and(
        eq(contracts.tenantId, tenantId),
        inArray(contracts.contractType, [...types]),
        eq(contracts.status, 'active'),
        isNull(contracts.deletedAt),
        lte(contracts.startsOn, day),
        or(isNull(contracts.endsOn), gte(contracts.endsOn, day)),
        isNull(clients.deletedAt),
      ),
    )
  return rows.map((row) => row.clientId)
}

/** Les entreprises visées, par ordre alphabétique : fiches vivantes du centre. */
async function targetClients(
  tx: Transaction,
  tenantId: string,
  input: Pick<BroadcastInput, 'target' | 'clientIds'>,
): Promise<{ id: string; name: string }[]> {
  let ids: string[]
  if (input.target === 'selection') {
    ids = input.clientIds
  } else {
    const day = toIsoDate(new Date(), await centreTimeZone(tx, tenantId))
    ids = await clientsUnderContract(tx, tenantId, targetContractTypes[input.target], day)
  }
  if (ids.length === 0) return []
  return tx
    .select({ id: clients.id, name: clients.name })
    .from(clients)
    .where(and(eq(clients.tenantId, tenantId), inArray(clients.id, ids), isNull(clients.deletedAt)))
    .orderBy(asc(clients.name), asc(clients.id))
}

/**
 * Personnes de l'espace client de chaque entreprise — accès vivants, comme le
 * moteur les sert — et celles qui ont décoché « Informations du centre ».
 */
async function peopleByClient(
  tx: Transaction,
  tenantId: string,
  clientIds: readonly string[],
): Promise<Map<string, { people: number; renounced: number }>> {
  if (clientIds.length === 0) return new Map()
  const rows = await tx
    .select({
      clientId: clientMembers.clientId,
      people: sql<number>`count(*)`,
      renounced: sql<number>`sum(${notificationPreferences.enabled} is not null and not ${notificationPreferences.enabled})`,
    })
    .from(clientMembers)
    .leftJoin(
      notificationPreferences,
      and(
        eq(notificationPreferences.tenantId, clientMembers.tenantId),
        eq(notificationPreferences.clientMemberId, clientMembers.id),
        eq(notificationPreferences.category, 'centre_info'),
      ),
    )
    .where(
      and(
        eq(clientMembers.tenantId, tenantId),
        inArray(clientMembers.clientId, [...clientIds]),
        isNull(clientMembers.deletedAt),
        isNull(clientMembers.anonymizedAt),
      ),
    )
    .groupBy(clientMembers.clientId)
  return new Map(
    rows.map((row) => [row.clientId, { people: Number(row.people), renounced: Number(row.renounced ?? 0) }]),
  )
}

function audienceOf(
  companies: readonly { id: string }[],
  people: Map<string, { people: number; renounced: number }>,
): BroadcastAudience {
  const audience: BroadcastAudience = { companies: companies.length, people: 0, renounced: 0, unreached: 0 }
  for (const company of companies) {
    const found = people.get(company.id) ?? { people: 0, renounced: 0 }
    const reached = found.people - found.renounced
    audience.people += reached
    audience.renounced += found.renounced
    if (reached <= 0) audience.unreached += 1
  }
  return audience
}

export type BroadcastPreview = {
  audience: BroadcastAudience
  /** Les premières entreprises visées, pour vérifier la liste. */
  sample: string[]
}

/** Qui recevrait le message maintenant : l'aperçu avant confirmation. */
export async function previewBroadcast(
  input: Pick<BroadcastInput, 'target' | 'clientIds'>,
  options: Options = {},
): Promise<BroadcastPreview> {
  const tenantId = options.tenantId ?? currentTenantId()
  return withTenant(
    tenantId,
    async (tx) => {
      const companies = await targetClients(tx, tenantId, input)
      const people = await peopleByClient(
        tx,
        tenantId,
        companies.map((company) => company.id),
      )
      return { audience: audienceOf(companies, people), sample: companies.slice(0, 8).map((company) => company.name) }
    },
    options.database,
  )
}

/** Une entreprise que l'on peut cocher dans une sélection. */
export type BroadcastCandidate = {
  id: string
  name: string
  domiciled: boolean
  offices: boolean
  /** Personnes de son espace client, préférence comprise ou non. */
  people: number
}

/** Fiches vivantes du centre, les domiciliés d'abord : la liste de la sélection manuelle. */
export async function listBroadcastCandidates(options: Options = {}): Promise<BroadcastCandidate[]> {
  const tenantId = options.tenantId ?? currentTenantId()
  return withTenant(
    tenantId,
    async (tx) => {
      const day = toIsoDate(new Date(), await centreTimeZone(tx, tenantId))
      const rows = await tx
        .select({ id: clients.id, name: clients.name })
        .from(clients)
        .where(and(eq(clients.tenantId, tenantId), isNull(clients.deletedAt)))
        .orderBy(asc(clients.name), asc(clients.id))
      const domiciled = new Set(await clientsUnderContract(tx, tenantId, targetContractTypes.domiciliation, day))
      const offices = new Set(await clientsUnderContract(tx, tenantId, targetContractTypes.bureaux, day))
      const people = await peopleByClient(
        tx,
        tenantId,
        rows.map((row) => row.id),
      )
      return rows
        .map((row) => ({
          ...row,
          domiciled: domiciled.has(row.id),
          offices: offices.has(row.id),
          people: people.get(row.id)?.people ?? 0,
        }))
        .sort((a, b) => Number(b.domiciled) - Number(a.domiciled))
    },
    options.database,
  )
}

/** Levée quand la liste des destinataires est vide au moment de l'envoi. */
export class EmptyBroadcastError extends Error {
  constructor() {
    super('Aucune entreprise ne correspond à ce choix de destinataires.')
    this.name = 'EmptyBroadcastError'
  }
}

/**
 * Enregistre le message et fige ses destinataires, ensemble : un message
 * sans destinataire n'existe pas. L'envoi, lui, se fait après la réponse
 * (`sendBroadcast`).
 */
export async function createBroadcast(
  input: BroadcastInput,
  staffMemberId: string,
  options: Options = {},
): Promise<{ id: string; companies: number }> {
  const tenantId = options.tenantId ?? currentTenantId()
  return withTenant(
    tenantId,
    async (tx) => {
      const companies = await targetClients(tx, tenantId, input)
      if (companies.length === 0) throw new EmptyBroadcastError()
      const id = uuidv7()
      await tx.insert(clientBroadcasts).values({
        id,
        subject: input.subject,
        body: input.body,
        target: input.target,
        createdBy: staffMemberId,
      })
      await tx
        .insert(clientBroadcastRecipients)
        .values(companies.map((company) => ({ id: uuidv7(), broadcastId: id, clientId: company.id })))
      return { id, companies: companies.length }
    },
    options.database,
  )
}

export type SendBroadcastOptions = NotifyOptions & {
  batchSize?: number
  /** Pause entre deux paquets ; nulle dans les tests. */
  pauseMs?: number
}

/** Prend le paquet suivant : des entreprises en attente, libres ou laissées par un envoi interrompu. */
async function claimBatch(
  broadcastId: string,
  size: number,
  tenantId: string,
  database: Database | undefined,
): Promise<{ token: string; rows: { id: string; clientId: string; clientName: string }[] }> {
  const token = uuidv7()
  return withTenant(
    tenantId,
    async (tx) => {
      await tx.execute(sql`
        update client_broadcast_recipients
           set claim_token = ${token}, claimed_at = current_timestamp(3)
         where tenant_id = ${tenantId} and broadcast_id = ${broadcastId} and status = 'pending'
           and (claimed_at is null
                or claimed_at < current_timestamp(3) - interval ${sql.raw(String(BROADCAST_STALE_MINUTES))} minute)
         order by id
         limit ${sql.raw(String(Math.max(1, Math.trunc(size))))}`)
      const rows = await tx
        .select({
          id: clientBroadcastRecipients.id,
          clientId: clientBroadcastRecipients.clientId,
          clientName: clients.name,
        })
        .from(clientBroadcastRecipients)
        .innerJoin(
          clients,
          and(eq(clients.tenantId, clientBroadcastRecipients.tenantId), eq(clients.id, clientBroadcastRecipients.clientId)),
        )
        .where(
          and(
            eq(clientBroadcastRecipients.tenantId, tenantId),
            eq(clientBroadcastRecipients.broadcastId, broadcastId),
            eq(clientBroadcastRecipients.claimToken, token),
            eq(clientBroadcastRecipients.status, 'pending'),
          ),
        )
        .orderBy(asc(clientBroadcastRecipients.id))
      return { token, rows }
    },
    database,
  )
}

/** L'issue du moteur, telle que l'historique la garde. */
function recipientOutcome(outcome: NotificationOutcome): {
  status: Exclude<BroadcastRecipientStatus, 'pending'>
  addressCount: number
  failedCount: number
  error: string | null
} {
  return {
    status: outcome.status,
    addressCount: outcome.recipients.length,
    failedCount: outcome.failedRecipients.length,
    error: outcome.error ? outcome.error.slice(0, 500) : null,
  }
}

/**
 * Envoie le message, paquet par paquet, à ses entreprises encore en attente.
 * Chaque entreprise passe par `notify()` : son envoi est journalisé, les
 * préférences de ses personnes s'appliquent. Une pause sépare deux paquets.
 *
 * Reprend aussi un envoi interrompu : les entreprises déjà servies ne sont
 * pas reprises, celles d'un paquet encore vivant non plus. Ne lève jamais :
 * lancée après la réponse (`after()`), elle rend le bilan aux tests.
 */
export async function sendBroadcast(broadcastId: string, options: SendBroadcastOptions = {}): Promise<BroadcastTally | null> {
  const tenantId = options.tenantId ?? currentTenantId()
  const size = options.batchSize ?? BROADCAST_BATCH_SIZE
  const pauseMs = options.pauseMs ?? BROADCAST_BATCH_PAUSE_MS
  try {
    const [broadcast] = await withTenant(
      tenantId,
      (tx) =>
        tx
          .select({ id: clientBroadcasts.id, subject: clientBroadcasts.subject, body: clientBroadcasts.body })
          .from(clientBroadcasts)
          .where(and(eq(clientBroadcasts.tenantId, tenantId), eq(clientBroadcasts.id, broadcastId))),
      options.database,
    )
    if (!broadcast) return null

    for (let first = true; ; first = false) {
      const batch = await claimBatch(broadcastId, size, tenantId, options.database)
      if (batch.rows.length === 0) break
      if (!first && pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs))
      for (const row of batch.rows) {
        const outcome = await notify(
          {
            event: 'client_broadcast',
            clientId: row.clientId,
            related: { type: 'client_broadcast', id: broadcastId },
            values: {
              client: row.clientName,
              objet: broadcast.subject,
              message: broadcast.body,
              lien: appUrl('/compte/preferences'),
            },
          },
          { database: options.database, send: options.send, tenantId },
        )
        const result = recipientOutcome(outcome)
        await withTenant(
          tenantId,
          (tx) =>
            tx
              .update(clientBroadcastRecipients)
              .set({ ...result, processedAt: new Date() })
              .where(
                and(
                  eq(clientBroadcastRecipients.tenantId, tenantId),
                  eq(clientBroadcastRecipients.id, row.id),
                  eq(clientBroadcastRecipients.claimToken, batch.token),
                  eq(clientBroadcastRecipients.status, 'pending'),
                ),
              ),
          options.database,
        )
      }
    }

    return await withTenant(
      tenantId,
      async (tx) => {
        const tally = tallyOf(await tallyRows(tx, tenantId, [broadcastId]).then((rows) => rows.get(broadcastId) ?? []))
        if (tally.pending === 0) {
          await tx
            .update(clientBroadcasts)
            .set({ completedAt: new Date() })
            .where(
              and(
                eq(clientBroadcasts.tenantId, tenantId),
                eq(clientBroadcasts.id, broadcastId),
                isNull(clientBroadcasts.completedAt),
              ),
            )
        }
        return tally
      },
      options.database,
    )
  } catch (error) {
    console.error(`Message aux clients ${broadcastId} : envoi interrompu`, error)
    return null
  }
}

type TallyRow = { status: BroadcastRecipientStatus; companies: number; addresses: number; failedAddresses: number }

/** Lignes du bilan de chaque message, par issue. */
async function tallyRows(
  tx: Transaction,
  tenantId: string,
  broadcastIds: readonly string[],
): Promise<Map<string, TallyRow[]>> {
  const result = new Map<string, TallyRow[]>()
  if (broadcastIds.length === 0) return result
  const rows = await tx
    .select({
      broadcastId: clientBroadcastRecipients.broadcastId,
      status: clientBroadcastRecipients.status,
      companies: sql<number>`count(*)`,
      addresses: sql<number>`coalesce(sum(${clientBroadcastRecipients.addressCount}), 0)`,
      failedAddresses: sql<number>`coalesce(sum(${clientBroadcastRecipients.failedCount}), 0)`,
    })
    .from(clientBroadcastRecipients)
    .where(
      and(
        eq(clientBroadcastRecipients.tenantId, tenantId),
        inArray(clientBroadcastRecipients.broadcastId, [...broadcastIds]),
      ),
    )
    .groupBy(clientBroadcastRecipients.broadcastId, clientBroadcastRecipients.status)
  for (const row of rows) {
    const list = result.get(row.broadcastId) ?? []
    list.push({
      status: row.status,
      companies: Number(row.companies),
      addresses: Number(row.addresses),
      failedAddresses: Number(row.failedAddresses),
    })
    result.set(row.broadcastId, list)
  }
  return result
}

export type BroadcastSummary = {
  id: string
  subject: string
  target: BroadcastTarget
  createdAt: Date
  completedAt: Date | null
  author: string
  tally: BroadcastTally
  /** Dernier mouvement de l'envoi : paquet pris, entreprise servie, ou création. */
  lastActivity: Date
}

/** Historique des messages envoyés, les plus récents d'abord. */
export async function listBroadcasts(
  page: { number: number; size: number } = { number: 1, size: 50 },
  options: Options = {},
): Promise<{ rows: BroadcastSummary[]; total: number }> {
  const tenantId = options.tenantId ?? currentTenantId()
  return withTenant(
    tenantId,
    async (tx) => {
      const [counted] = await tx
        .select({ total: sql<number>`count(*)` })
        .from(clientBroadcasts)
        .where(eq(clientBroadcasts.tenantId, tenantId))
      const rows = await tx
        .select({
          id: clientBroadcasts.id,
          subject: clientBroadcasts.subject,
          target: clientBroadcasts.target,
          createdAt: clientBroadcasts.createdAt,
          completedAt: clientBroadcasts.completedAt,
          authorName: staffMembers.fullName,
          authorEmail: staffMembers.email,
        })
        .from(clientBroadcasts)
        .innerJoin(staffMembers, eq(staffMembers.id, clientBroadcasts.createdBy))
        .where(eq(clientBroadcasts.tenantId, tenantId))
        .orderBy(desc(clientBroadcasts.createdAt), desc(clientBroadcasts.id))
        .limit(page.size)
        .offset((page.number - 1) * page.size)
      const ids = rows.map((row) => row.id)
      const tallies = await tallyRows(tx, tenantId, ids)
      const activity = await lastActivities(tx, tenantId, ids)
      return {
        total: Number(counted?.total ?? 0),
        rows: rows.map(({ authorName, authorEmail, ...row }) => ({
          ...row,
          author: authorName?.trim() || authorEmail,
          tally: tallyOf(tallies.get(row.id) ?? []),
          lastActivity: latest(row.createdAt, activity.get(row.id)),
        })),
      }
    },
    options.database,
  )
}

const latest = (a: Date, b: Date | null | undefined) => (b && b > a ? b : a)

async function lastActivities(
  tx: Transaction,
  tenantId: string,
  broadcastIds: readonly string[],
): Promise<Map<string, Date | null>> {
  if (broadcastIds.length === 0) return new Map()
  const rows = await tx
    .select({
      broadcastId: clientBroadcastRecipients.broadcastId,
      claimed: max(clientBroadcastRecipients.claimedAt),
      processed: max(clientBroadcastRecipients.processedAt),
    })
    .from(clientBroadcastRecipients)
    .where(
      and(
        eq(clientBroadcastRecipients.tenantId, tenantId),
        inArray(clientBroadcastRecipients.broadcastId, [...broadcastIds]),
      ),
    )
    .groupBy(clientBroadcastRecipients.broadcastId)
  return new Map(
    rows.map((row) => {
      const claimed = row.claimed ? new Date(row.claimed) : null
      const processed = row.processed ? new Date(row.processed) : null
      return [row.broadcastId, claimed && processed ? latest(claimed, processed) : (claimed ?? processed)]
    }),
  )
}

export type BroadcastRecipientRow = {
  clientId: string
  clientName: string
  status: BroadcastRecipientStatus
  addressCount: number
  failedCount: number
  error: string | null
  processedAt: Date | null
}

export type BroadcastDetail = BroadcastSummary & {
  body: string
  recipients: BroadcastRecipientRow[]
}

/** Un message, son texte et l'issue de chaque entreprise ; `undefined` s'il n'est pas du centre. */
export async function findBroadcast(id: string, options: Options = {}): Promise<BroadcastDetail | undefined> {
  const tenantId = options.tenantId ?? currentTenantId()
  return withTenant(
    tenantId,
    async (tx) => {
      const [row] = await tx
        .select({
          id: clientBroadcasts.id,
          subject: clientBroadcasts.subject,
          body: clientBroadcasts.body,
          target: clientBroadcasts.target,
          createdAt: clientBroadcasts.createdAt,
          completedAt: clientBroadcasts.completedAt,
          authorName: staffMembers.fullName,
          authorEmail: staffMembers.email,
        })
        .from(clientBroadcasts)
        .innerJoin(staffMembers, eq(staffMembers.id, clientBroadcasts.createdBy))
        .where(and(eq(clientBroadcasts.tenantId, tenantId), eq(clientBroadcasts.id, id)))
      if (!row) return undefined
      const recipients = await tx
        .select({
          clientId: clientBroadcastRecipients.clientId,
          clientName: clients.name,
          status: clientBroadcastRecipients.status,
          addressCount: clientBroadcastRecipients.addressCount,
          failedCount: clientBroadcastRecipients.failedCount,
          error: clientBroadcastRecipients.error,
          processedAt: clientBroadcastRecipients.processedAt,
        })
        .from(clientBroadcastRecipients)
        .innerJoin(
          clients,
          and(eq(clients.tenantId, clientBroadcastRecipients.tenantId), eq(clients.id, clientBroadcastRecipients.clientId)),
        )
        .where(and(eq(clientBroadcastRecipients.tenantId, tenantId), eq(clientBroadcastRecipients.broadcastId, id)))
        .orderBy(asc(clients.name), asc(clientBroadcastRecipients.id))
      const tallies = await tallyRows(tx, tenantId, [id])
      const activity = await lastActivities(tx, tenantId, [id])
      const { authorName, authorEmail, ...broadcast } = row
      return {
        ...broadcast,
        author: authorName?.trim() || authorEmail,
        tally: tallyOf(tallies.get(id) ?? []),
        lastActivity: latest(row.createdAt, activity.get(id)),
        recipients,
      }
    },
    options.database,
  )
}
