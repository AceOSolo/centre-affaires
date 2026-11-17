import { and, desc, eq, gte, isNotNull, isNull, sql } from 'drizzle-orm'

import { maintenant } from '../../db/columns.ts'
import { withTenant, type Database, type Transaction } from '../../db/index.ts'
import { tenants } from '../../db/tenants.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { isUuid } from '../../lib/uuid.ts'
import {
  currentSenderList,
  frequentMissing,
  knownSenders,
  MAX_SUGGESTED_SENDERS,
  senderSuggestions,
  type SenderList,
  type SenderSuggestions,
  type SenderUse,
} from './expediteurs.ts'
import { MailStateError } from './queries.ts'
import { mailItems } from './schema.ts'

/**
 * Expéditeurs déjà saisis (ADR 058), lus sur `mail_items.sender` : pas de
 * table à part. Un pli retiré n'en propose pas ; un expéditeur anonymisé avec
 * la fiche de son client (ADR 040) n'existe plus.
 */

/** Deux ans de courrier suffisent à dire qui écrit au centre. */
const SENDER_WINDOW_DAYS = 730
/** Garde-fou : les couples entreprise × expéditeur les plus fréquents. */
const MAX_SENDER_ROWS = 5000

async function senderUses(database?: Database): Promise<SenderUse[]> {
  const tenantId = currentTenantId()
  const rows = await withTenant(
    tenantId,
    (tx) =>
      tx
        .select({
          clientId: mailItems.clientId,
          sender: mailItems.sender,
          uses: sql<number>`count(*)`,
          lastAt: sql<Date>`max(${mailItems.receivedAt})`,
        })
        .from(mailItems)
        .where(
          and(
            eq(mailItems.tenantId, tenantId),
            isNotNull(mailItems.sender),
            isNull(mailItems.deletedAt),
            gte(mailItems.receivedAt, sql`${maintenant()} - interval ${SENDER_WINDOW_DAYS} day`),
          ),
        )
        .groupBy(mailItems.clientId, mailItems.sender)
        .orderBy(desc(sql`count(*)`))
        .limit(MAX_SENDER_ROWS),
    database,
  )
  return rows.map((row) => ({
    clientId: row.clientId,
    sender: row.sender as string,
    uses: Number(row.uses),
    lastAt: row.lastAt instanceof Date ? row.lastAt : new Date(row.lastAt),
  }))
}

/** La liste réglée par le centre (ADR 079) ; `null` tant qu'il n'y a pas touché. */
async function readSenderList(tx: Transaction, tenantId: string): Promise<SenderList> {
  const [tenant] = await tx
    .select({ list: tenants.mailSuggestedSenders })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1)
  const list = tenant?.list
  return Array.isArray(list) ? list.filter((sender): sender is string => typeof sender === 'string') : null
}

async function suggestedSenderList(database?: Database): Promise<SenderList> {
  const tenantId = currentTenantId()
  return withTenant(tenantId, (tx) => readSenderList(tx, tenantId), database)
}

/** Suggestions d'expéditeurs pour les entreprises d'un écran, et celles du centre. */
export async function findSenderSuggestions(
  clientIds: readonly string[],
  database?: Database,
): Promise<SenderSuggestions> {
  const [uses, list] = await Promise.all([senderUses(database), suggestedSenderList(database)])
  return senderSuggestions(uses, clientIds.filter(isUuid), list)
}

/** Toutes les écritures connues au centre, pour ramener une saisie à la sienne (`canonicalSender`). */
export async function findKnownSenders(database?: Database): Promise<string[]> {
  const [uses, list] = await Promise.all([senderUses(database), suggestedSenderList(database)])
  return knownSenders(uses, list)
}

/** L'écran du réglage : la liste proposée aujourd'hui, et ce qu'on pourrait y ajouter. */
export type SenderListSettings = {
  /** La liste telle que l'accueil la voit : réglée, ou celle du code. */
  list: string[]
  /** Le centre l'a-t-il déjà réglée ? */
  customized: boolean
  /** Souvent saisis au centre, absents de la liste. */
  frequentMissing: string[]
}

export async function findSenderListSettings(database?: Database): Promise<SenderListSettings> {
  const [uses, list] = await Promise.all([senderUses(database), suggestedSenderList(database)])
  const current = currentSenderList(uses, list)
  return { list: current, customized: list !== null, frequentMissing: frequentMissing(uses, current) }
}

/**
 * Enregistre la liste du centre, déjà lue (`readSenderList`), ou revient à
 * celle du code (`null`). La base tient le plafond (`tenants_mail_suggested_senders_valid`).
 */
export async function saveSenderList(list: readonly string[] | null, database?: Database): Promise<void> {
  if (list && list.length > MAX_SUGGESTED_SENDERS) {
    throw new Error(`Au plus ${MAX_SUGGESTED_SENDERS} expéditeurs dans la liste.`)
  }
  const tenantId = currentTenantId()
  await withTenant(
    tenantId,
    (tx) =>
      tx
        .update(tenants)
        .set({ mailSuggestedSenders: list === null ? null : [...list] })
        .where(eq(tenants.id, tenantId)),
    database,
  )
}

/**
 * Expéditeur précisé ou corrigé après l'enregistrement (ADR 058), depuis la
 * fiche du pli ou la tournée. `null` l'efface. Le client le voit aussitôt
 * dans son espace, sans nouveau message.
 *
 * Refusé pour un pli retiré (sa trace reste telle quelle, décision 6) et pour
 * un pli dont l'expéditeur a été anonymisé avec la fiche du client (ADR 040) :
 * la base le refuserait aussi (`mail_items_sender_anonymized`).
 */
export async function updateMailSender(id: string, sender: string | null, database?: Database): Promise<void> {
  if (!isUuid(id)) throw new MailStateError('Courrier introuvable.')
  const tenantId = currentTenantId()
  await withTenant(
    tenantId,
    async (tx) => {
      const [item] = await tx
        .select({ deletedAt: mailItems.deletedAt, anonymizedAt: mailItems.senderAnonymizedAt })
        .from(mailItems)
        .where(and(eq(mailItems.tenantId, tenantId), eq(mailItems.id, id)))
        .limit(1)
        .for('update')
      if (!item) throw new MailStateError('Courrier introuvable.')
      if (item.deletedAt) throw new MailStateError('Ce courrier a été retiré : son expéditeur ne se modifie plus.')
      if (item.anonymizedAt) {
        throw new MailStateError(
          'L’expéditeur de ce courrier a été effacé avec les données du client (RGPD) : il ne se saisit plus.',
        )
      }
      await tx
        .update(mailItems)
        .set({ sender })
        .where(and(eq(mailItems.tenantId, tenantId), eq(mailItems.id, id)))
    },
    database,
  )
}
