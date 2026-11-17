import { and, asc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm'

import { maintenant } from '../../db/columns.ts'
import { DB_MAIL_REQUEST_REFUSED, DB_MAIL_TEAM_REFUSED, dbErrorCode, dbSignalMessage } from '../../db/errors.ts'
import { withTenant, type Database, type Transaction } from '../../db/index.ts'
import { updateReturning } from '../../db/returning.ts'
import { staffMembers } from '../../db/staff.ts'
import { deleteObject } from '../../lib/stockage.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { isUuid, uuidv7 } from '../../lib/uuid.ts'
import { pendingRequestStatuses } from './demandes-regles.ts'
import type { ScanFile } from './fichiers.ts'
import { discard, MailStateError, scanRows, store, type StoredScan } from './queries.ts'
import { mailItems, mailRequests, mailScans, type MailRequestKind } from './schema.ts'

/**
 * Contenu numérisé **à valider** avant d'être montré au client (ADR 079).
 *
 * L'accueil dépose le contenu d'une ouverture — demandée par le client, ou
 * d'office — ou d'une numérisation demandée : la ligne de `mail_scans` naît
 * « à valider » (`pending_validation`), invisible de l'espace client. Il la
 * relit dans l'aperçu, la remplace au besoin (le dépôt précédent est purgé :
 * fichier effacé, ligne gardée), puis la valide. La validation fait le geste
 * qu'elle publie — le pli est ouvert, ou la numérisation demandée faite — dans
 * la même transaction ; l'action prévient alors le client, et seulement alors.
 *
 * Un dépôt appartient à une **place** : celle de l'ouverture du pli (contenu
 * d'office, ou d'une demande d'ouverture), ou celle d'une numérisation
 * demandée. Un nouveau dépôt remplace celui de sa place.
 *
 * La base tient le reste (`64-courrier-equipe.sql`, `CA025`) : pas de dépôt
 * sur un pli retiré ni pour une demande close, pas de retour en arrière, pas
 * de validation sans le geste.
 */

/** Ce que la validation publie : l'ouverture du pli, ou une numérisation demandée. */
export type DraftPurpose = 'opening' | 'scan'

/** Un dépôt à valider, tel que l'écran de l'accueil le montre. */
export type ContentDraft = {
  id: string
  mailItemId: string
  mailRequestId: string | null
  purpose: DraftPurpose
  contentType: string
  byteSize: number
  pageCount: number | null
  createdAt: Date
  uploadedByName: string | null
}

/** Dépôts à valider d'un pli, du plus ancien au plus récent : un par place au plus. */
export async function findContentDrafts(mailItemId: string, database?: Database): Promise<ContentDraft[]> {
  if (!isUuid(mailItemId)) return []
  const tenantId = currentTenantId()
  const rows = await withTenant(
    tenantId,
    (tx) =>
      tx
        .select({
          id: mailScans.id,
          mailItemId: mailScans.mailItemId,
          mailRequestId: mailScans.mailRequestId,
          requestKind: mailRequests.kind,
          contentType: mailScans.contentType,
          byteSize: mailScans.byteSize,
          pageCount: mailScans.pageCount,
          createdAt: mailScans.createdAt,
          uploadedByName: sql<string | null>`coalesce(${staffMembers.fullName}, ${staffMembers.email})`,
        })
        .from(mailScans)
        .leftJoin(
          mailRequests,
          and(eq(mailRequests.tenantId, mailScans.tenantId), eq(mailRequests.id, mailScans.mailRequestId)),
        )
        .leftJoin(staffMembers, eq(staffMembers.id, mailScans.uploadedBy))
        .where(
          and(
            eq(mailScans.tenantId, tenantId),
            eq(mailScans.mailItemId, mailItemId),
            eq(mailScans.pendingValidation, true),
            isNull(mailScans.deletedAt),
          ),
        )
        .orderBy(asc(mailScans.createdAt)),
    database,
  )
  return rows.map(({ requestKind, ...row }) => ({
    ...row,
    purpose: draftPurpose(requestKind),
    pageCount: row.pageCount === null ? null : Number(row.pageCount),
  }))
}

/** Place d'un dépôt : une numérisation demandée, sinon l'ouverture du pli. */
export function draftPurpose(requestKind: MailRequestKind | null): DraftPurpose {
  return requestKind === 'scan' ? 'scan' : 'opening'
}

/** Refus de la base (`CA025`, `CA008`) dit en français, comme les autres erreurs d'état. */
async function stated<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    const code = dbErrorCode(error)
    if (code === DB_MAIL_TEAM_REFUSED || code === DB_MAIL_REQUEST_REFUSED) {
      throw new MailStateError(dbSignalMessage(error) ?? 'La base a refusé cette étape : rechargez la page.')
    }
    throw error
  }
}

