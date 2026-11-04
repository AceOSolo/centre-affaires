import { randomUUID } from 'node:crypto'

import { and, asc, count, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, ne, notExists, sql, type SQL } from 'drizzle-orm'
import { alias, type AnyMySqlColumn } from 'drizzle-orm/mysql-core'

import { maintenant } from '../../db/columns.ts'
import { withTenant, type Transaction } from '../../db/index.ts'
import { insertReturning, updateReturning } from '../../db/returning.ts'
import { staffMembers } from '../../db/staff.ts'
import { sealDocument } from '../../lib/chiffrement-documents.ts'
import { deleteObject, putObject } from '../../lib/stockage.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { isUuid, uuidv7 } from '../../lib/uuid.ts'
import { inClientSpace, type ClientAccount } from '../clients/comptes.ts'
import { clientMembers, clients } from '../clients/schema.ts'
import { contracts } from '../contrats/schema.ts'
import { bookings } from '../reservations/schema.ts'
import { resources, resourceTypes, type ResourceType } from '../ressources/schema.ts'
import { sameFields } from './champs.ts'
import { InspectionRefusal, inspectionRefusalMessage } from './erreurs.ts'
import { inspectionStage, type InspectionStage } from './labels.ts'
import { defaultTemplates } from './modeles-defaut.ts'
import {
  canOpenEntry,
  canOpenExit,
  occupationKey,
  occupationProgress,
  type InspectionBrief,
  type OccupationProgress,
} from './occupations.ts'
import { photoExtensions, type PhotoContentType, type PhotoFile } from './photos.ts'
import {
  inspectionPhotos,
  inspectionPhotoViews,
  inspections,
  inspectionTemplates,
  inspectionTemplateVersions,
  type InspectionField,
  type InspectionKind,
  type InspectionStatus,
  type InspectionValues,
} from './schema.ts'

/**
 * Accès aux états des lieux (R06, R33, ADR 039).
 *
 * Les règles vivent en base (triggers `inspections_before_*`, `CA010` / `CA011`) ;
 * ce module lit, écrit, et traduit ses refus. Le back-office passe par
 * `withTenant()`, l'espace client par `inClientSpace()` (ADR 019) : un client
 * n'y voit que ses états des lieux clos, et n'y écrit que sa validation. La
 * base ne filtre pas les lectures (MySQL n'a pas de RLS) : chaque requête de
 * l'espace client porte son propre filtre sur `client_id`, `status = 'closed'`
 * et `deleted_at is null`.
 */

const author = alias(staffMembers, 'inspection_author')
const closer = alias(staffMembers, 'inspection_closer')
const publisher = alias(staffMembers, 'template_publisher')

/** Nom affiché d'un membre de l'équipe : son nom, à défaut son adresse. */
const staffName = (table: { fullName: AnyMySqlColumn; email: AnyMySqlColumn }) =>
  sql<string | null>`coalesce(${table.fullName}, ${table.email})`

/** Reformule un refus de la base en `InspectionRefusal` ; laisse remonter les pannes. */
async function translating<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    const message = inspectionRefusalMessage(error)
    if (message && !(error instanceof InspectionRefusal)) throw new InspectionRefusal(message)
    throw error
  }
}

/* -------------------------------------------------------------------------- */
/* Modèles                                                                    */
/* -------------------------------------------------------------------------- */

export type TemplateVersionRow = {
  id: string
  version: number
  fields: InspectionField[]
  createdAt: Date
  createdByName: string | null
}

export type TemplateOverview = {
  resourceType: ResourceType
  /** Modèle publié ; `null` tant que le type n'a que le modèle de départ. */
  template: { id: string; name: string } | null
  /** Dernière version, celle des nouveaux états des lieux. */
  current: TemplateVersionRow | null
  /** Toutes les versions, de la plus récente à la plus ancienne. */
  versions: TemplateVersionRow[]
}

async function loadTemplateOverviews(tx: Transaction): Promise<TemplateOverview[]> {
  const tenantId = currentTenantId()
  const [templates, versions] = await Promise.all([
    tx
      .select({
        id: inspectionTemplates.id,
        name: inspectionTemplates.name,
        resourceType: inspectionTemplates.resourceType,
      })
      .from(inspectionTemplates)
      .where(and(eq(inspectionTemplates.tenantId, tenantId), isNull(inspectionTemplates.deletedAt))),
    tx
      .select({
        id: inspectionTemplateVersions.id,
        templateId: inspectionTemplateVersions.templateId,
        version: inspectionTemplateVersions.version,
        fields: inspectionTemplateVersions.fields,
        createdAt: inspectionTemplateVersions.createdAt,
        createdByName: staffName(publisher),
      })
      .from(inspectionTemplateVersions)
      .leftJoin(publisher, eq(publisher.id, inspectionTemplateVersions.createdBy))
      .where(eq(inspectionTemplateVersions.tenantId, tenantId))
      .orderBy(desc(inspectionTemplateVersions.version)),
  ])

  return resourceTypes.map((resourceType) => {
    const template = templates.find((candidate) => candidate.resourceType === resourceType)
    const own = template
      ? versions
          .filter((version) => version.templateId === template.id)
          .map((version) => ({
            id: version.id,
            version: version.version,
            fields: version.fields,
            createdAt: version.createdAt,
            createdByName: version.createdByName,
          }))
      : []
    return {
      resourceType,
      template: template ? { id: template.id, name: template.name } : null,
      current: own[0] ?? null,
      versions: own,
    }
  })
}

export async function listTemplateOverviews(): Promise<TemplateOverview[]> {
  return withTenant(currentTenantId(), loadTemplateOverviews)
}

export async function findTemplateOverview(type: ResourceType): Promise<TemplateOverview> {
  const all = await listTemplateOverviews()
  return all.find((overview) => overview.resourceType === type)!
}

export type PublishOutcome = { status: 'published'; version: number } | { status: 'unchanged' }

/**
 * Publie une version du modèle d'un type : crée le modèle s'il n'existe pas,
 * et ajoute une version si son nom ou ses champs changent — jamais une
 * version identique à la précédente. Le nom est figé avec la version
 * (ADR 041) : un état des lieux saisi garde celui qu'il portait. Le numéro est la dernière
 * version + 1 ; deux publications simultanées, l'unicité en refuse une.
 */
export async function publishTemplateVersion(
  input: { resourceType: ResourceType; name: string; fields: InspectionField[] },
  staffMemberId: string,
): Promise<PublishOutcome> {
  return translating(() =>
    withTenant(currentTenantId(), (tx) => publishInTransaction(tx, input, staffMemberId)),
  )
}

