import { sql } from 'drizzle-orm'
import {
  char,
  check,
  foreignKey,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  smallint,
  text,
  tinyint,
  unique,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core'

import { deletedAt, instant, primaryKeyId, timestamps } from '../../db/columns.ts'
import { staffMembers } from '../../db/staff.ts'
import { tenantId } from '../../db/tenants.ts'
import { clientMembers, clients } from '../clients/schema.ts'
import { contracts } from '../contrats/schema.ts'
import { bookings } from '../reservations/schema.ts'
import { resourceTypeEnum, resources } from '../ressources/schema.ts'

/**
 * États des lieux (R06, R33, ADR 016 décision D8, ADR 039).
 *
 * Les champs se configurent par type de ressource, en base : un modèle par
 * type, versionné. Un état des lieux garde la version avec laquelle il a été
 * saisi, même quand le modèle change ensuite. Les photos sont compressées
 * dans le navigateur, chiffrées au repos (ADR 020) et leurs consultations
 * journalisées, comme les numérisations de courrier.
 */

/** Types de champ d'un modèle. `condition` : note d'état sur l'échelle commune. */
export const inspectionFieldTypes = ['text', 'number', 'choice', 'checkbox', 'condition'] as const
export type InspectionFieldType = (typeof inspectionFieldTypes)[number]

/**
 * Échelle de la note d'état, du meilleur au pire. Miroir de
 * `inspection_values_error()` (`src/db/regles/80-etats-des-lieux.sql`).
 */
export const inspectionConditionLevels = ['neuf', 'bon', 'usage', 'mauvais'] as const
export type InspectionConditionLevel = (typeof inspectionConditionLevels)[number]

/**
 * Un champ du formulaire. Validé par la base (`inspection_fields_error()`, trigger des versions) :
 *
 * - `id` : `^[a-z][a-z0-9_]{0,62}$`, unique dans le modèle — c'est la clé de
 *   la valeur dans `inspections.values` et de `inspection_photos.field_id` ;
 * - `label` : libellé visible, non vide, 200 caractères au plus ;
 * - `type` : l'un de `inspectionFieldTypes` ;
 * - `required` : la valeur est exigée à la clôture ;
 * - `unit` : pour un nombre seulement (« kWh », « clés ») ;
 * - `options` : pour un choix seulement, 2 à 50 libellés distincts ;
 * - `help` : aide affichée sous le champ.
 */
export type InspectionField = {
  id: string
  label: string
  type: InspectionFieldType
  required: boolean
  unit?: string
  options?: string[]
  help?: string
}

/**
 * Valeurs saisies, par identifiant de champ : texte, nombre, libellé d'une
 * option, booléen, niveau de l'échelle. `null` ou absent : non renseigné.
 */
export type InspectionValues = Record<string, string | number | boolean | null>

/**
 * Modèle de formulaire d'un type de ressource. Un seul vivant par type ; son
 * contenu est dans ses versions, qui ne changent jamais.
 *
 * Lisible sous portée client (l'espace montre les libellés des champs),
 * modifiable seulement par le back-office.
 */
export const inspectionTemplates = mysqlTable(
  'inspection_templates',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    resourceType: resourceTypeEnum('resource_type').notNull(),
    name: text('name').notNull(),
    ...timestamps(),
    deletedAt: deletedAt(),
    live: tinyint('live').generatedAlwaysAs(sql`if(deleted_at is null, 1, null)`, {
      mode: 'virtual',
    }),
  },
  (table) => [
    unique('inspection_templates_tenant_id_id_key').on(table.tenantId, table.id),
    // Un seul modèle vivant par type : `live` (colonne générée) vaut NULL une
    // fois le modèle retiré, ce que l'index unique ignore.
    uniqueIndex('inspection_templates_type_key').on(table.tenantId, table.resourceType, table.live),
    check('inspection_templates_name_not_blank', sql`trim(${table.name}) <> ''`),
  ],
)