const MOVED = 'Cette demande a changé d’état entre-temps : rechargez la page.'

type LockedRequest = { id: string; kind: MailRequestKind; status: string }

/** La demande d'ouverture en cours du pli, verrouillée : le client ne l'annule pas pendant ce temps. */
async function pendingOpeningRequest(tx: Transaction, mailItemId: string): Promise<LockedRequest | undefined> {
  const [request] = await tx
    .select({ id: mailRequests.id, kind: mailRequests.kind, status: mailRequests.status })
    .from(mailRequests)
    .where(
      and(
        eq(mailRequests.mailItemId, mailItemId),
        eq(mailRequests.kind, 'open_and_scan'),
        inArray(mailRequests.status, [...pendingRequestStatuses]),
      ),
    )
    .limit(1)
    .for('update')
  return request
}

/** Une demande encore « déposée » passe « validée » : le travail commence, le client ne l'annule plus. */
async function startIfRequested(tx: Transaction, request: LockedRequest, staffMemberId: string): Promise<void> {
  if (request.status !== 'requested') return
  await tx
    .update(mailRequests)
    .set({ status: 'in_progress', startedByStaffId: staffMemberId })
    .where(and(eq(mailRequests.id, request.id), eq(mailRequests.status, 'requested')))
}

/**
 * Dépôts vivants de la place d'un dépôt : ceux d'une numérisation demandée,
 * ou ceux de l'ouverture du pli (d'office, ou d'une demande d'ouverture).
 */
async function liveDraftsOfPlace(
  tx: Transaction,
  mailItemId: string,
  place: { purpose: 'scan'; requestId: string } | { purpose: 'opening' },
): Promise<{ id: string; storageKey: string }[]> {
  return tx
    .select({ id: mailScans.id, storageKey: mailScans.storageKey })
    .from(mailScans)
    .leftJoin(
      mailRequests,
      and(eq(mailRequests.tenantId, mailScans.tenantId), eq(mailRequests.id, mailScans.mailRequestId)),
    )
    .where(
      and(
        eq(mailScans.mailItemId, mailItemId),
        eq(mailScans.side, 'content'),
        eq(mailScans.pendingValidation, true),
        isNull(mailScans.deletedAt),
        place.purpose === 'scan'
          ? eq(mailScans.mailRequestId, place.requestId)
          : or(isNull(mailScans.mailRequestId), eq(mailRequests.kind, 'open_and_scan')),
      ),
    )
    .for('update')
}

/** Purge des dépôts remplacés ou abandonnés : la ligne reste, le fichier part après la transaction. */
async function purgeDrafts(tx: Transaction, drafts: { id: string; storageKey: string }[]): Promise<string[]> {
  if (drafts.length === 0) return []
  await tx
    .update(mailScans)
    .set({ deletedAt: maintenant() })
    .where(and(inArray(mailScans.id, drafts.map((draft) => draft.id)), isNull(mailScans.deletedAt)))
  return drafts.map((draft) => draft.storageKey)
}

const removeFiles = async (keys: string[]) => {
  await Promise.allSettled(keys.map((key) => deleteObject(key)))
}

export type DraftTarget = {
  mailItemId: string
  /** Demande traitée ; nulle pour une ouverture à l'initiative du centre. */
  requestId: string | null
}

/**
 * Dépôt d'un contenu à valider : le fichier part au stockage, chiffré
 * (ADR 020), puis la ligne s'écrit. Un échec de l'écriture efface le fichier.
 */
export async function depositContent(
  target: DraftTarget,
  staffMemberId: string,
  content: ScanFile,
): Promise<{ draftId: string; mailItemId: string; requestId: string | null }> {
  if (!isUuid(target.mailItemId)) throw new MailStateError('Courrier introuvable.')
  const stored = await store(currentTenantId(), { content })
  let recorded: Awaited<ReturnType<typeof recordContentDraft>>
  try {
    recorded = await recordContentDraft(target, staffMemberId, stored)
  } catch (error) {
    await discard(stored)
    throw error
  }
  await removeFiles(recorded.replacedKeys)
  return recorded
}

/**
 * Écriture d'un dépôt, une fois le fichier déposé : séparée du dépôt pour
 * s'éprouver contre la base sans stockage réel. Rend les clés des fichiers
 * remplacés, à effacer du stockage.
 *
 * - Numérisation demandée : la demande doit être en cours, le pli ouvert.
 * - Ouverture demandée, ou d'office : le pli doit être fermé ; une demande
 *   d'ouverture en cours est rattachée au dépôt.
 * - Une demande encore « déposée » passe « validée » : le client ne l'annule
 *   plus pendant que l'accueil y travaille.
 */
