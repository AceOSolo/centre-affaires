import { randomUUID } from 'node:crypto'

import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm'

import { tenantContext } from '../../db/contexte.ts'
import { dbErrorCode, dbSignalMessage, DB_CLIENT_DOCUMENT_REFUSED } from '../../db/errors.ts'
import { withTenant, type Database, type Transaction } from '../../db/index.ts'
import { staffMembers } from '../../db/staff.ts'
import { sealDocument } from '../../lib/chiffrement-documents.ts'
import { deleteObject, putObject } from '../../lib/stockage.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { isUuid, uuidv7 } from '../../lib/uuid.ts'
import { contracts } from '../contrats/schema.ts'
import { proposals } from '../facturation/schema-devis.ts'
import { inClientSpace, type ClientAccount } from './comptes.ts'
import {
  defaultDocumentKinds,
  documentChecklist,
  documentExtensions,
  kindsForSituation,
  moveKind,
  newKindCode,
  situationFromAnswers,
  type ChecklistItem,
  type ClientDocumentKind,
  type DepositedDocument,
  type DocumentFile,
  type KindInput,
} from './pieces-regles.ts'
import { clientMembers, clients } from './schema.ts'
import {
  clientDocumentKinds,
  clientDocuments,
  clientDocumentViews,
  type ClientDocumentContentType,
  type ClientDocumentSituation,
} from './schema-pieces.ts'

/**
 * Pièces justificatives de la domiciliation (ADR 075) : lectures et écritures.
 *
 * Toute lecture porte son filtre `tenant_id` (décision 1, ADR 042) ; celles
 * de l'espace client filtrent aussi sur les entreprises du compte, que la
 * base ne filtre pas (ADR 019). Les règles d'écriture sont en base
 * (`34-pieces.sql`, `CA021`) : le code les dit en clair, la base les tient.
 */

const transactionTenant = () => tenantContext.getStore() ?? currentTenantId()

/** Refus lisible d'un dépôt ou d'une vérification : montré tel quel à l'écran. */
export class ClientDocumentRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ClientDocumentRefusal'
  }
}

/** Traduit un refus de la base (`CA021`) en refus lisible. */
async function translating<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (dbErrorCode(error) === DB_CLIENT_DOCUMENT_REFUSED) {
      throw new ClientDocumentRefusal(dbSignalMessage(error) ?? 'Pièce refusée.')
    }
    throw error
  }
}

/* -------------------------------------------------------------------------- */
/* Liste des pièces demandées                                                 */
/* -------------------------------------------------------------------------- */

export type DocumentKindsSetting = {
  kinds: ClientDocumentKind[]
  /** Le centre a-t-il déjà réglé sa liste ? Sinon, c'est celle du code. */
  customized: boolean
}

/** La liste du centre de la transaction, ou celle du code s'il n'a rien réglé. */
export async function readDocumentKinds(tx: Transaction): Promise<DocumentKindsSetting> {
  const rows = await tx
    .select({
      code: clientDocumentKinds.code,
      label: clientDocumentKinds.label,
      help: clientDocumentKinds.help,
      appliesTo: clientDocumentKinds.appliesTo,
      position: clientDocumentKinds.position,
      active: clientDocumentKinds.active,
    })
    .from(clientDocumentKinds)
    .where(eq(clientDocumentKinds.tenantId, transactionTenant()))
    .orderBy(asc(clientDocumentKinds.position), asc(clientDocumentKinds.label))
  if (rows.length === 0) return { kinds: defaultDocumentKinds.map((kind) => ({ ...kind })), customized: false }
  return { kinds: rows, customized: true }
}

export function listDocumentKinds(database?: Database): Promise<DocumentKindsSetting> {
  return withTenant(currentTenantId(), readDocumentKinds, database)
}

/** Écrit la liste du code en base, la première fois que le centre la règle. */
async function materializeKinds(tx: Transaction, staffMemberId: string | null): Promise<ClientDocumentKind[]> {
  const current = await readDocumentKinds(tx)
  if (current.customized) return current.kinds
  await tx.insert(clientDocumentKinds).values(
    current.kinds.map((kind) => ({
      code: kind.code,
      label: kind.label,
      help: kind.help,
      appliesTo: kind.appliesTo,
      position: kind.position,
      active: kind.active,
      updatedBy: staffMemberId,
    })),
  )
  return current.kinds
}