/** Exporté pour les tests : la même écriture, dans une transaction donnée. */
export async function publishInTransaction(
  tx: Transaction,
  input: { resourceType: ResourceType; name: string; fields: InspectionField[] },
  staffMemberId: string | null,
): Promise<PublishOutcome> {
  const tenantId = currentTenantId()
  const [template] = await tx
    .select({ id: inspectionTemplates.id, name: inspectionTemplates.name })
    .from(inspectionTemplates)
    .where(
      and(
        eq(inspectionTemplates.tenantId, tenantId),
        eq(inspectionTemplates.resourceType, input.resourceType),
        isNull(inspectionTemplates.deletedAt),
      ),
    )
    .for('update')

  let templateId: string
  if (template) {
    templateId = template.id
    if (template.name !== input.name) {
      await tx
        .update(inspectionTemplates)
        .set({ name: input.name })
        .where(and(eq(inspectionTemplates.tenantId, tenantId), eq(inspectionTemplates.id, template.id)))
    }
  } else {
    const created = await insertReturning(tx, inspectionTemplates, {
      resourceType: input.resourceType,
      name: input.name,
    })
    templateId = created.id
  }

  const [latest] = await tx
    .select({
      version: inspectionTemplateVersions.version,
      name: inspectionTemplateVersions.name,
      fields: inspectionTemplateVersions.fields,
    })
    .from(inspectionTemplateVersions)
    .where(and(eq(inspectionTemplateVersions.tenantId, tenantId), eq(inspectionTemplateVersions.templateId, templateId)))
    .orderBy(desc(inspectionTemplateVersions.version))
    .limit(1)
  // Le nom est figé avec la version (ADR 041) : le renommer en publie une,
  // pour que les états des lieux déjà saisis gardent le leur.
  if (latest && latest.name === input.name && sameFields(latest.fields, input.fields)) {
    return { status: 'unchanged' }
  }

  const version = (latest?.version ?? 0) + 1
  await tx.insert(inspectionTemplateVersions).values({
    templateId,
    version,
    name: input.name,
    fields: input.fields,
    createdBy: staffMemberId,
  })
  return { status: 'published', version }
}

/**
 * Version en vigueur pour un type : la dernière publiée. Un type sans modèle
 * reçoit son modèle de départ, publié tel quel en version 1 — l'accueil n'est
 * jamais bloqué, et l'exploitant l'ajuste ensuite.
 */
export async function currentVersionFor(
  tx: Transaction,
  resourceType: ResourceType,
  staffMemberId: string | null,
): Promise<{ id: string; fields: InspectionField[] }> {
  const tenantId = currentTenantId()
  const latest = () =>
    tx
      .select({ id: inspectionTemplateVersions.id, fields: inspectionTemplateVersions.fields })
      .from(inspectionTemplateVersions)
      .innerJoin(
        inspectionTemplates,
        and(
          eq(inspectionTemplates.tenantId, inspectionTemplateVersions.tenantId),
          eq(inspectionTemplates.id, inspectionTemplateVersions.templateId),
        ),
      )
      .where(
        and(
          eq(inspectionTemplateVersions.tenantId, tenantId),
          eq(inspectionTemplates.resourceType, resourceType),
          isNull(inspectionTemplates.deletedAt),
        ),
      )
      .orderBy(desc(inspectionTemplateVersions.version))
      .limit(1)

  const [found] = await latest()
  if (found) return found
  await publishInTransaction(tx, { resourceType, ...defaultTemplates[resourceType] }, staffMemberId)
  const [published] = await latest()
  return published
}

/* -------------------------------------------------------------------------- */
/* Listes                                                                     */
/* -------------------------------------------------------------------------- */

export type InspectionListRow = {
  id: string
  kind: InspectionKind
  status: InspectionStatus
  stage: InspectionStage
  performedAt: Date
  closedAt: Date | null
  signedAt: Date | null
  resourceId: string
  resourceName: string
  resourceCode: string
  resourceType: ResourceType
  clientId: string
  clientName: string
  bookingId: string | null
  bookingTitle: string | null
  /** `bookings.kind` : `contract` pour l'occupation d'un contrat (ADR 018). */
  bookingKind: string | null
  bookingStartsAt: Date | null
  bookingEndsAt: Date | null
  contractId: string | null
  contractReference: string | null
  entryInspectionId: string | null
}

const listColumns = {
  id: inspections.id,
  kind: inspections.kind,
  status: inspections.status,
  performedAt: inspections.performedAt,
  closedAt: inspections.closedAt,
  signedAt: inspections.signedAt,
  deletedAt: inspections.deletedAt,
  resourceId: inspections.resourceId,
  resourceName: resources.name,
  resourceCode: resources.code,
  resourceType: resources.resourceType,
  clientId: inspections.clientId,
  clientName: clients.name,
  bookingId: inspections.bookingId,
  bookingTitle: bookings.title,
  bookingKind: bookings.kind,
  bookingStartsAt: bookings.startsAt,
  bookingEndsAt: bookings.endsAt,
  contractId: inspections.contractId,
  contractReference: contracts.reference,
  entryInspectionId: inspections.entryInspectionId,
}

function selectInspectionRows(tx: Transaction) {
  return tx
    .select(listColumns)
    .from(inspections)
    .innerJoin(
      resources,
      and(eq(resources.tenantId, inspections.tenantId), eq(resources.id, inspections.resourceId)),
    )
    .innerJoin(
      clients,
      and(eq(clients.tenantId, inspections.tenantId), eq(clients.id, inspections.clientId)),
    )
    .leftJoin(
      bookings,
      and(eq(bookings.tenantId, inspections.tenantId), eq(bookings.id, inspections.bookingId)),
    )
    .leftJoin(
      contracts,
      and(eq(contracts.tenantId, inspections.tenantId), eq(contracts.id, inspections.contractId)),
    )
}

const toListRow = ({
  deletedAt,
  ...row
}: Omit<InspectionListRow, 'stage'> & { deletedAt: Date | null }): InspectionListRow => ({
  ...row,
  stage: inspectionStage({ status: row.status, signedAt: row.signedAt, deletedAt }),
})

export type InspectionFilter = {
  resourceId?: string
  bookingId?: string
  contractId?: string
  clientId?: string
  /** Étape : entrée ou sortie. */
  kind?: InspectionKind
  /** État ; `closed` réunit « à valider » et « validé ». */
  stage?: Exclude<InspectionStage, 'withdrawn'> | 'closed'
  /** Types de ressource d'un produit (ADR 046). */
  resourceTypes?: readonly ResourceType[]
  /** Période : `performed_at` dans `[from, until)`. */
  from?: Date
  until?: Date
}

