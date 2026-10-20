import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from 'drizzle-orm'

import { maintenant } from '../../db/columns.ts'
import { DB_MAIL_REFUSED, dbErrorCode } from '../../db/errors.ts'
import { withTenant, type Database, type Transaction } from '../../db/index.ts'
import { staffMembers } from '../../db/staff.ts'
import { tenants } from '../../db/tenants.ts'
import { dayRangeUtc, toIsoDate } from '../../lib/dates.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { uuidv7 } from '../../lib/uuid.ts'
import { clients } from '../clients/schema.ts'
import { contracts } from '../contrats/schema.ts'
import { mailBatches, mailItems, type MailKind } from './schema.ts'
import { batchMessages, type BatchMessages } from './tournees-regles.ts'

/**
 * Tournées du courrier (ADR 044) : l'accueil enregistre le courrier du jour
 * dans la tournée ouverte, puis la termine ; c'est alors seulement que les
 * domiciliés sont prévenus, un message par entreprise.
 */

/** Levée quand la tournée a été terminée entre-temps (un collègue l'a close). */
export class MailBatchClosedError extends Error {
  constructor() {
    super('Cette tournée vient d’être terminée. Le courrier suivant ouvre une nouvelle tournée.')
    this.name = 'MailBatchClosedError'
  }
}

/**
 * Levée quand l'accueil signale qu'aucun courrier n'est arrivé alors qu'un
 * collègue vient d'ouvrir une tournée : du courrier est en cours
 * d'enregistrement, elle ne se termine pas à sa place.
 */
export class MailBatchOpenedError extends Error {
  constructor() {
    super(
      'Une tournée vient d’être ouverte par un collègue : du courrier est en cours d’enregistrement. Rechargez la page pour la voir ; elle se termine depuis son récapitulatif.',
    )
    this.name = 'MailBatchOpenedError'
  }
}

/** La tournée ouverte, en la créant au besoin. Dans la transaction appelante. */
export async function ensureOpenBatch(tx: Transaction, staffMemberId: string): Promise<string> {
  const open = async () => {
    const [row] = await tx
      .select({ id: mailBatches.id })
      .from(mailBatches)
      .where(isNull(mailBatches.closedAt))
      .limit(1)
    return row?.id
  }
  const existing = await open()
  if (existing) return existing
  // Deux collègues qui commencent la tournée en même temps : l'index unique
  // `mail_batches_open_key` n'en garde qu'une, l'autre insertion ne fait rien.
  await tx
    .insert(mailBatches)
    .values({ id: uuidv7(), openedBy: staffMemberId })
    .onDuplicateKeyUpdate({ set: { id: sql`id` } })
  const created = await open()
  if (!created) throw new Error('Tournée du courrier introuvable après sa création.')
  return created
}

/**
 * Exécute `run` avec l'identifiant de la tournée ouverte. Si la tournée est
 * terminée entre la lecture et l'écriture du pli (`CA017`), l'enregistrement
 * est rejoué une fois dans la tournée suivante.
 */
export async function inOpenBatch<T>(
  staffMemberId: string,
  run: (tx: Transaction, batchId: string) => Promise<T>,
  database?: Database,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await withTenant(
        currentTenantId(),
        async (tx) => run(tx, await ensureOpenBatch(tx, staffMemberId)),
        database,
      )
    } catch (error) {
      if (attempt === 0 && dbErrorCode(error) === DB_MAIL_REFUSED) continue
      throw error
    }
  }
}

export type OpenBatchItem = {
  id: string
  clientName: string
  kind: MailKind
  receivedAt: Date
  opened: boolean
}

export type OpenBatch = {
  id: string
  openedAt: Date
  openedByName: string | null
  items: OpenBatchItem[]
  clientCount: number
}

