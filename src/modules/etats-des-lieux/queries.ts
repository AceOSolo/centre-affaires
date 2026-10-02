import { randomUUID } from 'node:crypto'

import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, ne, notExists, sql, type SQL } from 'drizzle-orm'
import { alias, type AnyPgColumn } from 'drizzle-orm/pg-core'

import { withTenant, type Transaction } from '../../db/index.ts'
import { staffMembers } from '../../db/staff.ts'
import { sealDocument } from '../../lib/chiffrement-documents.ts'
import { deleteObject, putObject } from '../../lib/stockage.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { isUuid } from '../../lib/uuid.ts'
import { inClientSpace, type ClientAccount } from '../clients/comptes.ts'
import { clientMembers, clients } from '../clients/schema.ts'
import { contracts } from '../contrats/schema.ts'
import { bookings } from '../reservations/schema.ts'
import { resources, resourceTypes, type ResourceType } from '../ressources/schema.ts'
import { sameFields } from './champs.ts'
import { InspectionRefusal, inspectionRefusalMessage } from './erreurs.ts'
import { inspectionStage, type InspectionStage } from './labels.ts'
import { defaultTemplates } from './modeles-defaut.ts'
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
 * Les règles vivent en base (garde `inspections_guard`, `CA010` / `CA011`) ;
 * ce module lit, écrit, et traduit ses refus. Le back-office passe par
 * `withTenant()`, l'espace client par `inClientSpace()` (ADR 019) : un client
 * n'y voit que ses états des lieux clos, et n'y écrit que sa validation.
 */

const author = alias(staffMembers, 'inspection_author')
const closer = alias(staffMembers, 'inspection_closer')
const publisher = alias(staffMembers, 'template_publisher')