/** Conditions d'un filtre, `tenant_id` en tête (décision 1) ; brouillons retirés exclus. */
function filterConditions(tenantId: string, filter: InspectionFilter): SQL[] {
  const conditions = [eq(inspections.tenantId, tenantId), isNull(inspections.deletedAt)]
  if (filter.resourceId) conditions.push(eq(inspections.resourceId, filter.resourceId))
  if (filter.bookingId) conditions.push(eq(inspections.bookingId, filter.bookingId))
  if (filter.contractId) conditions.push(eq(inspections.contractId, filter.contractId))
  if (filter.clientId) conditions.push(eq(inspections.clientId, filter.clientId))
  if (filter.kind) conditions.push(eq(inspections.kind, filter.kind))
  if (filter.stage === 'draft') conditions.push(eq(inspections.status, 'draft'))
  if (filter.stage === 'closed') conditions.push(eq(inspections.status, 'closed'))
  if (filter.stage === 'to_sign') {
    conditions.push(eq(inspections.status, 'closed'), isNull(inspections.signedAt))
  }
  if (filter.stage === 'signed') conditions.push(isNotNull(inspections.signedAt))
  if (filter.resourceTypes) conditions.push(inArray(resources.resourceType, [...filter.resourceTypes]))
  if (filter.from) conditions.push(gte(inspections.performedAt, filter.from))
  if (filter.until) conditions.push(lt(inspections.performedAt, filter.until))
  return conditions
}

/**
 * États des lieux du centre, les plus récents d'abord ; brouillons retirés
 * exclus. La lecture porte son filtre `tenant_id` (décision 1).
 */
export async function listInspections(filter: InspectionFilter = {}, limit = 200): Promise<InspectionListRow[]> {
  const tenantId = currentTenantId()
  const rows = await withTenant(tenantId, (tx) =>
    selectInspectionRows(tx)
      .where(and(...filterConditions(tenantId, filter)))
      .orderBy(desc(inspections.performedAt), desc(inspections.id))
      .limit(limit),
  )
  return rows.map(toListRow)
}

export type InspectionPage = { rows: InspectionListRow[]; total: number; page: number }

/**
 * Historique filtré, page par page (ADR 063) : le total d'abord, puis la page
 * demandée — ramenée à la dernière si elle la dépasse.
 */
export async function searchInspections(
  filter: InspectionFilter,
  { page, pageSize }: { page: number; pageSize: number },
): Promise<InspectionPage> {
  const tenantId = currentTenantId()
  return withTenant(tenantId, async (tx) => {
    const where = and(...filterConditions(tenantId, filter))
    const [{ total }] = await tx
      .select({ total: count() })
      .from(inspections)
      .innerJoin(
        resources,
        and(eq(resources.tenantId, inspections.tenantId), eq(resources.id, inspections.resourceId)),
      )
      .where(where)
    const last = Math.max(1, Math.ceil(total / pageSize))
    const current = Math.min(Math.max(1, page), last)
    const rows = await selectInspectionRows(tx)
      .where(where)
      .orderBy(desc(inspections.performedAt), desc(inspections.id))
      .limit(pageSize)
      .offset((current - 1) * pageSize)
    return { rows: rows.map(toListRow), total, page: current }
  })
}

export type InspectionFilterOptions = {
  clients: { id: string; name: string }[]
  resources: { id: string; name: string; code: string }[]
}

/** Clients et ressources qui ont au moins un état des lieux : les choix des filtres. */
export async function listInspectionFilterOptions(): Promise<InspectionFilterOptions> {
  const tenantId = currentTenantId()
  return withTenant(tenantId, async (tx) => {
    const live = and(eq(inspections.tenantId, tenantId), isNull(inspections.deletedAt))
    const clientRows = await tx
      .selectDistinct({ id: clients.id, name: clients.name })
      .from(inspections)
      .innerJoin(clients, and(eq(clients.tenantId, inspections.tenantId), eq(clients.id, inspections.clientId)))
      .where(live)
      .orderBy(asc(clients.name))
    const resourceRows = await tx
      .selectDistinct({ id: resources.id, name: resources.name, code: resources.code })
      .from(inspections)
      .innerJoin(
        resources,
        and(eq(resources.tenantId, inspections.tenantId), eq(resources.id, inspections.resourceId)),
      )
      .where(live)
      .orderBy(asc(resources.name))
    return { clients: clientRows, resources: resourceRows }
  })
}

/** Une ligne de la chronologie d'une ressource ; pour une entrée, depuis quand elle n'est pas restituée. */
export type TimelineRow = InspectionListRow & { unreturnedSince: Date | null }

/**
 * États des lieux vivants d'une ressource, pour sa chronologie (ADR 063). La
 * situation « non restituée » vient de la base (`inspection_unreturned_since`,
 * `85-restitution.sql`), la fonction que lit son trigger.
 */
export async function listResourceTimeline(resourceId: string, limit = 400): Promise<TimelineRow[]> {
  if (!isUuid(resourceId)) return []
  const tenantId = currentTenantId()
  return withTenant(tenantId, async (tx) => {
    const rows = (
      await selectInspectionRows(tx)
        .where(and(...filterConditions(tenantId, { resourceId })))
        .orderBy(desc(inspections.performedAt), desc(inspections.id))
        .limit(limit)
    ).map(toListRow)
    // Seules les entrées closes sans sortie close peuvent être en retard.
    const returned = new Set(
      rows.flatMap((row) => (row.kind === 'exit' && row.status === 'closed' && row.entryInspectionId ? [row.entryInspectionId] : [])),
    )
    const entries = rows
      .filter((row) => row.kind === 'entry' && row.status === 'closed' && !returned.has(row.id))
      .map((row) => row.id)
    const since = new Map<string, Date>()
    if (entries.length > 0) {
      const found = await tx
        .select({
          id: inspections.id,
          since: sql<Date | null>`inspection_unreturned_since(${inspections.tenantId}, ${inspections.id})`.mapWith(
            inspections.performedAt,
          ),
        })
        .from(inspections)
        .where(and(eq(inspections.tenantId, tenantId), inArray(inspections.id, entries)))
      for (const row of found) if (row.since) since.set(row.id, row.since)
    }
    return rows.map((row) => ({ ...row, unreturnedSince: since.get(row.id) ?? null }))
  })
}

/* -------------------------------------------------------------------------- */
/* Fiche                                                                      */
/* -------------------------------------------------------------------------- */

export type InspectionPhotoRow = {
  id: string
  fieldId: string | null
  caption: string | null
  /** Nulles pour un PDF (ADR 056). */
  width: number | null
  height: number | null
  position: number
}

export type InspectionSide = {
  id: string
  performedAt: Date
  closedAt: Date | null
  values: InspectionValues
  fields: InspectionField[]
  version: number
}