/**
 * Ajoute une pièce à la liste (`code` nul) ou modifie celle de ce code. Rend
 * le code de la pièce.
 */
export async function saveDocumentKind(
  code: string | null,
  input: KindInput,
  staffMemberId: string | null,
  database?: Database,
): Promise<string> {
  return withTenant(
    currentTenantId(),
    async (tx) => {
      const kinds = await materializeKinds(tx, staffMemberId)
      const tenantId = transactionTenant()
      if (code === null) {
        const newCode = newKindCode(input.label, kinds.map((kind) => kind.code))
        const position = kinds.reduce((max, kind) => Math.max(max, kind.position), -1) + 1
        await tx.insert(clientDocumentKinds).values({
          code: newCode,
          label: input.label,
          help: input.help,
          appliesTo: input.appliesTo,
          position: Math.min(position, 32767),
          active: true,
          updatedBy: staffMemberId,
        })
        return newCode
      }
      if (!kinds.some((kind) => kind.code === code)) throw new ClientDocumentRefusal('Cette pièce n’est plus dans la liste.')
      await tx
        .update(clientDocumentKinds)
        .set({ label: input.label, help: input.help, appliesTo: input.appliesTo, updatedBy: staffMemberId })
        .where(and(eq(clientDocumentKinds.tenantId, tenantId), eq(clientDocumentKinds.code, code)))
      return code
    },
    database,
  )
}

/** Retire une pièce de la liste, ou l'y remet. Les pièces déjà déposées restent. */
export async function setDocumentKindActive(
  code: string,
  active: boolean,
  staffMemberId: string | null,
  database?: Database,
): Promise<void> {
  await withTenant(
    currentTenantId(),
    async (tx) => {
      const kinds = await materializeKinds(tx, staffMemberId)
      if (!kinds.some((kind) => kind.code === code)) throw new ClientDocumentRefusal('Cette pièce n’est plus dans la liste.')
      await tx
        .update(clientDocumentKinds)
        .set({ active, updatedBy: staffMemberId })
        .where(and(eq(clientDocumentKinds.tenantId, transactionTenant()), eq(clientDocumentKinds.code, code)))
    },
    database,
  )
}

/** Monte ou descend une pièce dans la liste : l'ordre où le client la voit. */
export async function moveDocumentKind(
  code: string,
  direction: 'up' | 'down',
  staffMemberId: string | null,
  database?: Database,
): Promise<void> {
  await withTenant(
    currentTenantId(),
    async (tx) => {
      const kinds = await materializeKinds(tx, staffMemberId)
      const order = moveKind(
        kinds.map((kind) => kind.code),
        code,
        direction,
      )
      for (const [position, kindCode] of order.entries()) {
        await tx
          .update(clientDocumentKinds)
          .set({ position, updatedBy: staffMemberId })
          .where(and(eq(clientDocumentKinds.tenantId, transactionTenant()), eq(clientDocumentKinds.code, kindCode)))
      }
    },
    database,
  )
}

/* -------------------------------------------------------------------------- */
/* Situation de la société                                                    */
/* -------------------------------------------------------------------------- */

type Situation = Exclude<ClientDocumentSituation, 'all'> | null

/**
 * Situation de chaque entreprise, lue dans sa dernière demande de
 * domiciliation non annulée. Sans demande : `null`.
 */
async function situations(tx: Transaction, clientIds: readonly string[]): Promise<Map<string, Situation>> {
  const result = new Map<string, Situation>(clientIds.map((id) => [id, null]))
  if (clientIds.length === 0) return result
  const rows = await tx
    .select({ clientId: proposals.clientId, answers: proposals.answers })
    .from(proposals)
    .where(
      and(
        eq(proposals.tenantId, transactionTenant()),
        inArray(proposals.clientId, [...clientIds]),
        eq(proposals.product, 'domiciliation'),
        ne(proposals.status, 'cancelled'),
      ),
    )
    .orderBy(desc(proposals.createdAt))
  const seen = new Set<string>()
  for (const row of rows) {
    if (!row.clientId || seen.has(row.clientId)) continue
    seen.add(row.clientId)
    result.set(row.clientId, situationFromAnswers(row.answers))
  }
  return result
}

