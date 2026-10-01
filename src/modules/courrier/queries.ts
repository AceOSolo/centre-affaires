import { randomUUID } from 'node:crypto'

import { and, asc, desc, eq, gte, inArray, isNull, lt, ne, sql } from 'drizzle-orm'
import { alias, type AnyPgColumn } from 'drizzle-orm/pg-core'

import { withTenant } from '../../db/index.ts'
import { staffMembers } from '../../db/staff.ts'
import { deleteObject, putObject } from '../../lib/stockage.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { isUuid } from '../../lib/uuid.ts'
import { clientMembers, clients } from '../clients/schema.ts'
import { inClientSpace, type ClientAccount } from '../clients/comptes.ts'
import { scanExtensions, type ScanFile } from './fichiers.ts'
import type { OpeningLine } from './regles.ts'
import {
  mailItems,
  mailScans,
  mailScanViews,
  type MailItem,
  type MailKind,
  type MailScan,
  type MailScanSide,
  type MailScanViewer,
  type MailStatus,
} from './schema.ts'

const opener = alias(staffMembers, 'opener')
const registrar = alias(staffMembers, 'registrar')

/** Nom affiché d'une personne : son nom s'il est connu, son adresse sinon. */
const displayName = (table: { fullName: AnyPgColumn; email: AnyPgColumn }) =>
  sql<string | null>`coalesce(${table.fullName}, ${table.email})`

/* -------------------------------------------------------------------------- */
/* Stockage                                                                   */
/* -------------------------------------------------------------------------- */

type StoredScan = { side: MailScanSide; key: string; scan: ScanFile }

/**
 * Dépose les fichiers avant d'écrire en base : une ligne ne doit jamais
 * désigner un fichier absent. L'inverse — un fichier sans ligne, si l'écriture
 * échoue ensuite — est rattrapé par `discard`.
 */
async function store(
  tenantId: string,
  scans: Partial<Record<MailScanSide, ScanFile>>,
): Promise<StoredScan[]> {
  const stored: StoredScan[] = []
  for (const side of ['envelope', 'content'] as const) {
    const scan = scans[side]
    if (!scan) continue
    // Clé sans rien de lisible : ni client ni expéditeur n'apparaissent dans
    // le stockage, seulement dans la base, derrière la RLS.
    const key = `courrier/${tenantId}/${randomUUID()}.${scanExtensions[scan.contentType]}`
    await putObject(key, scan.bytes, scan.contentType)
    stored.push({ side, key, scan })
  }
  return stored
}

async function discard(stored: StoredScan[]): Promise<void> {
  await Promise.allSettled(stored.map(({ key }) => deleteObject(key)))
}

const scanRows = (mailItemId: string, stored: StoredScan[], uploadedBy: string) =>
  stored.map(({ side, key, scan }) => ({
    mailItemId,
    side,
    storageKey: key,
    contentType: scan.contentType,
    byteSize: scan.bytes.byteLength,
    uploadedBy,
  }))

/* -------------------------------------------------------------------------- */
/* Back-office                                                                */
/* -------------------------------------------------------------------------- */

export type MailRow = Pick<
  MailItem,
  'id' | 'kind' | 'sender' | 'receivedAt' | 'status' | 'openingRequestedAt' | 'clientId'
> & { clientName: string }

export async function listMail(
  filters: { status?: MailStatus; clientId?: string } = {},
): Promise<MailRow[]> {
  if (filters.clientId && !isUuid(filters.clientId)) return []
  return withTenant(currentTenantId(), (tx) =>
    tx
      .select({
        id: mailItems.id,
        kind: mailItems.kind,
        sender: mailItems.sender,
        receivedAt: mailItems.receivedAt,
        status: mailItems.status,
        openingRequestedAt: mailItems.openingRequestedAt,
        clientId: mailItems.clientId,
        clientName: clients.name,
      })
      .from(mailItems)
      .innerJoin(clients, eq(clients.id, mailItems.clientId))
      .where(
        and(
          isNull(mailItems.deletedAt),
          filters.status ? eq(mailItems.status, filters.status) : undefined,
          filters.clientId ? eq(mailItems.clientId, filters.clientId) : undefined,
        ),
      )
      // Les demandes se traitent dans l'ordre d'arrivée ; le reste se lit du
      // plus récent au plus ancien.
      .orderBy(
        ...(filters.status === 'opening_requested'
          ? [asc(mailItems.openingRequestedAt)]
          : [desc(mailItems.receivedAt)]),
      )
      .limit(200),
  )
}