export type InspectionDetail = {
  id: string
  kind: InspectionKind
  status: InspectionStatus
  stage: InspectionStage
  performedAt: Date
  values: InspectionValues
  observations: string | null
  createdAt: Date
  closedAt: Date | null
  signedAt: Date | null
  clientRemarks: string | null
  deletedAt: Date | null
  entryInspectionId: string | null
  resource: { id: string; name: string; code: string; resourceType: ResourceType }
  client: { id: string; name: string }
  booking: { id: string; title: string; startsAt: Date; endsAt: Date; kind: string } | null
  contract: { id: string; reference: string } | null
  template: { versionId: string; version: number; fields: InspectionField[]; name: string }
  createdByName: string | null
  closedByName: string | null
  signedByName: string | null
  /** Photos présentes, dans l'ordre de dépôt de chaque champ. */
  photos: InspectionPhotoRow[]
  /** Photos effacées au terme de leur conservation (après la clôture). */
  purgedPhotoCount: number
  /** Pour une sortie : son entrée, pour la comparaison. */
  entry: InspectionSide | null
  /** Pour une entrée : sa sortie, si elle existe. */
  exit: { id: string; stage: InspectionStage } | null
}

async function loadDetail(tx: Transaction, id: string, clientIds?: readonly string[]) {
  const conditions = [eq(inspections.id, id)]
  // Second verrou de l'espace client : le filtre, en plus de la portée.
  if (clientIds) {
    conditions.push(
      inArray(inspections.clientId, [...clientIds]),
      eq(inspections.status, 'closed'),
      isNull(inspections.deletedAt),
    )
  }
  const [row] = await tx
    .select({
      inspection: inspections,
      resource: {
        id: resources.id,
        name: resources.name,
        code: resources.code,
        resourceType: resources.resourceType,
      },
      clientName: clients.name,
      bookingTitle: bookings.title,
      bookingStartsAt: bookings.startsAt,
      bookingEndsAt: bookings.endsAt,
      bookingKind: bookings.kind,
      contractReference: contracts.reference,
      version: inspectionTemplateVersions.version,
      fields: inspectionTemplateVersions.fields,
      // Le nom figé avec la version : celui que portait l'état des lieux.
      templateName: inspectionTemplateVersions.name,
      createdByName: staffName(author),
      // Le client voit le nom du membre de l'équipe, jamais son adresse.
      closedByName: clientIds ? sql<string | null>`${closer.fullName}` : staffName(closer),
      signedByName: sql<string | null>`coalesce(${clientMembers.fullName}, ${clientMembers.email})`,
    })
    .from(inspections)
    .innerJoin(
      resources,
      and(eq(resources.tenantId, inspections.tenantId), eq(resources.id, inspections.resourceId)),
    )
    .innerJoin(
      clients,
      and(eq(clients.tenantId, inspections.tenantId), eq(clients.id, inspections.clientId)),
    )
    .innerJoin(
      inspectionTemplateVersions,
      and(
        eq(inspectionTemplateVersions.tenantId, inspections.tenantId),
        eq(inspectionTemplateVersions.id, inspections.templateVersionId),
      ),
    )
    .innerJoin(
      inspectionTemplates,
      and(
        eq(inspectionTemplates.tenantId, inspectionTemplateVersions.tenantId),
        eq(inspectionTemplates.id, inspectionTemplateVersions.templateId),
      ),
    )
    .leftJoin(author, eq(author.id, inspections.createdBy))
    .leftJoin(closer, eq(closer.id, inspections.closedBy))
    .leftJoin(
      bookings,
      and(eq(bookings.tenantId, inspections.tenantId), eq(bookings.id, inspections.bookingId)),
    )
    .leftJoin(
      contracts,
      and(eq(contracts.tenantId, inspections.tenantId), eq(contracts.id, inspections.contractId)),
    )
    .leftJoin(
      clientMembers,
      and(
        eq(clientMembers.tenantId, inspections.tenantId),
        eq(clientMembers.id, inspections.signedByMemberId),
      ),
    )
    .where(and(...conditions))
    .limit(1)
  if (!row) return undefined
  const inspection = row.inspection

  const photoRows = await tx
    .select({
      id: inspectionPhotos.id,
      fieldId: inspectionPhotos.fieldId,
      caption: inspectionPhotos.caption,
      width: inspectionPhotos.width,
      height: inspectionPhotos.height,
      position: inspectionPhotos.position,
      createdAt: inspectionPhotos.createdAt,
      deletedAt: inspectionPhotos.deletedAt,
    })
    .from(inspectionPhotos)
    .where(eq(inspectionPhotos.inspectionId, id))
    .orderBy(asc(inspectionPhotos.position), asc(inspectionPhotos.createdAt))

  const photos = photoRows
    .filter((photo) => photo.deletedAt === null)
    .map((photo) => ({
      id: photo.id,
      fieldId: photo.fieldId,
      caption: photo.caption,
      width: photo.width,
      height: photo.height,
      position: photo.position,
    }))
  // Une photo retirée après la clôture ne peut l'avoir été que par la purge.
  const purgedPhotoCount = photoRows.filter(
    (photo) =>
      photo.deletedAt !== null &&
      inspection.closedAt !== null &&
      photo.deletedAt.getTime() >= inspection.closedAt.getTime(),
  ).length

  // Sous portée client, l'entrée et la sortie liées ne se lisent que si elles
  // sont closes et de l'entreprise : un brouillon de sortie reste invisible.
  const visible: SQL[] = clientIds
    ? [
        inArray(inspections.clientId, [...clientIds]),
        eq(inspections.status, 'closed'),
        isNull(inspections.deletedAt),
      ]
    : []

  let entry: InspectionSide | null = null
  if (inspection.entryInspectionId) {
    const [found] = await tx
      .select({
        id: inspections.id,
        performedAt: inspections.performedAt,
        closedAt: inspections.closedAt,
        values: inspections.values,
        fields: inspectionTemplateVersions.fields,
        version: inspectionTemplateVersions.version,
      })
      .from(inspections)
      .innerJoin(
        inspectionTemplateVersions,
        and(
          eq(inspectionTemplateVersions.tenantId, inspections.tenantId),
          eq(inspectionTemplateVersions.id, inspections.templateVersionId),
        ),
      )
      .where(and(eq(inspections.id, inspection.entryInspectionId), ...visible))
      .limit(1)
    entry = found ?? null
  }

  let exit: InspectionDetail['exit'] = null
  if (inspection.kind === 'entry') {
    const [found] = await tx
      .select({
        id: inspections.id,
        status: inspections.status,
        signedAt: inspections.signedAt,
        deletedAt: inspections.deletedAt,
      })
      .from(inspections)
      .where(and(eq(inspections.entryInspectionId, id), isNull(inspections.deletedAt), ...visible))
      .limit(1)
    if (found) exit = { id: found.id, stage: inspectionStage(found) }
  }

  const detail: InspectionDetail = {
    id: inspection.id,
    kind: inspection.kind,
    status: inspection.status,
    stage: inspectionStage(inspection),
    performedAt: inspection.performedAt,
    values: inspection.values,
    observations: inspection.observations,
    createdAt: inspection.createdAt,
    closedAt: inspection.closedAt,
    signedAt: inspection.signedAt,
    clientRemarks: inspection.clientRemarks,
    deletedAt: inspection.deletedAt,
    entryInspectionId: inspection.entryInspectionId,
    resource: row.resource,
    client: { id: inspection.clientId, name: row.clientName },
    booking:
      inspection.bookingId && row.bookingTitle && row.bookingStartsAt && row.bookingEndsAt
        ? {
            id: inspection.bookingId,
            title: row.bookingTitle,
            startsAt: row.bookingStartsAt,
            endsAt: row.bookingEndsAt,
            kind: row.bookingKind ?? 'booking',
          }
        : null,
    contract:
      inspection.contractId && row.contractReference
        ? { id: inspection.contractId, reference: row.contractReference }
        : null,
    template: {
      versionId: inspection.templateVersionId,
      version: row.version,
      fields: row.fields,
      name: row.templateName,
    },
    createdByName: row.createdByName,
    closedByName: row.closedByName,
    signedByName: row.signedByName,
    photos,
    purgedPhotoCount,
    entry,
    exit,
  }
  return detail
}