/** Pièces demandées pour une situation, d'après la liste du centre. */
export async function documentKindsFor(tx: Transaction, situation: Situation): Promise<ClientDocumentKind[]> {
  return kindsForSituation((await readDocumentKinds(tx)).kinds, situation)
}

/* -------------------------------------------------------------------------- */
/* Pièces déposées                                                            */
/* -------------------------------------------------------------------------- */

const depositedColumns = {
  id: clientDocuments.id,
  clientId: clientDocuments.clientId,
  kindCode: clientDocuments.kindCode,
  kindLabel: clientDocuments.kindLabel,
  status: clientDocuments.status,
  refusalReason: clientDocuments.refusalReason,
  contentType: clientDocuments.contentType,
  byteSize: clientDocuments.byteSize,
  createdAt: clientDocuments.createdAt,
  reviewedAt: clientDocuments.reviewedAt,
  purged: sql<boolean>`${clientDocuments.deletedAt} is not null`.mapWith(Boolean),
}

type DepositedRow = DepositedDocument & { clientId: string }

/**
 * Entreprises du compte qui ont une rubrique « Pièces justificatives » : une
 * demande de domiciliation non annulée, un contrat de domiciliation vivant,
 * ou déjà une pièce déposée.
 */
async function documentClientIds(tx: Transaction, clientIds: readonly string[]): Promise<string[]> {
  if (clientIds.length === 0) return []
  const tenantId = transactionTenant()
  const ids = [...clientIds]
  const [withProposal, withContract, withDocument] = await Promise.all([
    tx
      .selectDistinct({ id: proposals.clientId })
      .from(proposals)
      .where(
        and(
          eq(proposals.tenantId, tenantId),
          inArray(proposals.clientId, ids),
          eq(proposals.product, 'domiciliation'),
          ne(proposals.status, 'cancelled'),
        ),
      ),
    tx
      .selectDistinct({ id: contracts.clientId })
      .from(contracts)
      .where(
        and(
          eq(contracts.tenantId, tenantId),
          inArray(contracts.clientId, ids),
          eq(contracts.contractType, 'domiciliation'),
          inArray(contracts.status, ['draft', 'active']),
          isNull(contracts.deletedAt),
        ),
      ),
    tx
      .selectDistinct({ id: clientDocuments.clientId })
      .from(clientDocuments)
      .where(and(eq(clientDocuments.tenantId, tenantId), inArray(clientDocuments.clientId, ids))),
  ])
  const found = new Set([...withProposal, ...withContract, ...withDocument].map((row) => row.id).filter(Boolean))
  return ids.filter((id) => found.has(id))
}

export type ClientDocumentsSpace = {
  clientId: string
  clientName: string
  situation: Situation
  items: ChecklistItem[]
  others: DepositedDocument[]
}

/**
 * Ce que l'espace client montre : pour chaque entreprise du compte qui a une
 * rubrique, les pièces demandées et où elles en sont.
 */
export async function loadClientDocumentSpace(
  accounts: readonly ClientAccount[],
  database?: Database,
): Promise<ClientDocumentsSpace[]> {
  if (accounts.length === 0) return []
  return inClientSpace(
    accounts,
    async (tx) => {
      const clientIds = await documentClientIds(
        tx,
        accounts.map((account) => account.clientId),
      )
      if (clientIds.length === 0) return []
      const [kinds, bySituation, documents] = await Promise.all([
        readDocumentKinds(tx),
        situations(tx, clientIds),
        tx
          .select(depositedColumns)
          .from(clientDocuments)
          .where(and(eq(clientDocuments.tenantId, transactionTenant()), inArray(clientDocuments.clientId, clientIds)))
          .orderBy(desc(clientDocuments.createdAt)),
      ])
      return clientIds.map((clientId) => {
        const situation = bySituation.get(clientId) ?? null
        const { items, others } = documentChecklist(
          kindsForSituation(kinds.kinds, situation),
          (documents as DepositedRow[]).filter((document) => document.clientId === clientId),
        )
        return {
          clientId,
          clientName: accounts.find((account) => account.clientId === clientId)?.clientName ?? '',
          situation,
          items,
          others,
        }
      })
    },
    database,
  )
}

