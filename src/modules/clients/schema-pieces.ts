import { sql } from 'drizzle-orm'
import {
  boolean,
  char,
  check,
  foreignKey,
  index,
  int,
  mysqlEnum,
  mysqlTable,
  smallint,
  unique,
  varchar,
} from 'drizzle-orm/mysql-core'

import { deletedAt, instant, primaryKeyId, timestamps } from '../../db/columns.ts'
import { staffMembers } from '../../db/staff.ts'
import { tenantId } from '../../db/tenants.ts'
import { clientMembers, clients } from './schema.ts'

/**
 * Pièces justificatives de la domiciliation (ADR 075) : la liste des pièces
 * demandées, réglée par centre, les pièces déposées par le client depuis son
 * espace, et le journal de leurs consultations.
 *
 * Règles de la base : `src/db/regles/34-pieces.sql` (code `CA021`).
 */

/**
 * Situation de la société à laquelle une pièce s'applique : toutes, en cours
 * de création, déjà immatriculée (question « Votre société » du formulaire de
 * domiciliation).
 */
export const clientDocumentSituations = ['all', 'creation', 'registered'] as const
export type ClientDocumentSituation = (typeof clientDocumentSituations)[number]

/**
 * Pièces demandées par le centre. Sans ligne pour un centre, la liste par
 * défaut du code s'applique (`pieces-regles.ts`) ; la première modification à
 * l'écran l'écrit en base, puis la change. Une pièce se retire de la liste
 * (`active` faux), elle ne se supprime pas : les pièces déposées gardent leur
 * libellé (`client_documents.kind_label`).
 */
export const clientDocumentKinds = mysqlTable(
  'client_document_kinds',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    /** Identifiant stable, repris par les pièces déposées : `piece-identite`, `kbis`. */
    code: varchar('code', { length: 40 }).notNull(),
    label: varchar('label', { length: 120 }).notNull(),
    /** Aide montrée au client : ce qui est accepté, l'ancienneté exigée. */
    help: varchar('help', { length: 300 }),
    appliesTo: mysqlEnum('applies_to', clientDocumentSituations).notNull().default('all'),
    position: smallint('position').notNull().default(0),
    active: boolean('active').notNull().default(true),
    updatedBy: char('updated_by', { length: 36 }).references(() => staffMembers.id, { onDelete: 'restrict' }),
    ...timestamps(),
  },
  (table) => [
    unique('client_document_kinds_tenant_id_id_key').on(table.tenantId, table.id),
    unique('client_document_kinds_code_key').on(table.tenantId, table.code),
    check('client_document_kinds_code_format', sql`REGEXP_LIKE(${table.code}, '^[a-z0-9-]{1,40}$', 'c')`),
    check('client_document_kinds_label_valid', sql`trim(${table.label}) <> ''`),
  ],
)

export type ClientDocumentKindRow = typeof clientDocumentKinds.$inferSelect

/**
 * État d'une pièce déposée : reçue (à vérifier par l'accueil), validée, ou
 * refusée avec un motif. Une pièce refusée reste ; le client en dépose une
 * autre. Une pièce validée peut encore être refusée (revue), jamais l'inverse.
 */
export const clientDocumentStatuses = ['received', 'accepted', 'refused'] as const
export type ClientDocumentStatus = (typeof clientDocumentStatuses)[number]

/** Types acceptés, lus dans les octets du fichier. */
export const clientDocumentContentTypes = ['application/pdf', 'image/jpeg', 'image/png'] as const
export type ClientDocumentContentType = (typeof clientDocumentContentTypes)[number]

/** 10 Mio : la base refuse au-delà. */
export const CLIENT_DOCUMENT_MAX_BYTES = 10 * 1024 * 1024

/**
 * Pièces déposées par le client. Comme les numérisations et les photos d'états
 * des lieux (ADR 020) : le fichier vit dans le stockage objet, toujours
 * chiffré, la base n'en garde que la clé ; chaque lecture passe par
 * l'application et s'inscrit au journal `client_document_views`.
 *
 * Au terme de sa conservation, le fichier est effacé et la ligne marquée
 * `deleted_at` (`mark_client_document_purged()`) : on sait encore qu'une pièce
 * a été déposée, et quand, sans la garder.
 */
