import { and, asc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm'

import { withTenant, type Database } from '../../db/index.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { uuidv7 } from '../../lib/uuid.ts'
import { clients } from '../clients/schema.ts'
import { contracts } from '../contrats/schema.ts'
import { resources } from '../ressources/schema.ts'
import type { ScanFile } from './fichiers.ts'
import { discard, scanRows, store, type StoredScan } from './queries.ts'
import { pairEnvelopes, type MailCount } from './saisie-groupee-regles.ts'
import { mailItems, mailScans } from './schema.ts'
import { inOpenBatch } from './tournees.ts'

/**
 * Saisie groupée du courrier : l'accueil trie la tournée, puis dit en un seul
 * envoi combien de plis chaque entreprise a reçus. Les plis entrent dans la
 * tournée ouverte comme ceux du formulaire pli par pli (ADR 044) : personne
 * n'est prévenu avant la fin de la tournée.
 */

export type MailRecipient = {
  id: string
  name: string
  /** Contrat de domiciliation en cours ce jour-là. */
  domiciled: boolean
  /** Code de la boîte aux lettres attribuée par ce contrat, s'il y en a une. */
  mailbox: string | null
}

/**
 * Entreprises à qui l'on peut enregistrer du courrier : toutes les fiches
 * vivantes, les domiciliés d'abord (ce sont eux qui reçoivent presque tout),
 * puis par nom.
 */
export async function listMailRecipients(day: string, database?: Database): Promise<MailRecipient[]> {
  const tenantId = currentTenantId()
  const rows = await withTenant(
    tenantId,
    (tx) =>
      tx
        .select({
          id: clients.id,
          name: clients.name,
          domiciled: sql<number>`max(${contracts.id} is not null)`,
          mailbox: sql<string | null>`min(${resources.code})`,
        })
        .from(clients)
        .leftJoin(
          contracts,
          and(
            eq(contracts.tenantId, tenantId),
            eq(contracts.clientId, clients.id),
            eq(contracts.contractType, 'domiciliation'),
            eq(contracts.status, 'active'),
            isNull(contracts.deletedAt),
            lte(contracts.startsOn, day),
            or(isNull(contracts.endsOn), gte(contracts.endsOn, day)),
          ),
        )
        .leftJoin(
          resources,
          and(
            eq(resources.tenantId, tenantId),
            eq(resources.id, contracts.resourceId),
            eq(resources.resourceType, 'boite_aux_lettres'),
          ),
        )
        .where(and(eq(clients.tenantId, tenantId), isNull(clients.deletedAt)))
        .groupBy(clients.id, clients.name)
        .orderBy(sql`max(${contracts.id} is not null) desc`, asc(clients.name)),
    database,
  )
  return rows.map((row) => ({ ...row, domiciled: Number(row.domiciled) === 1 }))
}

/** Levée quand une entreprise de la saisie n'existe plus (archivée entre-temps). */
export class UnknownRecipientError extends Error {
  readonly clientIds: string[]
  constructor(clientIds: string[]) {
    super('Une entreprise de la saisie a été archivée entre-temps.')
    this.name = 'UnknownRecipientError'
    this.clientIds = clientIds
  }
}

/** Levée quand une photo d'enveloppe n'a pas pu être déposée : rien n'est enregistré. */
export class EnvelopeStorageError extends Error {
  constructor(cause: unknown) {
    super('Une photo d’enveloppe n’a pas pu être déposée.', { cause })
    this.name = 'EnvelopeStorageError'
  }
}

/**
 * Saisie avec les photos des enveloppes (ADR 055) : chaque photo est déposée,
 * chiffrée, avant toute écriture en base, comme à l'enregistrement d'un pli.
 * Si l'enregistrement échoue ensuite, les fichiers déposés sont effacés.
 */
export async function registerMailCountsWithEnvelopes(
  counts: MailCount[],
  receivedAt: Date,
  staffMemberId: string,
  photos: Map<string, ScanFile[]>,
): Promise<{ items: number; clients: number; envelopes: number }> {
  const tenantId = currentTenantId()
  const envelopes = new Map<string, StoredScan[]>()
  const stored: StoredScan[] = []
  try {
    for (const [clientId, files] of photos) {
      const own: StoredScan[] = []
      for (const envelope of files) {
        let scan: StoredScan
        try {
          ;[scan] = await store(tenantId, { envelope })
        } catch (error) {
          throw new EnvelopeStorageError(error)
        }
        stored.push(scan)
        own.push(scan)
      }
      envelopes.set(clientId, own)
    }
    return await registerMailCounts(counts, receivedAt, staffMemberId, undefined, envelopes)
  } catch (error) {
    await discard(stored)
    throw error
  }
}

/**
 * Enregistre tous les plis de la saisie dans la tournée ouverte, en une seule
 * transaction : tout entre, ou rien. Rend le nombre de plis, d'entreprises et
 * de photos d'enveloppe. Les plis sont fermés, sans expéditeur ; chacun reçoit
 * la photo de son enveloppe si elle a été jointe (`pairEnvelopes`), déjà
 * déposée au stockage. La fiche de chacun se complète ensuite si besoin.
 */
export async function registerMailCounts(
  counts: MailCount[],
  receivedAt: Date,
  staffMemberId: string,
  database?: Database,
  envelopes: Map<string, StoredScan[]> = new Map(),
): Promise<{ items: number; clients: number; envelopes: number }> {
  const tenantId = currentTenantId()
  const clientIds = [...new Set(counts.map((entry) => entry.clientId))]
  const items = pairEnvelopes(counts, envelopes).map((item) => ({ ...item, id: uuidv7() }))
  if (items.length === 0) return { items: 0, clients: 0, envelopes: 0 }
  const photographed = items.filter((item) => item.envelope !== undefined)

  return inOpenBatch(
    staffMemberId,
    async (tx, batchId) => {
      const live = await tx
        .select({ id: clients.id })
        .from(clients)
        .where(and(eq(clients.tenantId, tenantId), inArray(clients.id, clientIds), isNull(clients.deletedAt)))
      const known = new Set(live.map((row) => row.id))
      const missing = clientIds.filter((id) => !known.has(id))
      if (missing.length > 0) throw new UnknownRecipientError(missing)

      await tx.insert(mailItems).values(
        items.map((item) => ({
          id: item.id,
          clientId: item.clientId,
          kind: item.kind,
          sender: null,
          note: null,
          receivedAt,
          batchId,
          registeredBy: staffMemberId,
          status: 'received' as const,
        })),
      )
      if (photographed.length > 0) {
        await tx
          .insert(mailScans)
          .values(photographed.flatMap((item) => scanRows(item.id, [item.envelope as StoredScan], staffMemberId)))
      }
      return { items: items.length, clients: clientIds.length, envelopes: photographed.length }
    },
    database,
  )
}