/** L'espace client a-t-il une rubrique « Pièces justificatives » ? Pour la navigation. */
export async function hasDocumentSpace(accounts: readonly ClientAccount[], database?: Database): Promise<boolean> {
  if (accounts.length === 0) return false
  return inClientSpace(
    accounts,
    async (tx) =>
      (
        await documentClientIds(
          tx,
          accounts.map((account) => account.clientId),
        )
      ).length > 0,
    database,
  )
}

/**
 * L'entreprise a-t-elle des pièces à fournir ou déjà fournies ? La fiche
 * client ne montre l'encart qu'alors : une entreprise qui loue une salle de
 * temps en temps n'a rien à justifier.
 */
export async function clientHasDocumentSpace(clientId: string, database?: Database): Promise<boolean> {
  if (!isUuid(clientId)) return false
  return withTenant(currentTenantId(), async (tx) => (await documentClientIds(tx, [clientId])).length > 0, database)
}

/** Où se dépose et se lit un fichier : le stockage objet, remplacé dans les tests. */
export type DocumentStorage = {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>
  remove(key: string): Promise<void>
}

const objectStorage: DocumentStorage = { put: putObject, remove: deleteObject }

/**
 * Dépose une pièce depuis l'espace client : vérifiée (demandée à cette
 * entreprise), chiffrée avant de partir (ADR 020), déposée, puis inscrite.
 * Une ligne ne désigne jamais un fichier absent ; un fichier sans ligne, si
 * l'écriture échoue, est effacé aussitôt.
 *
 * Rend la pièce créée. Lève `ClientDocumentRefusal` pour un refus à montrer.
 */
export async function depositClientDocument(
  input: { account: ClientAccount; kindCode: string; file: DocumentFile },
  options: { database?: Database; storage?: DocumentStorage } = {},
): Promise<{ id: string; kindLabel: string }> {
  const storage = options.storage ?? objectStorage
  const { account, file } = input

  const kind = await inClientSpace(
    [account],
    async (tx) => {
      const situation = (await situations(tx, [account.clientId])).get(account.clientId) ?? null
      return (await documentKindsFor(tx, situation)).find((candidate) => candidate.code === input.kindCode)
    },
    options.database,
  )
  if (!kind) throw new ClientDocumentRefusal('Cette pièce n’est pas demandée à votre société.')

  const tenantId = currentTenantId()
  // Clé sans rien de lisible : ni client ni nature de la pièce au stockage.
  const key = `pieces/${tenantId}/${randomUUID()}.${documentExtensions[file.contentType]}`
  const sealed = sealDocument(file.bytes, key)
  await storage.put(key, sealed.bytes, 'application/octet-stream')

  try {
    const id = uuidv7()
    await translating(() =>
      inClientSpace(
        [account],
        (tx) =>
          tx.insert(clientDocuments).values({
            id,
            clientId: account.clientId,
            kindCode: kind.code,
            kindLabel: kind.label,
            storageKey: key,
            encryptionKeyVersion: sealed.keyVersion,
            contentType: file.contentType,
            byteSize: file.bytes.byteLength,
            uploadedByMemberId: account.memberId,
          }),
        options.database,
      ),
    )
    return { id, kindLabel: kind.label }
  } catch (error) {
    await storage.remove(key).catch((reason) => console.error('Pièce non effacée du stockage', reason))
    throw error
  }
}

/* -------------------------------------------------------------------------- */
/* Côté équipe                                                                */
/* -------------------------------------------------------------------------- */

export type StaffDepositedDocument = DepositedDocument & {
  uploadedBy: string
  reviewedByName: string | null
}

export type StaffDocumentsView = {
  situation: Situation
  items: ChecklistItem<StaffDepositedDocument>[]
  others: StaffDepositedDocument[]
}