/** Nombre de plis à ouvrir, affiché en permanence dans la navigation. */
export async function countOpeningRequests(): Promise<number> {
  const [row] = await withTenant(currentTenantId(), (tx) =>
    tx
      .select({ count: sql<number>`count(*)::int` })
      .from(mailItems)
      .where(and(eq(mailItems.status, 'opening_requested'), isNull(mailItems.deletedAt))),
  )
  return row?.count ?? 0
}

export type MailDetail = MailItem & {
  clientName: string
  requestedBy: string | null
  openedByName: string | null
  registeredByName: string | null
  scans: MailScan[]
  views: {
    id: string
    viewedAt: Date
    viewer: MailScanViewer
    side: MailScanSide
    name: string | null
  }[]
}

export async function findMail(id: string): Promise<MailDetail | undefined> {
  if (!isUuid(id)) return undefined
  return withTenant(currentTenantId(), async (tx) => {
    const [row] = await tx
      .select({
        item: mailItems,
        clientName: clients.name,
        requestedBy: displayName(clientMembers),
        openedByName: displayName(opener),
        registeredByName: displayName(registrar),
      })
      .from(mailItems)
      .innerJoin(clients, eq(clients.id, mailItems.clientId))
      .leftJoin(clientMembers, eq(clientMembers.id, mailItems.openingRequestedBy))
      .leftJoin(opener, eq(opener.id, mailItems.openedBy))
      .leftJoin(registrar, eq(registrar.id, mailItems.registeredBy))
      .where(eq(mailItems.id, id))
      .limit(1)
    if (!row) return undefined

    const scans = await tx
      .select()
      .from(mailScans)
      .where(and(eq(mailScans.mailItemId, id), isNull(mailScans.deletedAt)))
      .orderBy(asc(mailScans.side))

    const views = await tx
      .select({
        id: mailScanViews.id,
        viewedAt: mailScanViews.viewedAt,
        viewer: mailScanViews.viewer,
        side: mailScans.side,
        name: sql<string | null>`coalesce(${displayName(staffMembers)}, ${displayName(clientMembers)})`,
      })
      .from(mailScanViews)
      .innerJoin(mailScans, eq(mailScans.id, mailScanViews.mailScanId))
      .leftJoin(staffMembers, eq(staffMembers.id, mailScanViews.staffMemberId))
      .leftJoin(clientMembers, eq(clientMembers.id, mailScanViews.clientMemberId))
      .where(eq(mailScans.mailItemId, id))
      .orderBy(desc(mailScanViews.viewedAt))

    return {
      ...row.item,
      clientName: row.clientName,
      requestedBy: row.requestedBy,
      openedByName: row.openedByName,
      registeredByName: row.registeredByName,
      scans,
      views,
    }
  })
}

export type RegisterMailInput = {
  clientId: string
  kind: MailKind
  sender: string | null
  receivedAt: Date
  note: string | null
}

/**
 * Enregistrement d'un pli à son arrivée.
 *
 * Avec la numérisation du contenu, le pli est enregistré ouvert : le centre
 * l'a ouvert de lui-même, et l'ouverture figure au relevé comme telle.
 */
export async function registerMail(
  input: RegisterMailInput,
  staffMemberId: string,
  scans: Partial<Record<MailScanSide, ScanFile>>,
): Promise<string> {
  const tenantId = currentTenantId()
  const stored = await store(tenantId, scans)

  try {
    return await withTenant(tenantId, async (tx) => {
      const opened = Boolean(scans.content)
      const [item] = await tx
        .insert(mailItems)
        .values({
          ...input,
          registeredBy: staffMemberId,
          status: opened ? 'opened' : 'received',
          openedAt: opened ? sql`now()` : null,
          openedBy: opened ? staffMemberId : null,
        })
        .returning({ id: mailItems.id })
      if (stored.length > 0) await tx.insert(mailScans).values(scanRows(item.id, stored, staffMemberId))
      return item.id
    })
  } catch (error) {
    await discard(stored)
    throw error
  }
}

/** Levée quand le pli n'est plus dans l'état attendu : déjà ouvert, retiré. */
export class MailStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MailStateError'
  }
}

/**
 * Ouverture et numérisation du contenu : la prestation facturée.
 *
 * La condition sur le statut vit dans le `where` : deux personnes de l'équipe
 * qui ouvrent le même pli en même temps ne produisent qu'une ouverture.
 */