export async function findInspection(id: string): Promise<InspectionDetail | undefined> {
  if (!isUuid(id)) return undefined
  return withTenant(currentTenantId(), (tx) => loadDetail(tx, id))
}

/* -------------------------------------------------------------------------- */
/* Création                                                                   */
/* -------------------------------------------------------------------------- */

/** D'où part la saisie : une réservation, un contrat, ou une ressource. */
export type CandidateContext =
  | { kind: 'booking'; id: string }
  | { kind: 'contract'; id: string }
  | { kind: 'resource'; id: string }

/** Une occupation à laquelle rattacher un état des lieux. */
export type OccupationCandidate = {
  /** Clé stable, recalculée côté serveur : le formulaire ne transporte qu'elle. */
  key: string
  resource: { id: string; name: string; code: string; resourceType: ResourceType }
  client: { id: string; name: string }
  bookingId: string | null
  bookingTitle: string | null
  bookingKind: string | null
  contractId: string | null
  contractReference: string | null
  startsAt: Date | null
  endsAt: Date | null
  /**
   * Où en est l'occupation (ADR 063) : une entrée ne s'ouvre que si elle n'en
   * a pas, une sortie clôt l'entrée close qui l'attend.
   */
  progress: OccupationProgress
  /** L'entrée vivante de l'occupation, s'il y en a une. */
  entry: { id: string; performedAt: Date; status: InspectionStatus } | null
}

type BareCandidate = Omit<OccupationCandidate, 'progress' | 'entry'>

/**
 * États des lieux vivants des ressources des occupations, puis l'étape de
 * chacune (`occupationProgress`, occupations.ts) — dans la transaction de
 * l'appelant, pour que l'ouverture revérifie ce que l'écran a montré.
 */
async function withProgress(tx: Transaction, candidates: BareCandidate[]): Promise<OccupationCandidate[]> {
  if (candidates.length === 0) return []
  const resourceIds = [...new Set(candidates.map((candidate) => candidate.resource.id))]
  const rows = await tx
    .select({
      id: inspections.id,
      kind: inspections.kind,
      status: inspections.status,
      resourceId: inspections.resourceId,
      bookingId: inspections.bookingId,
      bookingKind: bookings.kind,
      contractId: inspections.contractId,
      entryInspectionId: inspections.entryInspectionId,
      performedAt: inspections.performedAt,
    })
    .from(inspections)
    .leftJoin(bookings, and(eq(bookings.tenantId, inspections.tenantId), eq(bookings.id, inspections.bookingId)))
    .where(
      and(
        eq(inspections.tenantId, currentTenantId()),
        inArray(inspections.resourceId, resourceIds),
        isNull(inspections.deletedAt),
      ),
    )
  const briefs: InspectionBrief[] = rows
  return candidates.map((candidate) => {
    const key = occupationKey({
      resourceId: candidate.resource.id,
      bookingId: candidate.bookingId,
      bookingKind: candidate.bookingKind,
      contractId: candidate.contractId,
    })
    const progress: OccupationProgress = key ? occupationProgress(key, briefs) : { step: 'none' }
    const found = 'entryId' in progress ? rows.find((row) => row.id === progress.entryId) : undefined
    return {
      ...candidate,
      progress,
      entry: found ? { id: found.id, performedAt: found.performedAt, status: found.status } : null,
    }
  })
}

/** Fenêtre des occupations proposées depuis la fiche d'une ressource. */
const RESOURCE_PAST_DAYS = 120
const RESOURCE_FUTURE_DAYS = 60

async function candidatesIn(
  tx: Transaction,
  context: CandidateContext,
  now: Date,
): Promise<OccupationCandidate[]> {
  return withProgress(tx, await bareCandidatesIn(tx, context, now))
}