/** Pièces d'une entreprise, pour la fiche client et le devis de domiciliation. */
export async function listClientDocumentsForStaff(clientId: string, database?: Database): Promise<StaffDocumentsView> {
  return withTenant(
    currentTenantId(),
    async (tx) => {
      const tenantId = transactionTenant()
      const [kinds, bySituation, rows] = await Promise.all([
        readDocumentKinds(tx),
        situations(tx, [clientId]),
        tx
          .select({
            ...depositedColumns,
            memberName: clientMembers.fullName,
            memberEmail: clientMembers.email,
            reviewedByName: sql<string | null>`coalesce(${staffMembers.fullName}, ${staffMembers.email})`,
          })
          .from(clientDocuments)
          .innerJoin(
            clientMembers,
            and(eq(clientMembers.tenantId, clientDocuments.tenantId), eq(clientMembers.id, clientDocuments.uploadedByMemberId)),
          )
          .leftJoin(staffMembers, eq(staffMembers.id, clientDocuments.reviewedBy))
          .where(and(eq(clientDocuments.tenantId, tenantId), eq(clientDocuments.clientId, clientId)))
          .orderBy(desc(clientDocuments.createdAt)),
      ])
      const situation = bySituation.get(clientId) ?? null
      const documents: StaffDepositedDocument[] = rows.map(({ memberName, memberEmail, ...row }) => ({
        ...row,
        uploadedBy: memberName?.trim() || memberEmail,
      }))
      return { situation, ...documentChecklist(kindsForSituation(kinds.kinds, situation), documents) }
    },
    database,
  )
}

/** Décision de l'accueil sur une pièce. */
export type DocumentReview = { status: 'accepted' } | { status: 'refused'; reason: string }

/**
 * Valide ou refuse une pièce. La base tient les passages permis (`CA021`).
 * Rend l'entreprise de la pièce, pour revalider ses écrans.
 */
export async function reviewClientDocument(
  documentId: string,
  review: DocumentReview,
  staffMemberId: string,
  database?: Database,
): Promise<{ clientId: string; kindLabel: string }> {
  if (!isUuid(documentId)) throw new ClientDocumentRefusal('Pièce introuvable.')
  return translating(() =>
    withTenant(
      currentTenantId(),
      async (tx) => {
        const tenantId = transactionTenant()
        const [document] = await tx
          .select({ clientId: clientDocuments.clientId, kindLabel: clientDocuments.kindLabel, deletedAt: clientDocuments.deletedAt })
          .from(clientDocuments)
          .where(and(eq(clientDocuments.tenantId, tenantId), eq(clientDocuments.id, documentId)))
          .for('update')
        if (!document) throw new ClientDocumentRefusal('Pièce introuvable.')
        await tx
          .update(clientDocuments)
          .set({
            status: review.status,
            refusalReason: review.status === 'refused' ? review.reason : null,
            reviewedAt: sql`CURRENT_TIMESTAMP(3)`,
            reviewedBy: staffMemberId,
          })
          .where(and(eq(clientDocuments.tenantId, tenantId), eq(clientDocuments.id, documentId)))
        return { clientId: document.clientId, kindLabel: document.kindLabel }
      },
      database,
    ),
  )
}

/* -------------------------------------------------------------------------- */
/* Consultation                                                               */
/* -------------------------------------------------------------------------- */

export type DocumentToServe = {
  id: string
  clientId: string
  kindLabel: string
  storageKey: string
  contentType: ClientDocumentContentType
  encryptionKeyVersion: number
  createdAt: Date
}

const toServe = {
  id: clientDocuments.id,
  clientId: clientDocuments.clientId,
  kindLabel: clientDocuments.kindLabel,
  storageKey: clientDocuments.storageKey,
  contentType: sql<ClientDocumentContentType>`${clientDocuments.contentType}`,
  encryptionKeyVersion: clientDocuments.encryptionKeyVersion,
  createdAt: clientDocuments.createdAt,
}

/** Une pièce à ouvrir par l'équipe, celle de cette entreprise ; jamais une pièce purgée. */
export async function findDocumentForStaff(
  documentId: string,
  clientId: string,
  database?: Database,
): Promise<DocumentToServe | undefined> {
  if (!isUuid(documentId) || !isUuid(clientId)) return undefined
  const [row] = await withTenant(
    currentTenantId(),
    (tx) =>
      tx
        .select(toServe)
        .from(clientDocuments)
        .where(
          and(
            eq(clientDocuments.tenantId, transactionTenant()),
            eq(clientDocuments.id, documentId),
            eq(clientDocuments.clientId, clientId),
            isNull(clientDocuments.deletedAt),
          ),
        )
        .limit(1),
    database,
  )
  return row
}