export async function openMail(id: string, staffMemberId: string, content: ScanFile): Promise<void> {
  const tenantId = currentTenantId()
  const stored = await store(tenantId, { content })

  try {
    await withTenant(tenantId, async (tx) => {
      const [item] = await tx
        .update(mailItems)
        .set({ status: 'opened', openedAt: sql`now()`, openedBy: staffMemberId })
        .where(
          and(eq(mailItems.id, id), ne(mailItems.status, 'opened'), isNull(mailItems.deletedAt)),
        )
        .returning({ id: mailItems.id })
      if (!item) throw new MailStateError('Ce courrier a déjà été ouvert, ou il a été retiré.')
      await tx.insert(mailScans).values(scanRows(item.id, stored, staffMemberId))
    })
  } catch (error) {
    await discard(stored)
    throw error
  }
}

/**
 * Retrait d'un pli enregistré par erreur — le plus souvent, attribué au
 * mauvais client. Il sort de la boîte aux lettres du client et du relevé de
 * facturation ; la ligne et le journal d'accès restent (décision 6).
 */
export async function withdrawMail(id: string): Promise<void> {
  await withTenant(currentTenantId(), (tx) =>
    tx
      .update(mailItems)
      .set({ deletedAt: sql`now()` })
      .where(and(eq(mailItems.id, id), isNull(mailItems.deletedAt))),
  )
}

/** Ouvertures d'une période, pour le relevé de facturation. */
export async function listOpenings(range: { startsAt: Date; endsAt: Date }): Promise<OpeningLine[]> {
  const rows = await withTenant(currentTenantId(), (tx) =>
    tx
      .select({
        mailItemId: mailItems.id,
        clientId: clients.id,
        clientName: clients.name,
        clientSiret: clients.siret,
        kind: mailItems.kind,
        sender: mailItems.sender,
        receivedAt: mailItems.receivedAt,
        openingRequestedAt: mailItems.openingRequestedAt,
        requestedBy: displayName(clientMembers),
        openedAt: mailItems.openedAt,
        openedBy: displayName(opener),
      })
      .from(mailItems)
      .innerJoin(clients, eq(clients.id, mailItems.clientId))
      .leftJoin(clientMembers, eq(clientMembers.id, mailItems.openingRequestedBy))
      .leftJoin(opener, eq(opener.id, mailItems.openedBy))
      .where(
        and(
          isNull(mailItems.deletedAt),
          gte(mailItems.openedAt, range.startsAt),
          lt(mailItems.openedAt, range.endsAt),
        ),
      ),
  )
  // Les bornes sur `opened_at` excluent les plis fermés : la date est là.
  return rows.map((row) => ({ ...row, openedAt: row.openedAt as Date }))
}

/* -------------------------------------------------------------------------- */
/* Espace client                                                              */
/* -------------------------------------------------------------------------- */

export type ClientMailRow = Pick<
  MailItem,
  | 'id'
  | 'kind'
  | 'sender'
  | 'receivedAt'
  | 'note'
  | 'status'
  | 'openingRequestedAt'
  | 'openedAt'
  | 'clientId'
> & {
  clientName: string
  envelopeScanId: string | null
  contentScanId: string | null
}

/**
 * Boîte aux lettres : les plis des entreprises du compte, et d'elles seules.
 * Deux verrous : le filtre sur `client_id`, et la portée client de la
 * transaction (`inClientSpace`, ADR 019), qui tiendrait sans lui.
 */
export async function listMailForAccounts(accounts: ClientAccount[]): Promise<ClientMailRow[]> {
  if (accounts.length === 0) return []
  const clientIds = accounts.map((account) => account.clientId)

  const scanId = (side: MailScanSide) =>
    sql<string | null>`(
      select ${mailScans.id} from ${mailScans}
      where ${mailScans.mailItemId} = ${mailItems.id}
        and ${mailScans.side} = ${side}
        and ${mailScans.deletedAt} is null
      limit 1
    )`

  return inClientSpace(accounts, (tx) =>
    tx
      .select({
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
        envelopeScanId: scanId('envelope'),
        contentScanId: scanId('content'),
      })
      .from(mailItems)
      .innerJoin(clients, eq(clients.id, mailItems.clientId))
      .where(and(inArray(mailItems.clientId, clientIds), isNull(mailItems.deletedAt)))
      .orderBy(desc(mailItems.receivedAt))
      .limit(200),
  )
}

/**
 * Demande d'ouverture par le client. Rend `false` quand le pli n'est pas à
 * lui, ou plus dans un état qui le permet — un double clic, une demande déjà
 * faite par un collègue.
 */