/** La tournée ouverte et ses plis (retirés exclus), ou rien. */
export async function findOpenBatch(): Promise<OpenBatch | undefined> {
  return withTenant(currentTenantId(), async (tx) => {
    const [batch] = await tx
      .select({
        id: mailBatches.id,
        openedAt: mailBatches.openedAt,
        openedByName: sql<string | null>`coalesce(${staffMembers.fullName}, ${staffMembers.email})`,
      })
      .from(mailBatches)
      .leftJoin(staffMembers, eq(staffMembers.id, mailBatches.openedBy))
      .where(isNull(mailBatches.closedAt))
      .limit(1)
    if (!batch) return undefined
    const items = await tx
      .select({
        id: mailItems.id,
        clientId: mailItems.clientId,
        clientName: clients.name,
        kind: mailItems.kind,
        receivedAt: mailItems.receivedAt,
        openedAt: mailItems.openedAt,
      })
      .from(mailItems)
      .innerJoin(clients, eq(clients.id, mailItems.clientId))
      .where(and(eq(mailItems.batchId, batch.id), isNull(mailItems.deletedAt)))
      .orderBy(asc(clients.name), asc(mailItems.receivedAt))
    return {
      ...batch,
      items: items.map((item) => ({
        id: item.id,
        clientName: item.clientName,
        kind: item.kind,
        receivedAt: item.receivedAt,
        opened: item.openedAt !== null,
      })),
      clientCount: new Set(items.map((item) => item.clientId)).size,
    }
  })
}

/**
 * Domiciliés d'un jour du centre : entreprises vivantes qui ont un contrat de
 * domiciliation en cours ce jour-là.
 */
async function domiciledClientIds(tx: Transaction, day: string): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ clientId: contracts.clientId })
    .from(contracts)
    .innerJoin(clients, eq(clients.id, contracts.clientId))
    .where(
      and(
        eq(contracts.contractType, 'domiciliation'),
        eq(contracts.status, 'active'),
        isNull(contracts.deletedAt),
        lte(contracts.startsOn, day),
        or(isNull(contracts.endsOn), gte(contracts.endsOn, day)),
        isNull(clients.deletedAt),
      ),
    )
  return rows.map((row) => row.clientId)
}

export type BatchRecipients = BatchMessages & {
  /** Jour du centre de la tournée (celui de sa fin, ou d'aujourd'hui tant qu'elle est ouverte). */
  day: string
  timeZone: string
  /** Une tournée terminée plus tôt le même jour a déjà prévenu les domiciliés sans courrier. */
  firstOfDay: boolean
  clientNames: Map<string, string>
}

/**
 * Qui sera (ou a été) prévenu en fin de tournée, et de quoi. Pour une tournée
 * ouverte, l'aperçu au moment présent ; pour une tournée terminée, l'état à sa
 * fin — c'est ce qui part. Sans tournée (`null`) : ce que signalerait une
 * tournée terminée vide maintenant.
 */
export async function batchRecipients(batchId: string | null, database?: Database): Promise<BatchRecipients> {
  return withTenant(
    currentTenantId(),
    async (tx) => {
      const [tenant] = await tx
        .select({ timeZone: tenants.timezone })
        .from(tenants)
        .where(eq(tenants.id, currentTenantId()))
      const timeZone = tenant?.timeZone ?? 'Europe/Paris'
      const [found] = batchId
        ? await tx
            .select({ id: mailBatches.id, closedAt: mailBatches.closedAt })
            .from(mailBatches)
            .where(eq(mailBatches.id, batchId))
        : [{ id: null, closedAt: null }]
      if (!found) throw new Error('Tournée du courrier introuvable.')
      const batch = found as { id: string | null; closedAt: Date | null }
      const at = batch.closedAt ?? new Date()
      const day = toIsoDate(at, timeZone)
      const { startsAt } = dayRangeUtc(day, timeZone)

      const [earlier] = await tx
        .select({ id: mailBatches.id })
        .from(mailBatches)
        .where(
          and(
            batch.id ? ne(mailBatches.id, batch.id) : undefined,
            isNotNull(mailBatches.closedAt),
            gte(mailBatches.closedAt, startsAt),
            batch.closedAt ? lt(mailBatches.closedAt, batch.closedAt) : undefined,
          ),
        )
        .limit(1)
      const firstOfDay = !earlier

      const items = batch.id
        ? await tx
            .select({ clientId: mailItems.clientId, kind: mailItems.kind, openedAt: mailItems.openedAt })
            .from(mailItems)
            .where(and(eq(mailItems.batchId, batch.id), isNull(mailItems.deletedAt)))
        : []
      const domiciled = await domiciledClientIds(tx, day)
      const messages = batchMessages(
        items.map((item) => ({ clientId: item.clientId, kind: item.kind, opened: item.openedAt !== null })),
        domiciled,
        firstOfDay,
      )
      const ids = [...messages.received.map((entry) => entry.clientId), ...messages.none]
      const names = ids.length
        ? await tx.select({ id: clients.id, name: clients.name }).from(clients).where(inArray(clients.id, ids))
        : []
      return {
        ...messages,
        day,
        timeZone,
        firstOfDay,
        clientNames: new Map(names.map((row) => [row.id, row.name])),
      }
    },
    database,
  )
}