async function bareCandidatesIn(
  tx: Transaction,
  context: CandidateContext,
  now: Date,
): Promise<BareCandidate[]> {
  const occupationColumns = {
    bookingId: bookings.id,
    bookingTitle: bookings.title,
    bookingKind: bookings.kind,
    startsAt: bookings.startsAt,
    endsAt: bookings.endsAt,
    contractId: bookings.contractId,
    contractReference: contracts.reference,
    resource: {
      id: resources.id,
      name: resources.name,
      code: resources.code,
      resourceType: resources.resourceType,
    },
    clientId: clients.id,
    clientName: clients.name,
  }
  const occupations = () =>
    tx
      .select(occupationColumns)
      .from(bookings)
      .innerJoin(
        resources,
        and(eq(resources.tenantId, bookings.tenantId), eq(resources.id, bookings.resourceId)),
      )
      .innerJoin(
        clients,
        and(eq(clients.tenantId, bookings.tenantId), eq(clients.id, bookings.clientId)),
      )
      .leftJoin(
        contracts,
        and(eq(contracts.tenantId, bookings.tenantId), eq(contracts.id, bookings.contractId)),
      )

  const fromBooking = (row: {
    bookingId: string
    bookingTitle: string
    bookingKind: string
    startsAt: Date
    endsAt: Date
    contractId: string | null
    contractReference: string | null
    resource: OccupationCandidate['resource']
    clientId: string
    clientName: string
  }): BareCandidate => ({
    key: `b:${row.bookingId}`,
    resource: row.resource,
    client: { id: row.clientId, name: row.clientName },
    bookingId: row.bookingId,
    bookingTitle: row.bookingTitle,
    bookingKind: row.bookingKind,
    contractId: row.contractId,
    contractReference: row.contractReference,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
  })

  const draftContracts = (where: SQL | undefined) =>
    tx
      .select({
        contractId: contracts.id,
        contractReference: contracts.reference,
        resource: {
          id: resources.id,
          name: resources.name,
          code: resources.code,
          resourceType: resources.resourceType,
        },
        clientId: clients.id,
        clientName: clients.name,
      })
      .from(contracts)
      .innerJoin(
        resources,
        and(eq(resources.tenantId, contracts.tenantId), eq(resources.id, contracts.resourceId)),
      )
      .innerJoin(
        clients,
        and(eq(clients.tenantId, contracts.tenantId), eq(clients.id, contracts.clientId)),
      )
      .where(where)

  const fromContract = (row: {
    contractId: string
    contractReference: string
    resource: OccupationCandidate['resource']
    clientId: string
    clientName: string
  }): BareCandidate => ({
    key: `c:${row.contractId}:${row.resource.id}`,
    resource: row.resource,
    client: { id: row.clientId, name: row.clientName },
    bookingId: null,
    bookingTitle: null,
    bookingKind: null,
    contractId: row.contractId,
    contractReference: row.contractReference,
    startsAt: null,
    endsAt: null,
  })

  switch (context.kind) {
    case 'booking': {
      const rows = await occupations()
        .where(and(eq(bookings.id, context.id), ne(bookings.status, 'cancelled')))
        .limit(1)
      return rows.map(fromBooking)
    }
    case 'contract': {
      // L'occupation matérialise le contrat sur sa ressource (ADR 018) : une
      // par ressource occupée, avenants de ressource compris.
      const rows = await occupations()
        .where(
          and(
            eq(bookings.contractId, context.id),
            eq(bookings.kind, 'contract'),
            ne(bookings.status, 'cancelled'),
          ),
        )
        .orderBy(asc(bookings.startsAt))
      if (rows.length > 0) return rows.map(fromBooking)
      // Contrat pas encore actif : sa ressource prévue, sans occupation.
      const drafts = await draftContracts(
        and(eq(contracts.id, context.id), isNull(contracts.deletedAt), isNotNull(contracts.resourceId)),
      )
      return drafts.map(fromContract)
    }
    case 'resource': {
      const since = new Date(now.getTime() - RESOURCE_PAST_DAYS * 86_400_000)
      const until = new Date(now.getTime() + RESOURCE_FUTURE_DAYS * 86_400_000)
      const rows = await occupations()
        .where(
          and(
            eq(bookings.resourceId, context.id),
            ne(bookings.status, 'cancelled'),
            gt(bookings.endsAt, since),
            lt(bookings.startsAt, until),
          ),
        )
        .orderBy(desc(bookings.startsAt))
        .limit(50)
      const drafts = await draftContracts(
        and(
          eq(contracts.resourceId, context.id),
          eq(contracts.status, 'draft'),
          isNull(contracts.deletedAt),
        ),
      )
      return [...rows.map(fromBooking), ...drafts.map(fromContract)]
    }
  }
}

export async function listOccupationCandidates(
  context: CandidateContext,
  now: Date = new Date(),
): Promise<OccupationCandidate[]> {
  if (!isUuid(context.id)) return []
  return withTenant(currentTenantId(), (tx) => candidatesIn(tx, context, now))
}

/** Entrées closes d'un client sur une ressource, sans sortie encore : celles qu'une sortie peut clore. */
async function openEntriesIn(tx: Transaction, clientId: string, resourceId: string) {
  const exitOf = alias(inspections, 'exit_inspection')
  return tx
    .select({
      id: inspections.id,
      performedAt: inspections.performedAt,
      bookingId: inspections.bookingId,
      contractId: inspections.contractId,
    })
    .from(inspections)
    .where(
      and(
        eq(inspections.clientId, clientId),
        eq(inspections.resourceId, resourceId),
        eq(inspections.kind, 'entry'),
        eq(inspections.status, 'closed'),
        isNull(inspections.deletedAt),
        notExists(
          tx
            .select({ one: sql`1` })
            .from(exitOf)
            .where(and(eq(exitOf.entryInspectionId, inspections.id), isNull(exitOf.deletedAt))),
        ),
      ),
    )
    .orderBy(desc(inspections.performedAt))
}

export type OpenEntry = Awaited<ReturnType<typeof openEntriesIn>>[number]

export async function listOpenEntries(clientId: string, resourceId: string): Promise<OpenEntry[]> {
  if (!isUuid(clientId) || !isUuid(resourceId)) return []
  return withTenant(currentTenantId(), (tx) => openEntriesIn(tx, clientId, resourceId))
}

export type NewInspectionInput = {
  context: CandidateContext
  candidateKey: string
  kind: InspectionKind
  /** Sortie seulement : l'entrée qu'elle clôt, ou `null` (entrée jamais faite). */
  entryInspectionId: string | null
  performedAt: Date
}

/**
 * Ouvre un état des lieux en brouillon, avec la version en vigueur du modèle
 * du type de la ressource. L'occupation est retrouvée côté serveur à partir
 * de sa clé : le formulaire ne choisit ni la ressource, ni le client.
 */