export async function requestOpening(id: string, accounts: ClientAccount[]): Promise<boolean> {
  if (accounts.length === 0 || !isUuid(id)) return false
  return inClientSpace(accounts, async (tx) => {
    const [item] = await tx
      .select({ clientId: mailItems.clientId })
      .from(mailItems)
      .where(
        and(
          eq(mailItems.id, id),
          inArray(
            mailItems.clientId,
            accounts.map((account) => account.clientId),
          ),
          isNull(mailItems.deletedAt),
        ),
      )
      .limit(1)
    const account = item && accounts.find((candidate) => candidate.clientId === item.clientId)
    if (!account) return false

    const updated = await tx
      .update(mailItems)
      .set({
        status: 'opening_requested',
        openingRequestedAt: sql`now()`,
        openingRequestedBy: account.memberId,
      })
      .where(and(eq(mailItems.id, id), eq(mailItems.status, 'received')))
      .returning({ id: mailItems.id })
    return updated.length > 0
  })
}

/** Annulation, par toute personne de l'entreprise, tant que le pli est fermé. */
export async function cancelOpeningRequest(id: string, accounts: ClientAccount[]): Promise<boolean> {
  if (accounts.length === 0 || !isUuid(id)) return false
  const updated = await inClientSpace(accounts, (tx) =>
    tx
      .update(mailItems)
      .set({ status: 'received', openingRequestedAt: null, openingRequestedBy: null })
      .where(
        and(
          eq(mailItems.id, id),
          eq(mailItems.status, 'opening_requested'),
          inArray(
            mailItems.clientId,
            accounts.map((account) => account.clientId),
          ),
          isNull(mailItems.deletedAt),
        ),
      )
      .returning({ id: mailItems.id }),
  )
  return updated.length > 0
}

/* -------------------------------------------------------------------------- */
/* Consultation des numérisations                                             */
/* -------------------------------------------------------------------------- */

export type ScanToServe = Pick<MailScan, 'id' | 'side' | 'storageKey' | 'contentType'> & {
  receivedAt: Date
  clientId: string
}

const scanToServe = {
  id: mailScans.id,
  side: mailScans.side,
  storageKey: mailScans.storageKey,
  contentType: mailScans.contentType,
  receivedAt: mailItems.receivedAt,
  clientId: mailItems.clientId,
}

export async function findScanForStaff(scanId: string): Promise<ScanToServe | undefined> {
  if (!isUuid(scanId)) return undefined
  const [scan] = await withTenant(currentTenantId(), (tx) =>
    tx
      .select(scanToServe)
      .from(mailScans)
      .innerJoin(mailItems, eq(mailItems.id, mailScans.mailItemId))
      .where(and(eq(mailScans.id, scanId), isNull(mailScans.deletedAt)))
      .limit(1),
  )
  return scan
}

/** Le client ne lit que les numérisations de ses entreprises, pli non retiré. */
export async function findScanForAccounts(
  scanId: string,
  accounts: ClientAccount[],
): Promise<ScanToServe | undefined> {
  if (accounts.length === 0 || !isUuid(scanId)) return undefined
  const [scan] = await inClientSpace(accounts, (tx) =>
    tx
      .select(scanToServe)
      .from(mailScans)
      .innerJoin(mailItems, eq(mailItems.id, mailScans.mailItemId))
      .where(
        and(
          eq(mailScans.id, scanId),
          isNull(mailScans.deletedAt),
          isNull(mailItems.deletedAt),
          inArray(
            mailItems.clientId,
            accounts.map((account) => account.clientId),
          ),
        ),
      )
      .limit(1),
  )
  return scan
}

/**
 * Inscription au journal d'accès. Appelée avant de servir le fichier.
 *
 * La consultation d'un client s'inscrit sous la portée de l'entreprise
 * destinataire du pli (ADR 019) : une ligne de journal pour le courrier d'une
 * autre entreprise serait refusée par la base.
 */
export async function logScanView(
  view:
    | { viewer: 'staff'; mailScanId: string; staffMemberId: string; authUserId: string }
    | {
        viewer: 'client'
        mailScanId: string
        clientMemberId: string
        authUserId: string
        clientId: string
      },
): Promise<void> {
  if (view.viewer === 'client') {
    const { clientId, ...row } = view
    await inClientSpace([{ clientId }], (tx) => tx.insert(mailScanViews).values(row))
    return
  }
  await withTenant(currentTenantId(), (tx) => tx.insert(mailScanViews).values(view))
}