export type InspectionTemplate = typeof inspectionTemplates.$inferSelect
export type NewInspectionTemplate = typeof inspectionTemplates.$inferInsert

/**
 * Version d'un modèle : la liste de ses champs, figée. Modifier un modèle,
 * c'est en publier une version de plus (`version` = la précédente + 1, posée
 * par le code ; l'unicité tranche entre deux publications simultanées). La
 * base refuse tout `UPDATE` et tout `DELETE` sur cette table (triggers
 * `inspection_template_versions_before_update` / `_delete`).
 */
export const inspectionTemplateVersions = mysqlTable(
  'inspection_template_versions',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    templateId: char('template_id', { length: 36 }).notNull(),
    version: int('version').notNull(),
    /**
     * Nom du modèle à cette version (ADR 041) : un état des lieux clos montre
     * le nom qu'il portait, même si le modèle est renommé depuis. Renommer un
     * modèle en publie une version.
     */
    name: text('name').notNull(),
    fields: json('fields').$type<InspectionField[]>().notNull(),
    createdBy: char('created_by', { length: 36 }).references(() => staffMembers.id, { onDelete: 'restrict' }),
    createdAt: instant('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    unique('inspection_template_versions_tenant_id_id_key').on(table.tenantId, table.id),
    foreignKey({
      name: 'inspection_template_versions_template_fk',
      columns: [table.tenantId, table.templateId],
      foreignColumns: [inspectionTemplates.tenantId, inspectionTemplates.id],
    }).onDelete('restrict'),
    uniqueIndex('inspection_template_versions_version_key').on(
      table.tenantId,
      table.templateId,
      table.version,
    ),
    check('inspection_template_versions_version_positive', sql`${table.version} >= 1`),
    check('inspection_template_versions_name_not_blank', sql`trim(${table.name}) <> ''`),
    // `fields` est validé par le trigger `inspection_template_versions_before_insert`
    // (`inspection_fields_error()`) : MySQL refuse une routine stockée dans un check.
  ],
)

export type InspectionTemplateVersion = typeof inspectionTemplateVersions.$inferSelect
export type NewInspectionTemplateVersion = typeof inspectionTemplateVersions.$inferInsert

export const inspectionKinds = ['entry', 'exit'] as const
export type InspectionKind = (typeof inspectionKinds)[number]
export const inspectionKindEnum = (name: string) => mysqlEnum(name, inspectionKinds)

/**
 * `draft` : en saisie au centre, invisible du client, modifiable, retirable.
 * `closed` : clos par l'équipe, figé (SQLSTATE `CA010`) ; le client le voit
 * et le valide depuis son espace (`signed_at`, une fois).
 */
export const inspectionStatuses = ['draft', 'closed'] as const
export type InspectionStatus = (typeof inspectionStatuses)[number]
export const inspectionStatusEnum = (name: string) => mysqlEnum(name, inspectionStatuses)

/**
 * Un état des lieux d'entrée ou de sortie d'une ressource, pour un client, au
 * titre d'une réservation et/ou d'un contrat. Une sortie désigne l'entrée
 * qu'elle clôt (même ressource, même client).
 *
 * Garanties tenues par la base (`src/db/regles/80-etats-des-lieux.sql`, ADR 039) :
 *
 * - les valeurs suivent la version du modèle : clés connues, types justes,
 *   options et échelle respectées (`CA011`) ; à la clôture, tout champ
 *   obligatoire est renseigné ;
 * - le modèle est celui du type de la ressource ;
 * - un état clos ne change plus, ses photos non plus, sauf la validation du
 *   client, une fois (`CA010`) ;
 * - sous portée client : seuls les états clos de l'entreprise sont visibles,
 *   et seule la validation passe.
 */