export async function createInspection(
  input: NewInspectionInput,
  staffMemberId: string,
  now: Date = new Date(),
): Promise<string> {
  return translating(() =>
    withTenant(currentTenantId(), async (tx) => {
      const candidates = await candidatesIn(tx, input.context, now)
      const candidate = candidates.find((option) => option.key === input.candidateKey)
      if (!candidate) {
        throw new InspectionRefusal(
          'Cette occupation n’est plus disponible : elle a été annulée ou modifiée. Rechargez la page.',
        )
      }

      // Une entrée par occupation, et la sortie d'une occupation clôt son
      // entrée (ADR 063). La base refuse aussi une seconde entrée (CA011).
      const { progress } = candidate
      if (input.kind === 'entry' && !canOpenEntry(progress)) {
        throw new InspectionRefusal(
          progress.step === 'entry_draft'
            ? 'Cette occupation a déjà son état des lieux d’entrée, en saisie : reprenez-le plutôt que d’en ouvrir un second.'
            : 'Cette occupation a déjà son état des lieux d’entrée : seule la sortie reste à faire.',
        )
      }
      if (input.kind === 'exit' && !canOpenExit(progress)) {
        throw new InspectionRefusal(
          progress.step === 'entry_draft'
            ? 'L’entrée de cette occupation est en saisie : terminez-la et close-la avant d’ouvrir la sortie.'
            : 'Cette occupation a déjà son état des lieux de sortie : reprenez-le plutôt que d’en ouvrir un second.',
        )
      }

      let entryInspectionId: string | null = null
      if (input.kind === 'exit' && progress.step === 'entry_closed') {
        // L'entrée de l'occupation, sans choix : c'est sa sortie qui rend la ressource.
        entryInspectionId = progress.entryId
      } else if (input.kind === 'exit' && input.entryInspectionId) {
        const entries = await openEntriesIn(tx, candidate.client.id, candidate.resource.id)
        if (!entries.some((entry) => entry.id === input.entryInspectionId)) {
          throw new InspectionRefusal(
            'Cet état des lieux d’entrée n’est plus disponible : il a déjà sa sortie, ou il n’est pas clos.',
          )
        }
        entryInspectionId = input.entryInspectionId
      }

      const version = await currentVersionFor(tx, candidate.resource.resourceType, staffMemberId)
      const id = uuidv7()
      await tx.insert(inspections).values({
        id,
        kind: input.kind,
        resourceId: candidate.resource.id,
        clientId: candidate.client.id,
        bookingId: candidate.bookingId,
        contractId: candidate.contractId,
        entryInspectionId,
        templateVersionId: version.id,
        performedAt: input.performedAt,
        createdBy: staffMemberId,
      })
      return id
    }),
  )
}

/* -------------------------------------------------------------------------- */
/* Saisie, clôture, retrait                                                   */
/* -------------------------------------------------------------------------- */

export type DraftInput = {
  values: InspectionValues
  observations: string | null
  performedAt: Date
}

/**
 * Enregistre un brouillon ; avec `closedBy`, le clôt dans la même écriture —
 * la base exige alors les champs obligatoires et pose la date de clôture.
 * Le `where` sur le statut : deux personnes sur le même brouillon, la
 * seconde à clore trouve un état figé.
 */
export async function saveInspection(
  id: string,
  input: DraftInput,
  closedBy: string | null,
): Promise<void> {
  await translating(() =>
    withTenant(currentTenantId(), async (tx) => {
      const [saved] = await updateReturning(
        tx,
        inspections,
        {
          values: input.values,
          observations: input.observations,
          performedAt: input.performedAt,
          ...(closedBy ? { status: 'closed' as const, closedBy } : {}),
        },
        and(eq(inspections.id, id), eq(inspections.status, 'draft'), isNull(inspections.deletedAt)),
      )
      if (!saved) {
        throw new InspectionRefusal('Cet état des lieux est clos ou retiré : il ne se modifie plus.')
      }
    }),
  )
}

/**
 * Retire un brouillon saisi par erreur (décision 6 : la ligne reste). Ses
 * photos sont retirées d'abord — la base les fige dès que l'état des lieux
 * est retiré —, puis leurs fichiers effacés : ils ne prouvent plus rien.
 */
export async function withdrawInspection(id: string): Promise<void> {
  const keys = await translating(() =>
    withTenant(currentTenantId(), async (tx) => {
      const photos = await updateReturning(
        tx,
        inspectionPhotos,
        { deletedAt: maintenant() },
        and(eq(inspectionPhotos.inspectionId, id), isNull(inspectionPhotos.deletedAt)),
      )
      const [withdrawn] = await updateReturning(
        tx,
        inspections,
        { deletedAt: maintenant() },
        and(eq(inspections.id, id), eq(inspections.status, 'draft'), isNull(inspections.deletedAt)),
      )
      if (!withdrawn) {
        throw new InspectionRefusal('Seul un brouillon se retire : un état des lieux clos reste.')
      }
      return photos.map((photo) => photo.storageKey)
    }),
  )
  await discard(keys)
}

/* -------------------------------------------------------------------------- */
/* Photos                                                                     */
/* -------------------------------------------------------------------------- */

async function discard(keys: string[]): Promise<void> {
  const results = await Promise.allSettled(keys.map((key) => deleteObject(key)))
  for (const result of results) {
    if (result.status === 'rejected') console.error('Photo d’état des lieux non effacée du stockage', result.reason)
  }
}

/**
 * Dépose une photo : chiffrée avant de partir (ADR 020), déposée, puis
 * inscrite. Une ligne ne désigne jamais un fichier absent ; un fichier sans
 * ligne, si l'écriture échoue, est effacé aussitôt.
 */
export async function addInspectionPhoto(
  inspectionId: string,
  input: { fieldId: string | null; caption: string | null; photo: PhotoFile },
  staffMemberId: string,
): Promise<string> {
  const tenantId = currentTenantId()
  // Clé sans rien de lisible : ni client ni ressource n'apparaissent au stockage.
  const key = `etats-des-lieux/${tenantId}/${randomUUID()}.${photoExtensions[input.photo.contentType]}`
  const sealed = sealDocument(input.photo.bytes, key)
  await putObject(key, sealed.bytes, 'application/octet-stream')

  try {
    return await translating(() =>
      withTenant(tenantId, async (tx) => {
        const [{ next }] = await tx
          .select({ next: sql<number>`coalesce(max(${inspectionPhotos.position}) + 1, 0)` })
          .from(inspectionPhotos)
          .where(
            and(
              eq(inspectionPhotos.inspectionId, inspectionId),
              input.fieldId === null
                ? isNull(inspectionPhotos.fieldId)
                : eq(inspectionPhotos.fieldId, input.fieldId),
            ),
          )
        const id = uuidv7()
        await tx.insert(inspectionPhotos).values({
          id,
          inspectionId,
          storageKey: key,
          encryptionKeyVersion: sealed.keyVersion,
          contentType: input.photo.contentType,
          byteSize: input.photo.bytes.byteLength,
          width: input.photo.width,
          height: input.photo.height,
          caption: input.caption,
          fieldId: input.fieldId,
          position: Math.min(Number(next), 32767),
          uploadedBy: staffMemberId,
        })
        return id
      }),
    )
  } catch (error) {
    await discard([key])
    throw error
  }
}

export async function captionInspectionPhoto(photoId: string, caption: string | null): Promise<void> {
  await translating(() =>
    withTenant(currentTenantId(), async (tx) => {
      const [photo] = await updateReturning(
        tx,
        inspectionPhotos,
        { caption },
        and(eq(inspectionPhotos.id, photoId), isNull(inspectionPhotos.deletedAt)),
      )
      if (!photo) throw new InspectionRefusal('Cette photo a été retirée.')
    }),
  )
}