/** Nom affiché d'un membre de l'équipe : son nom, à défaut son adresse. */
const staffName = (table: { fullName: AnyPgColumn; email: AnyPgColumn }) =>
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
  const [templates, versions] = await Promise.all([
    tx
      .select({
        id: inspectionTemplates.id,
        name: inspectionTemplates.name,
        resourceType: inspectionTemplates.resourceType,
      })
      .from(inspectionTemplates)
      .where(isNull(inspectionTemplates.deletedAt)),
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
  const [template] = await tx
    .select({ id: inspectionTemplates.id, name: inspectionTemplates.name })
    .from(inspectionTemplates)
    .where(
      and(
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
        .where(eq(inspectionTemplates.id, template.id))
    }
  } else {
    const [created] = await tx
      .insert(inspectionTemplates)
      .values({ resourceType: input.resourceType, name: input.name })
      .returning({ id: inspectionTemplates.id })
    templateId = created.id
  }

  const [latest] = await tx
    .select({
      version: inspectionTemplateVersions.version,
      name: inspectionTemplateVersions.name,
      fields: inspectionTemplateVersions.fields,
    })
    .from(inspectionTemplateVersions)
    .where(eq(inspectionTemplateVersions.templateId, templateId))
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
  bookingStartsAt: Date | null
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
  bookingStartsAt: bookings.startsAt,
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
  stage?: Exclude<InspectionStage, 'withdrawn'>
}

/** États des lieux du centre, les plus récents d'abord ; brouillons retirés exclus. */
export async function listInspections(filter: InspectionFilter = {}, limit = 200): Promise<InspectionListRow[]> {
  const conditions = [isNull(inspections.deletedAt)]
  if (filter.resourceId) conditions.push(eq(inspections.resourceId, filter.resourceId))
  if (filter.bookingId) conditions.push(eq(inspections.bookingId, filter.bookingId))
  if (filter.contractId) conditions.push(eq(inspections.contractId, filter.contractId))
  if (filter.stage === 'draft') conditions.push(eq(inspections.status, 'draft'))
  if (filter.stage === 'to_sign') {
    conditions.push(eq(inspections.status, 'closed'), isNull(inspections.signedAt))
  }
  if (filter.stage === 'signed') conditions.push(isNotNull(inspections.signedAt))

  const rows = await withTenant(currentTenantId(), (tx) =>
    selectInspectionRows(tx)
      .where(and(...conditions))
      .orderBy(desc(inspections.performedAt), desc(inspections.id))
      .limit(limit),
  )
  return rows.map(toListRow)
}

/* -------------------------------------------------------------------------- */
/* Fiche                                                                      */
/* -------------------------------------------------------------------------- */

export type InspectionPhotoRow = {
  id: string
  fieldId: string | null
  caption: string | null
  width: number
  height: number
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
      .where(eq(inspections.id, inspection.entryInspectionId))
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
      .where(and(eq(inspections.entryInspectionId, id), isNull(inspections.deletedAt)))
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
}

/** Fenêtre des occupations proposées depuis la fiche d'une ressource. */
const RESOURCE_PAST_DAYS = 120
const RESOURCE_FUTURE_DAYS = 60

async function candidatesIn(
  tx: Transaction,
  context: CandidateContext,
  now: Date,
): Promise<OccupationCandidate[]> {
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
  }): OccupationCandidate => ({
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
  }): OccupationCandidate => ({
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

      let entryInspectionId: string | null = null
      if (input.kind === 'exit' && input.entryInspectionId) {
        const entries = await openEntriesIn(tx, candidate.client.id, candidate.resource.id)
        if (!entries.some((entry) => entry.id === input.entryInspectionId)) {
          throw new InspectionRefusal(
            'Cet état des lieux d’entrée n’est plus disponible : il a déjà sa sortie, ou il n’est pas clos.',
          )
        }
        entryInspectionId = input.entryInspectionId
      }

      const version = await currentVersionFor(tx, candidate.resource.resourceType, staffMemberId)
      const [created] = await tx
        .insert(inspections)
        .values({
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
        .returning({ id: inspections.id })
      return created.id
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
      const [saved] = await tx
        .update(inspections)
        .set({
          values: input.values,
          observations: input.observations,
          performedAt: input.performedAt,
          ...(closedBy ? { status: 'closed' as const, closedBy } : {}),
        })
        .where(
          and(eq(inspections.id, id), eq(inspections.status, 'draft'), isNull(inspections.deletedAt)),
        )
        .returning({ id: inspections.id })
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
      const photos = await tx
        .update(inspectionPhotos)
        .set({ deletedAt: sql`now()` })
        .where(and(eq(inspectionPhotos.inspectionId, id), isNull(inspectionPhotos.deletedAt)))
        .returning({ storageKey: inspectionPhotos.storageKey })
      const [withdrawn] = await tx
        .update(inspections)
        .set({ deletedAt: sql`now()` })
        .where(
          and(eq(inspections.id, id), eq(inspections.status, 'draft'), isNull(inspections.deletedAt)),
        )
        .returning({ id: inspections.id })
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
          .select({ next: sql<number>`coalesce(max(${inspectionPhotos.position}) + 1, 0)::int` })
          .from(inspectionPhotos)
          .where(
            and(
              eq(inspectionPhotos.inspectionId, inspectionId),
              input.fieldId === null
                ? isNull(inspectionPhotos.fieldId)
                : eq(inspectionPhotos.fieldId, input.fieldId),
            ),
          )
        const [photo] = await tx
          .insert(inspectionPhotos)
          .values({
            inspectionId,
            storageKey: key,
            encryptionKeyVersion: sealed.keyVersion,
            contentType: input.photo.contentType,
            byteSize: input.photo.bytes.byteLength,
            width: input.photo.width,
            height: input.photo.height,
            caption: input.caption,
            fieldId: input.fieldId,
            position: Math.min(next, 32767),
            uploadedBy: staffMemberId,
          })
          .returning({ id: inspectionPhotos.id })
        return photo.id
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
      const [photo] = await tx
        .update(inspectionPhotos)
        .set({ caption })
        .where(and(eq(inspectionPhotos.id, photoId), isNull(inspectionPhotos.deletedAt)))
        .returning({ id: inspectionPhotos.id })
      if (!photo) throw new InspectionRefusal('Cette photo a été retirée.')
    }),
  )
}

/** Retire une photo d'un brouillon, puis efface son fichier. */
export async function removeInspectionPhoto(photoId: string): Promise<void> {
  const key = await translating(() =>
    withTenant(currentTenantId(), async (tx) => {
      const [photo] = await tx
        .update(inspectionPhotos)
        .set({ deletedAt: sql`now()` })
        .where(and(eq(inspectionPhotos.id, photoId), isNull(inspectionPhotos.deletedAt)))
        .returning({ storageKey: inspectionPhotos.storageKey })
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
      tx
        .update(inspections)
        .set({ signedByMemberId: account.memberId, clientRemarks: remarks })
        .where(
          and(
            eq(inspections.id, id),
            eq(inspections.clientId, account.clientId),
            eq(inspections.status, 'closed'),
            isNull(inspections.signedAt),
          ),
        )
        .returning({ id: inspections.id }),
    ),
  )
  return signed.length > 0 ? 'signed' : 'already_signed'
}

/** Compte des états des lieux à valider, pour l'espace client. */
export function countToSign(rows: readonly InspectionListRow[]): number {
  return rows.filter((row) => row.stage === 'to_sign').length
}