/** Une pièce à ouvrir depuis l'espace client : celles de ses entreprises seulement. */
export async function findDocumentForAccounts(
  documentId: string,
  accounts: readonly ClientAccount[],
  database?: Database,
): Promise<DocumentToServe | undefined> {
  if (accounts.length === 0 || !isUuid(documentId)) return undefined
  const [row] = await inClientSpace(
    accounts,
    (tx) =>
      tx
        .select(toServe)
        .from(clientDocuments)
        .where(
          and(
            eq(clientDocuments.tenantId, transactionTenant()),
            eq(clientDocuments.id, documentId),
            inArray(
              clientDocuments.clientId,
              accounts.map((account) => account.clientId),
            ),
            isNull(clientDocuments.deletedAt),
          ),
        )
        .limit(1),
    database,
  )
  return row
}

/** Inscrit une consultation au journal : sans elle, la pièce n'est pas servie (RGPD). */
export async function logClientDocumentView(
  view:
    | { viewer: 'staff'; documentId: string; staffMemberId: string; authUserId: string }
    | { viewer: 'client'; documentId: string; clientMemberId: string; authUserId: string; clientId: string },
  database?: Database,
): Promise<void> {
  if (view.viewer === 'client') {
    const { clientId, ...row } = view
    await inClientSpace([{ clientId }], (tx) => tx.insert(clientDocumentViews).values(row), database)
    return
  }
  await withTenant(currentTenantId(), (tx) => tx.insert(clientDocumentViews).values(view), database)
}

/* -------------------------------------------------------------------------- */
/* Pour les messages                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Pièces à préparer pour une demande de domiciliation, d'après ses réponses :
 * citées par l'accusé de réception (`request_received`).
 */
export async function documentKindsForAnswers(
  tx: Transaction,
  answers: Readonly<Record<string, unknown>> | null | undefined,
): Promise<ClientDocumentKind[]> {
  return documentKindsFor(tx, situationFromAnswers(answers))
}

/** Une pièce et son contexte, pour les messages qui en parlent. */
export async function findDocumentForMessage(
  tx: Transaction,
  documentId: string,
): Promise<
  | {
      id: string
      clientId: string
      clientName: string
      kindLabel: string
      status: string
      refusalReason: string | null
      memberName: string | null
      memberEmail: string
    }
  | undefined
> {
  const [row] = await tx
    .select({
      id: clientDocuments.id,
      clientId: clientDocuments.clientId,
      clientName: clients.name,
      kindLabel: clientDocuments.kindLabel,
      status: clientDocuments.status,
      refusalReason: clientDocuments.refusalReason,
      memberName: clientMembers.fullName,
      memberEmail: clientMembers.email,
    })
    .from(clientDocuments)
    .innerJoin(clients, and(eq(clients.tenantId, clientDocuments.tenantId), eq(clients.id, clientDocuments.clientId)))
    .innerJoin(
      clientMembers,
      and(eq(clientMembers.tenantId, clientDocuments.tenantId), eq(clientMembers.id, clientDocuments.uploadedByMemberId)),
    )
    .where(and(eq(clientDocuments.tenantId, transactionTenant()), eq(clientDocuments.id, documentId)))
    .limit(1)
  return row
}

/** Pièces qui attendent la vérification de l'accueil, d'une entreprise ou de tout le centre. */
export async function countDocumentsToReview(clientId: string | null, database?: Database): Promise<number> {
  const [row] = await withTenant(
    currentTenantId(),
    (tx) =>
      tx
        .select({ count: sql<number>`count(*)`.mapWith(Number) })
        .from(clientDocuments)
        .where(
          and(
            eq(clientDocuments.tenantId, transactionTenant()),
            clientId ? eq(clientDocuments.clientId, clientId) : undefined,
            eq(clientDocuments.status, 'received'),
            isNull(clientDocuments.deletedAt),
          ),
        ),
    database,
  )
  return row?.count ?? 0
}