/** Retire une photo d'un brouillon, puis efface son fichier. */
export async function removeInspectionPhoto(photoId: string): Promise<void> {
  const key = await translating(() =>
    withTenant(currentTenantId(), async (tx) => {
      const [photo] = await updateReturning(
        tx,
        inspectionPhotos,
        { deletedAt: maintenant() },
        and(eq(inspectionPhotos.id, photoId), isNull(inspectionPhotos.deletedAt)),
      )
      if (!photo) throw new InspectionRefusal('Cette photo a déjà été retirée.')
      return photo.storageKey
    }),
  )
  await discard([key])
}

export type PhotoToServe = {
  id: string
  inspectionId: string
  storageKey: string
  contentType: PhotoContentType
  encryptionKeyVersion: number
  clientId: string
  kind: InspectionKind
  performedAt: Date
}

const photoToServe = {
  id: inspectionPhotos.id,
  inspectionId: inspectionPhotos.inspectionId,
  storageKey: inspectionPhotos.storageKey,
  contentType: sql<PhotoContentType>`${inspectionPhotos.contentType}`,
  encryptionKeyVersion: inspectionPhotos.encryptionKeyVersion,
  clientId: inspections.clientId,
  kind: inspections.kind,
  performedAt: inspections.performedAt,
}

export async function findPhotoForStaff(photoId: string): Promise<PhotoToServe | undefined> {
  if (!isUuid(photoId)) return undefined
  const [photo] = await withTenant(currentTenantId(), (tx) =>
    tx
      .select(photoToServe)
      .from(inspectionPhotos)
      .innerJoin(
        inspections,
        and(
          eq(inspections.tenantId, inspectionPhotos.tenantId),
          eq(inspections.id, inspectionPhotos.inspectionId),
        ),
      )
      .where(and(eq(inspectionPhotos.id, photoId), isNull(inspectionPhotos.deletedAt)))
      .limit(1),
  )
  return photo
}

/** Le client ne lit que les photos des états des lieux clos de ses entreprises. */
export async function findPhotoForAccounts(
  photoId: string,
  accounts: ClientAccount[],
): Promise<PhotoToServe | undefined> {
  if (accounts.length === 0 || !isUuid(photoId)) return undefined
  const [photo] = await inClientSpace(accounts, (tx) =>
    tx
      .select(photoToServe)
      .from(inspectionPhotos)
      .innerJoin(
        inspections,
        and(
          eq(inspections.tenantId, inspectionPhotos.tenantId),
          eq(inspections.id, inspectionPhotos.inspectionId),
        ),
      )
      .where(
        and(
          eq(inspectionPhotos.id, photoId),
          isNull(inspectionPhotos.deletedAt),
          eq(inspections.status, 'closed'),
          isNull(inspections.deletedAt),
          inArray(
            inspections.clientId,
            accounts.map((account) => account.clientId),
          ),
        ),
      )
      .limit(1),
  )
  return photo
}

/**
 * Inscription au journal des consultations, avant de servir le fichier. Celle
 * d'un client s'inscrit sous la portée de l'entreprise de l'état des lieux
 * (ADR 019).
 */
export async function logInspectionPhotoView(
  view:
    | { viewer: 'staff'; photoId: string; staffMemberId: string; authUserId: string }
    | { viewer: 'client'; photoId: string; clientMemberId: string; authUserId: string; clientId: string },
): Promise<void> {
  if (view.viewer === 'client') {
    const { clientId, ...row } = view
    await inClientSpace([{ clientId }], (tx) => tx.insert(inspectionPhotoViews).values(row))
    return
  }
  await withTenant(currentTenantId(), (tx) => tx.insert(inspectionPhotoViews).values(view))
}

/* -------------------------------------------------------------------------- */
/* Espace client                                                              */
/* -------------------------------------------------------------------------- */

/** États des lieux clos des entreprises du compte, les plus récents d'abord. */
export async function listInspectionsForAccounts(accounts: ClientAccount[]): Promise<InspectionListRow[]> {
  if (accounts.length === 0) return []
  const rows = await inClientSpace(accounts, (tx) =>
    selectInspectionRows(tx)
      .where(
        and(
          inArray(
            inspections.clientId,
            accounts.map((account) => account.clientId),
          ),
          eq(inspections.status, 'closed'),
          isNull(inspections.deletedAt),
        ),
      )
      .orderBy(desc(inspections.performedAt), desc(inspections.id))
      .limit(200),
  )
  return rows.map(toListRow)
}

export async function findInspectionForAccounts(
  id: string,
  accounts: ClientAccount[],
): Promise<InspectionDetail | undefined> {
  if (accounts.length === 0 || !isUuid(id)) return undefined
  return inClientSpace(accounts, (tx) =>
    loadDetail(
      tx,
      id,
      accounts.map((account) => account.clientId),
    ),
  )
}

export type SignOutcome = 'signed' | 'already_signed' | 'not_found'

/**
 * Validation par le client : la personne connectée, au titre de l'entreprise
 * de l'état des lieux. La base pose la date, et refuse tout autre changement
 * (`CA010`). Une fois seulement : le `where` sur `signed_at`.
 */
export async function signInspection(
  id: string,
  accounts: ClientAccount[],
  remarks: string | null,
): Promise<SignOutcome> {
  if (accounts.length === 0 || !isUuid(id)) return 'not_found'
  const [target] = await inClientSpace(accounts, (tx) =>
    tx
      .select({ clientId: inspections.clientId, signedAt: inspections.signedAt })
      .from(inspections)
      .where(
        and(
          eq(inspections.id, id),
          eq(inspections.status, 'closed'),
          isNull(inspections.deletedAt),
          inArray(
            inspections.clientId,
            accounts.map((account) => account.clientId),
          ),
        ),
      )
      .limit(1),
  )
  if (!target) return 'not_found'
  if (target.signedAt) return 'already_signed'
  const account = accounts.find((candidate) => candidate.clientId === target.clientId)
  if (!account) return 'not_found'

  const signed = await translating(() =>
    inClientSpace([account], (tx) =>
      updateReturning(
        tx,
        inspections,
        { signedByMemberId: account.memberId, clientRemarks: remarks },
        and(
          eq(inspections.id, id),
          eq(inspections.clientId, account.clientId),
          eq(inspections.status, 'closed'),
          isNull(inspections.deletedAt),
          isNull(inspections.signedAt),
        ),
      ),
    ),
  )
  return signed.length > 0 ? 'signed' : 'already_signed'
}

/** Compte des états des lieux à valider, pour l'espace client. */
export function countToSign(rows: readonly InspectionListRow[]): number {
  return rows.filter((row) => row.stage === 'to_sign').length
}