export const inspections = mysqlTable(
  'inspections',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    kind: inspectionKindEnum('kind').notNull(),
    status: inspectionStatusEnum('status').notNull().default('draft'),
    resourceId: char('resource_id', { length: 36 }).notNull(),
    clientId: char('client_id', { length: 36 }).notNull(),
    bookingId: char('booking_id', { length: 36 }),
    contractId: char('contract_id', { length: 36 }),
    /** Pour une sortie : l'entrée correspondante, close. */
    entryInspectionId: char('entry_inspection_id', { length: 36 }),
    /** Version du modèle avec laquelle il est saisi. Ne change jamais. */
    templateVersionId: char('template_version_id', { length: 36 }).notNull(),
    /** Date de l'état des lieux, sur place. */
    performedAt: instant('performed_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
    values: json('values')
      .$type<InspectionValues>()
      .notNull()
      .default(sql`(JSON_OBJECT())`),
    /** Observations générales de l'équipe. */
    observations: text('observations'),
    createdBy: char('created_by', { length: 36 })
      .notNull()
      .references(() => staffMembers.id, { onDelete: 'restrict' }),
    /** Clôture : date posée par la base, auteur par le code. */
    closedAt: instant('closed_at'),
    closedBy: char('closed_by', { length: 36 }).references(() => staffMembers.id, { onDelete: 'restrict' }),
    /** Validation par le client depuis son espace : date posée par la base. */
    signedAt: instant('signed_at'),
    signedByMemberId: char('signed_by_member_id', { length: 36 }),
    /** Réserves du client, saisies à la validation. */
    clientRemarks: text('client_remarks'),
    ...timestamps(),
    /** Brouillon retiré (saisi par erreur). Un état clos ne se retire pas. */
    deletedAt: deletedAt(),
    exitLive: tinyint('exit_live').generatedAlwaysAs(
      sql`if(entry_inspection_id is not null and deleted_at is null, 1, null)`,
      { mode: 'virtual' },
    ),
  },
  (table) => [
    unique('inspections_tenant_id_id_key').on(table.tenantId, table.id),
    // Cible du lien d'une sortie vers son entrée : même client, même ressource.
    unique('inspections_tenant_id_client_resource_key').on(
      table.tenantId,
      table.id,
      table.clientId,
      table.resourceId,
    ),
    foreignKey({
      name: 'inspections_resource_fk',
      columns: [table.tenantId, table.resourceId],
      foreignColumns: [resources.tenantId, resources.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'inspections_client_fk',
      columns: [table.tenantId, table.clientId],
      foreignColumns: [clients.tenantId, clients.id],
    }).onDelete('restrict'),
    // La réservation et le contrat sont ceux du client.
    foreignKey({
      name: 'inspections_booking_fk',
      columns: [table.tenantId, table.bookingId, table.clientId],
      foreignColumns: [bookings.tenantId, bookings.id, bookings.clientId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'inspections_contract_fk',
      columns: [table.tenantId, table.contractId, table.clientId],
      foreignColumns: [contracts.tenantId, contracts.id, contracts.clientId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'inspections_entry_fk',
      columns: [table.tenantId, table.entryInspectionId, table.clientId, table.resourceId],
      foreignColumns: [table.tenantId, table.id, table.clientId, table.resourceId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'inspections_template_version_fk',
      columns: [table.tenantId, table.templateVersionId],
      foreignColumns: [inspectionTemplateVersions.tenantId, inspectionTemplateVersions.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'inspections_signed_by_member_fk',
      columns: [table.tenantId, table.clientId, table.signedByMemberId],
      foreignColumns: [clientMembers.tenantId, clientMembers.clientId, clientMembers.id],
    }).onDelete('restrict'),
    // Une sortie par entrée.
    // `exit_live` : 1 pour une sortie vivante liée à une entrée, NULL sinon.
    uniqueIndex('inspections_exit_per_entry_key').on(
      table.tenantId,
      table.entryInspectionId,
      table.exitLive,
    ),
    check(
      'inspections_occupation_given',
      sql`${table.bookingId} is not null or ${table.contractId} is not null`,
    ),
    check(
      'inspections_entry_for_exit',
      sql`${table.entryInspectionId} is null or ${table.kind} = 'exit'`,
    ),
    check('inspections_values_object', sql`json_type(${table.values}) = 'OBJECT'`),
    // Même borne que la saisie (`MAX_REMARKS`, compte-actions.ts), tenue par la base (ADR 041).
    check(
      'inspections_client_remarks_length',
      sql`${table.clientRemarks} is null or char_length(${table.clientRemarks}) <= 2000`,
    ),
    check(
      'inspections_status_consistent',
      sql`(${table.status} = 'closed') = (${table.closedAt} is not null)
        and (${table.closedAt} is null) = (${table.closedBy} is null)
        and (${table.signedAt} is null) = (${table.signedByMemberId} is null)
        and (${table.signedAt} is null or ${table.status} = 'closed')
        and (${table.clientRemarks} is null or ${table.signedAt} is not null)
        and (${table.deletedAt} is null or ${table.status} = 'draft')`,
    ),
    index('inspections_client_idx').on(table.tenantId, table.clientId, table.performedAt),
    index('inspections_resource_idx').on(table.tenantId, table.resourceId, table.performedAt),
    index('inspections_booking_idx').on(table.tenantId, table.bookingId),
    index('inspections_contract_idx').on(table.tenantId, table.contractId),
  ],
)

export type Inspection = typeof inspections.$inferSelect
export type NewInspection = typeof inspections.$inferInsert

/**
 * Types acceptés : les photos, telles que la compression du navigateur les
 * produit (canvas), et les documents PDF joints tels quels (ADR 056).
 */
export const inspectionPhotoContentTypes = ['image/jpeg', 'image/webp', 'image/png', 'application/pdf'] as const
export type InspectionPhotoContentType = (typeof inspectionPhotoContentTypes)[number]

/** Taille maximale d'une photo après compression, ou d'un PDF, en octets : la base la refuse au-delà. */
export const INSPECTION_PHOTO_MAX_BYTES = 10 * 1024 * 1024

/**
 * Photos et documents PDF d'un état des lieux (ADR 039, ADR 056 pour les
 * PDF) : un PDF est une pièce jointe comme une autre, sans dimensions.
 * Comme les numérisations (ADR 015, 020) : le
 * fichier vit dans le stockage objet, chiffré — ici toujours, la version de
 * clé est obligatoire, il n'y a pas d'objet hérité en clair —, la base n'en
 * garde que la clé ; chaque lecture passe par l'application et s'inscrit au
 * journal `inspection_photo_views`.
 *
 * Ajoutée, légendée ou retirée tant que l'état des lieux est un brouillon ;
 * figée ensuite. Au terme de `tenants.inspection_photo_retention_months`, le
 * fichier est effacé et la ligne marquée `deleted_at`
 * (`expired_inspection_photos()`, puis `mark_inspection_photo_purged()`).
 */
export const inspectionPhotos = mysqlTable(
  'inspection_photos',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    inspectionId: char('inspection_id', { length: 36 }).notNull(),
    storageKey: varchar('storage_key', { length: 255 }).notNull(),
    /** Version de la clé de chiffrement des documents (ADR 020). */
    encryptionKeyVersion: smallint('encryption_key_version').notNull(),
    /** Déterminé par le contenu du fichier, pas par ce que le navigateur déclare. */
    contentType: varchar('content_type', { length: 100 }).notNull(),
    /** Taille du document en clair. */
    byteSize: int('byte_size').notNull(),
    /** Dimensions d'une photo, pour réserver la place à l'affichage ; nulles pour un PDF. */
    width: int('width'),
    height: int('height'),
    caption: text('caption'),
    /** Champ du modèle illustré ; nul pour une photo d'ensemble. */
    fieldId: varchar('field_id', { length: 64 }),
    position: smallint('position').notNull().default(0),
    uploadedBy: char('uploaded_by', { length: 36 })
      .notNull()
      .references(() => staffMembers.id, { onDelete: 'restrict' }),
    ...timestamps(),
    /** Retirée d'un brouillon, ou fichier purgé au terme de sa conservation. */
    deletedAt: deletedAt(),
  },
  (table) => [
    unique('inspection_photos_tenant_id_id_key').on(table.tenantId, table.id),
    unique('inspection_photos_storage_key_key').on(table.storageKey),
    foreignKey({
      name: 'inspection_photos_inspection_fk',
      columns: [table.tenantId, table.inspectionId],
      foreignColumns: [inspections.tenantId, inspections.id],
    }).onDelete('restrict'),
    check(
      'inspection_photos_content_type_allowed',
      sql`${table.contentType} in ('image/jpeg', 'image/webp', 'image/png', 'application/pdf')`,
    ),
    // 10 Mio : `INSPECTION_PHOTO_MAX_BYTES`.
    check('inspection_photos_byte_size_valid', sql`${table.byteSize} between 1 and 10485760`),
    // Une photo a ses dimensions, un PDF n'en a pas. Une expression booléenne :
    // MySQL refuse un `case` dans un CHECK. Les `is not null` sont explicites :
    // un CHECK qui vaut NULL passe, et `null between 1 and 10000` vaut NULL.
    check(
      'inspection_photos_dimensions_valid',
      sql`(${table.contentType} = 'application/pdf' and ${table.width} is null and ${table.height} is null)
        or (${table.contentType} <> 'application/pdf' and ${table.width} is not null and ${table.height} is not null
            and ${table.width} between 1 and 10000 and ${table.height} between 1 and 10000)`,
    ),
    check(
      'inspection_photos_encryption_key_version_positive',
      sql`${table.encryptionKeyVersion} > 0`,
    ),
    index('inspection_photos_inspection_idx').on(table.tenantId, table.inspectionId, table.position),
  ],
)

export type InspectionPhoto = typeof inspectionPhotos.$inferSelect
export type NewInspectionPhoto = typeof inspectionPhotos.$inferInsert

export const inspectionPhotoViewers = ['staff', 'client'] as const
export type InspectionPhotoViewer = (typeof inspectionPhotoViewers)[number]

/**
 * Journal des consultations des photos, sur le modèle de `mail_scan_views` :
 * ajout seul (triggers `inspection_photo_views_before_update` / `_delete`), purge par
 * `purge_expired_inspection_photo_views()` au terme de
 * `tenants.inspection_access_log_retention_months`.
 */
export const inspectionPhotoViews = mysqlTable(
  'inspection_photo_views',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    photoId: char('photo_id', { length: 36 }).notNull(),
    viewedAt: instant('viewed_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
    viewer: varchar('viewer', { length: 16 }).$type<InspectionPhotoViewer>().notNull(),
    staffMemberId: char('staff_member_id', { length: 36 }).references(() => staffMembers.id, {
      onDelete: 'restrict',
    }),
    clientMemberId: char('client_member_id', { length: 36 }),
    /** Le compte lui-même : il survit au retrait de la personne. */
    authUserId: varchar('auth_user_id', { length: 255 }).notNull(),
  },
  (table) => [
    foreignKey({
      name: 'inspection_photo_views_photo_fk',
      columns: [table.tenantId, table.photoId],
      foreignColumns: [inspectionPhotos.tenantId, inspectionPhotos.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'inspection_photo_views_client_member_fk',
      columns: [table.tenantId, table.clientMemberId],
      foreignColumns: [clientMembers.tenantId, clientMembers.id],
    }).onDelete('restrict'),
    check(
      'inspection_photo_views_viewer_consistent',
      // Écrit en OU de cas : MySQL refuse un `CASE` nu comme expression de check.
      sql`(${table.viewer} = 'staff' and ${table.staffMemberId} is not null and ${table.clientMemberId} is null)
        or (${table.viewer} = 'client' and ${table.clientMemberId} is not null and ${table.staffMemberId} is null)`,
    ),
    index('inspection_photo_views_photo_idx').on(table.tenantId, table.photoId, table.viewedAt),
  ],
)

export type InspectionPhotoView = typeof inspectionPhotoViews.$inferSelect