export async function recordContentDraft(
  target: DraftTarget,
  staffMemberId: string,
  stored: StoredScan[],
  database?: Database,
): Promise<{ draftId: string; mailItemId: string; requestId: string | null; replacedKeys: string[] }> {
  const [content] = stored.filter((scan) => scan.side === 'content')
  if (!content) throw new MailStateError('Joignez le contenu numérisé.')
  return stated(() =>
    withTenant(
      currentTenantId(),
      async (tx) => {
        const [item] = await tx
          .select({ id: mailItems.id, openedAt: mailItems.openedAt, deletedAt: mailItems.deletedAt })
          .from(mailItems)
          .where(eq(mailItems.id, target.mailItemId))
          .limit(1)
          .for('update')
        if (!item) throw new MailStateError('Courrier introuvable.')
        if (item.deletedAt) throw new MailStateError('Ce courrier a été retiré : aucun contenu ne s’y dépose.')

        let request: LockedRequest | undefined
        if (target.requestId) {
          if (!isUuid(target.requestId)) throw new MailStateError('Demande introuvable.')
          ;[request] = await tx
            .select({ id: mailRequests.id, kind: mailRequests.kind, status: mailRequests.status })
            .from(mailRequests)
            .where(and(eq(mailRequests.id, target.requestId), eq(mailRequests.mailItemId, item.id)))
            .limit(1)
            .for('update')
          if (!request) throw new MailStateError('Demande introuvable.')
          if (!(pendingRequestStatuses as readonly string[]).includes(request.status)) throw new MailStateError(MOVED)
          if (request.kind === 'forward') throw new MailStateError('Une réexpédition ne se numérise pas.')
          if (request.kind === 'scan' && !item.openedAt) {
            throw new MailStateError('Ce courrier n’est pas encore ouvert : ouvrez-le d’abord.')
          }
        } else {
          request = await pendingOpeningRequest(tx, item.id)
        }
        const purpose = draftPurpose(request?.kind ?? null)
        if (purpose === 'opening' && item.openedAt) {
          throw new MailStateError('Ce courrier est déjà ouvert : son contenu a déjà été validé.')
        }
        if (request) await startIfRequested(tx, request, staffMemberId)

        const replaced = await liveDraftsOfPlace(
          tx,
          item.id,
          purpose === 'scan' ? { purpose, requestId: (request as LockedRequest).id } : { purpose },
        )
        const replacedKeys = await purgeDrafts(tx, replaced)
        const draftId = uuidv7()
        const [row] = scanRows(item.id, [content], staffMemberId)
        await tx.insert(mailScans).values({
          ...row,
          id: draftId,
          mailRequestId: request?.id ?? null,
          pendingValidation: true,
        })
        return { draftId, mailItemId: item.id, requestId: request?.id ?? null, replacedKeys }
      },
      database,
    ),
  )
}

/** Ce que la validation a publié : de quoi prévenir le client. */
export type ValidatedDraft = {
  mailItemId: string
  purpose: DraftPurpose
  /** Demande faite par la validation ; nulle pour une ouverture d'office. */
  requestId: string | null
}

/**
 * Validation d'un dépôt : le geste qu'il publie, puis le contenu rendu
 * visible, dans la même transaction.
 *
 * - Ouverture (demandée ou d'office) : le pli passe ouvert, ce qui clôt la
 *   demande d'ouverture en cours (`mail_items_after_update`) ; une demande
 *   d'ouverture arrivée depuis un dépôt d'office lui est rattachée.
 * - Numérisation demandée : la demande passe faite.
 *
 * À l'appelant de prévenir le client ensuite : « courrier numérisé » pour une
 * ouverture, « demande traitée » pour une numérisation.
 */