export const clientDocuments = mysqlTable(
  'client_documents',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    clientId: char('client_id', { length: 36 }).notNull(),
    kindCode: varchar('kind_code', { length: 40 }).notNull(),
    /** Libellé de la pièce au dépôt : il reste lisible si la liste change. */
    kindLabel: varchar('kind_label', { length: 120 }).notNull(),
    storageKey: varchar('storage_key', { length: 255 }).notNull(),
    /** Version de la clé de chiffrement des documents (ADR 020). */
    encryptionKeyVersion: smallint('encryption_key_version').notNull(),
    /** Déterminé par le contenu du fichier, pas par ce que le navigateur déclare. */
    contentType: varchar('content_type', { length: 100 }).notNull(),
    /** Taille du document en clair. */
    byteSize: int('byte_size').notNull(),
    status: mysqlEnum('status', clientDocumentStatuses).notNull().default('received'),
    refusalReason: varchar('refusal_reason', { length: 500 }),
    /** La personne de l'espace client qui l'a déposée. */
    uploadedByMemberId: char('uploaded_by_member_id', { length: 36 }).notNull(),
    reviewedAt: instant('reviewed_at'),
    reviewedBy: char('reviewed_by', { length: 36 }).references(() => staffMembers.id, { onDelete: 'restrict' }),
    ...timestamps(),
    /** Fichier effacé au terme de sa conservation. */
    deletedAt: deletedAt(),
  },
  (table) => [
    unique('client_documents_tenant_id_id_key').on(table.tenantId, table.id),
    unique('client_documents_storage_key_key').on(table.storageKey),
    foreignKey({
      name: 'client_documents_client_fk',
      columns: [table.tenantId, table.clientId],
      foreignColumns: [clients.tenantId, clients.id],
    }).onDelete('restrict'),
    // La personne qui dépose relève de l'entreprise de la pièce.
    foreignKey({
      name: 'client_documents_uploaded_by_fk',
      columns: [table.tenantId, table.clientId, table.uploadedByMemberId],
      foreignColumns: [clientMembers.tenantId, clientMembers.clientId, clientMembers.id],
    }).onDelete('restrict'),
    check(
      'client_documents_content_type_allowed',
      sql`${table.contentType} in ('application/pdf', 'image/jpeg', 'image/png')`,
    ),
    check('client_documents_byte_size_valid', sql`${table.byteSize} between 1 and 10485760`),
    check('client_documents_encryption_key_version_positive', sql`${table.encryptionKeyVersion} > 0`),
    // Un refus a son motif, et seulement un refus. Écrit en OU de cas : pas de
    // `case` dans un CHECK MySQL, et un CHECK qui vaut NULL passe.
    check(
      'client_documents_refusal_reason',
      sql`(${table.status} = 'refused' and ${table.refusalReason} is not null and trim(${table.refusalReason}) <> '')
        or (${table.status} <> 'refused' and ${table.refusalReason} is null)`,
    ),
    // Une pièce vérifiée l'a été par quelqu'un, à une date ; une pièce reçue, pas encore.
    check(
      'client_documents_review_traced',
      sql`(${table.status} = 'received' and ${table.reviewedAt} is null and ${table.reviewedBy} is null)
        or (${table.status} <> 'received' and ${table.reviewedAt} is not null and ${table.reviewedBy} is not null)`,
    ),
    index('client_documents_client_idx').on(table.tenantId, table.clientId, table.kindCode, table.createdAt),
  ],
)

export type ClientDocument = typeof clientDocuments.$inferSelect
export type NewClientDocument = typeof clientDocuments.$inferInsert

export const clientDocumentViewers = ['staff', 'client'] as const
export type ClientDocumentViewer = (typeof clientDocumentViewers)[number]

/**
 * Journal des consultations des pièces, sur le modèle de `mail_scan_views` :
 * ajout seul, purge par `purge_expired_client_document_views()` au terme de
 * `tenants.client_document_access_log_retention_months`.
 */
export const clientDocumentViews = mysqlTable(
  'client_document_views',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    documentId: char('document_id', { length: 36 }).notNull(),
    viewedAt: instant('viewed_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
    viewer: varchar('viewer', { length: 16 }).$type<ClientDocumentViewer>().notNull(),
    staffMemberId: char('staff_member_id', { length: 36 }).references(() => staffMembers.id, {
      onDelete: 'restrict',
    }),
    clientMemberId: char('client_member_id', { length: 36 }),
    /** Le compte lui-même : il survit au retrait de la personne. */
    authUserId: varchar('auth_user_id', { length: 255 }).notNull(),
  },
  (table) => [
    foreignKey({
      name: 'client_document_views_document_fk',
      columns: [table.tenantId, table.documentId],
      foreignColumns: [clientDocuments.tenantId, clientDocuments.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'client_document_views_client_member_fk',
      columns: [table.tenantId, table.clientMemberId],
      foreignColumns: [clientMembers.tenantId, clientMembers.id],
    }).onDelete('restrict'),
    check(
      'client_document_views_viewer_consistent',
      sql`(${table.viewer} = 'staff' and ${table.staffMemberId} is not null and ${table.clientMemberId} is null)
        or (${table.viewer} = 'client' and ${table.clientMemberId} is not null and ${table.staffMemberId} is null)`,
    ),
    index('client_document_views_document_idx').on(table.tenantId, table.documentId, table.viewedAt),
  ],
)

export type ClientDocumentView = typeof clientDocumentViews.$inferSelect