/**
 * Termine la tournée que l'écran montrait et rend son identifiant.
 *
 * `expectedBatchId` nul : l'écran ne montrait aucune tournée, l'accueil
 * signale qu'aucun courrier n'est arrivé. Une tournée vide est ouverte et
 * terminée, et les domiciliés en sont prévenus — sauf si un collègue a ouvert
 * une tournée entre-temps : rien n'est alors terminé (`MailBatchOpenedError`).
 *
 * La ligne de la tournée est verrouillée : un pli en cours d'enregistrement
 * finit d'entrer avant, ou entre dans la tournée suivante (`CA017`).
 */
export async function closeOpenBatch(staffMemberId: string, expectedBatchId: string | null): Promise<string> {
  return withTenant(currentTenantId(), async (tx) => {
    const [open] = await tx
      .select({ id: mailBatches.id })
      .from(mailBatches)
      .where(isNull(mailBatches.closedAt))
      .limit(1)
      .for('update')
    let batchId: string
    if (expectedBatchId === null) {
      // Une tournée ouverte depuis l'affichage : du courrier est en cours
      // d'enregistrement, « pas de courrier » serait faux pour ses domiciliés.
      if (open) throw new MailBatchOpenedError()
      batchId = uuidv7()
      // Un pli enregistré au même instant ouvre la sienne : l'index unique
      // `mail_batches_open_key` la garde, cette insertion ne fait rien et la
      // tournée vide n'existe pas.
      await tx
        .insert(mailBatches)
        .values({ id: batchId, openedBy: staffMemberId })
        .onDuplicateKeyUpdate({ set: { id: sql`id` } })
      const [created] = await tx.select({ id: mailBatches.id }).from(mailBatches).where(eq(mailBatches.id, batchId))
      if (!created) throw new MailBatchOpenedError()
    } else {
      // L'écran montrait une tournée qu'un collègue a déjà terminée : ne pas
      // terminer à sa place la suivante, qu'il n'a pas vue.
      if (open?.id !== expectedBatchId) throw new MailBatchClosedError()
      batchId = open.id
    }
    // La date de fin est posée par la base (`mail_batches_before_update`).
    await tx
      .update(mailBatches)
      .set({ closedAt: maintenant(), closedBy: staffMemberId })
      .where(and(eq(mailBatches.id, batchId), isNull(mailBatches.closedAt)))
    return batchId
  })
}

export type BatchSummary = {
  id: string
  openedAt: Date
  closedAt: Date | null
  closedByName: string | null
  itemCount: number
  clientCount: number
}

/** Dernières tournées terminées, la plus récente d'abord. */
export async function listRecentBatches(limit = 10): Promise<BatchSummary[]> {
  const rows = await withTenant(currentTenantId(), (tx) =>
    tx
      .select({
        id: mailBatches.id,
        openedAt: mailBatches.openedAt,
        closedAt: mailBatches.closedAt,
        closedByName: sql<string | null>`coalesce(${staffMembers.fullName}, ${staffMembers.email})`,
        itemCount: sql<number>`count(${mailItems.id})`,
        clientCount: sql<number>`count(distinct ${mailItems.clientId})`,
      })
      .from(mailBatches)
      .leftJoin(staffMembers, eq(staffMembers.id, mailBatches.closedBy))
      .leftJoin(mailItems, and(eq(mailItems.batchId, mailBatches.id), isNull(mailItems.deletedAt)))
      .where(isNotNull(mailBatches.closedAt))
      .groupBy(mailBatches.id, staffMembers.fullName, staffMembers.email)
      .orderBy(desc(mailBatches.closedAt))
      .limit(limit),
  )
  return rows.map((row) => ({ ...row, itemCount: Number(row.itemCount), clientCount: Number(row.clientCount) }))
}