export async function validateContentDraft(
  draftId: string,
  staffMemberId: string,
  database?: Database,
): Promise<ValidatedDraft> {
  if (!isUuid(draftId)) throw new MailStateError('Dépôt introuvable.')
  return stated(() =>
    withTenant(
      currentTenantId(),
      async (tx) => {
        const [draft] = await tx
          .select({
            id: mailScans.id,
            mailItemId: mailScans.mailItemId,
            mailRequestId: mailScans.mailRequestId,
            pendingValidation: mailScans.pendingValidation,
            deletedAt: mailScans.deletedAt,
          })
          .from(mailScans)
          .where(eq(mailScans.id, draftId))
          .limit(1)
          .for('update')
        if (!draft || !draft.pendingValidation || draft.deletedAt) {
          throw new MailStateError('Ce dépôt a déjà été validé, remplacé ou abandonné : rechargez la page.')
        }
        const [item] = await tx
          .select({ id: mailItems.id, deletedAt: mailItems.deletedAt })
          .from(mailItems)
          .where(eq(mailItems.id, draft.mailItemId))
          .limit(1)
          .for('update')
        if (!item || item.deletedAt) throw new MailStateError('Ce courrier a été retiré : rien n’est publié.')

        let request: LockedRequest | undefined
        if (draft.mailRequestId) {
          ;[request] = await tx
            .select({ id: mailRequests.id, kind: mailRequests.kind, status: mailRequests.status })
            .from(mailRequests)
            .where(eq(mailRequests.id, draft.mailRequestId))
            .limit(1)
            .for('update')
          if (!request || !(pendingRequestStatuses as readonly string[]).includes(request.status)) {
            throw new MailStateError(
              'La demande de ce dépôt n’est plus en cours (refusée ou annulée) : il ne se valide plus.',
            )
          }
        } else {
          // Dépôt d'office : une demande d'ouverture arrivée depuis en devient l'origine.
          request = await pendingOpeningRequest(tx, item.id)
          if (request) {
            await tx.update(mailScans).set({ mailRequestId: request.id }).where(eq(mailScans.id, draft.id))
          }
        }

        const purpose = draftPurpose(request?.kind ?? null)
        if (purpose === 'scan') {
          const [done] = await updateReturning(
            tx,
            mailRequests,
            { status: 'done', completedByStaffId: staffMemberId },
            and(eq(mailRequests.id, (request as LockedRequest).id), inArray(mailRequests.status, [...pendingRequestStatuses])),
          )
          if (!done) throw new MailStateError(MOVED)
        } else {
          const [opened] = await updateReturning(
            tx,
            mailItems,
            { status: 'opened', openedAt: maintenant(), openedBy: staffMemberId },
            and(eq(mailItems.id, item.id), ne(mailItems.status, 'opened'), isNull(mailItems.deletedAt)),
          )
          if (!opened) throw new MailStateError('Ce courrier a déjà été ouvert entre-temps : rechargez la page.')
        }
        await tx.update(mailScans).set({ pendingValidation: false }).where(eq(mailScans.id, draft.id))
        return { mailItemId: item.id, purpose, requestId: request?.id ?? null }
      },
      database,
    ),
  )
}

/**
 * Abandon d'un dépôt à valider (mauvais pli, mauvais fichier) : purgé comme un
 * dépôt remplacé, sans rien publier. La demande, elle, reste en cours.
 */
export async function discardContentDraft(draftId: string): Promise<{ mailItemId: string; requestId: string | null }> {
  const { keys, ...result } = await recordDraftDiscard(draftId)
  await removeFiles(keys)
  return result
}

/** Écriture de l'abandon : rend les clés des fichiers à effacer. */
export async function recordDraftDiscard(
  draftId: string,
  database?: Database,
): Promise<{ mailItemId: string; requestId: string | null; keys: string[] }> {
  if (!isUuid(draftId)) throw new MailStateError('Dépôt introuvable.')
  return withTenant(
    currentTenantId(),
    async (tx) => {
      const [draft] = await tx
        .select({
          id: mailScans.id,
          storageKey: mailScans.storageKey,
          mailItemId: mailScans.mailItemId,
          mailRequestId: mailScans.mailRequestId,
        })
        .from(mailScans)
        .where(and(eq(mailScans.id, draftId), eq(mailScans.pendingValidation, true), isNull(mailScans.deletedAt)))
        .limit(1)
        .for('update')
      if (!draft) throw new MailStateError('Ce dépôt a déjà été validé, remplacé ou abandonné : rechargez la page.')
      const keys = await purgeDrafts(tx, [draft])
      return { mailItemId: draft.mailItemId, requestId: draft.mailRequestId, keys }
    },
    database,
  )
}

/**
 * Dépôts d'une demande refusée ou annulée : ils ne seront jamais validés.
 * Purgés, fichiers effacés. Sans effet s'il n'y en a pas.
 */
export async function discardRequestDrafts(requestId: string, database?: Database): Promise<void> {
  if (!isUuid(requestId)) return
  const keys = await withTenant(
    currentTenantId(),
    async (tx) => {
      const drafts = await tx
        .select({ id: mailScans.id, storageKey: mailScans.storageKey })
        .from(mailScans)
        .where(
          and(eq(mailScans.mailRequestId, requestId), eq(mailScans.pendingValidation, true), isNull(mailScans.deletedAt)),
        )
        .for('update')
      return purgeDrafts(tx, drafts)
    },
    database,
  )
  await removeFiles(keys)
}
