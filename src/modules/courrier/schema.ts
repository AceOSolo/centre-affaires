import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

import { deletedAt, primaryKeyId, timestamps } from '../../db/columns.ts'
import { staffMembers } from '../../db/staff.ts'
import { tenantId } from '../../db/tenants.ts'
import { clientMembers, clients } from '../clients/schema.ts'

/**
 * Courrier reçu pour les entreprises domiciliées (ADR 015).
 *
 * Un pli arrive, le centre l'enregistre pour un client, éventuellement avec la
 * numérisation de l'enveloppe. Le client le voit dans sa boîte aux lettres et
 * peut en demander l'ouverture ; le centre l'ouvre et en numérise le contenu.
 * Chaque ouverture est une prestation facturable, relevée par client.
 */
export const mailKinds = ['lettre', 'recommande', 'colis', 'autre'] as const
export type MailKind = (typeof mailKinds)[number]
export const mailKindEnum = pgEnum('mail_kind', mailKinds)

/**
 * `received` : enregistré, fermé. Le client ne voit au mieux que l'enveloppe.
 * `opening_requested` : le client a demandé l'ouverture, le centre doit agir.
 * `opened` : ouvert et numérisé par le centre. C'est ce qui est facturé.
 */
export const mailStatuses = ['received', 'opening_requested', 'opened'] as const
export type MailStatus = (typeof mailStatuses)[number]
export const mailStatusEnum = pgEnum('mail_status', mailStatuses)

export const mailItems = pgTable(
  'mail_items',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    clientId: uuid('client_id').notNull(),
    kind: mailKindEnum('kind').notNull().default('lettre'),
    /** Expéditeur lu sur l'enveloppe. Nul quand il n'y figure pas. */
    sender: text('sender'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    /** Précision du centre, visible du client : « avis de passage, à retirer avant le 12 ». */
    note: text('note'),
    status: mailStatusEnum('status').notNull().default('received'),
    registeredBy: uuid('registered_by').references(() => staffMembers.id, {
      onDelete: 'restrict',
    }),

    /**
     * Demande d'ouverture déposée depuis l'espace client. Nulle quand le centre
     * ouvre de lui-même : l'origine de l'ouverture se lit ici, et le relevé de
     * facturation la montre.
     */
    openingRequestedAt: timestamp('opening_requested_at', { withTimezone: true }),
    openingRequestedBy: uuid('opening_requested_by'),

    /** Ouverture et numérisation du contenu : la prestation facturée. */
    openedAt: timestamp('opened_at', { withTimezone: true }),
    openedBy: uuid('opened_by').references(() => staffMembers.id, { onDelete: 'restrict' }),

    ...timestamps(),
    /**
     * Retrait : un courrier attribué au mauvais client doit disparaître de sa
     * boîte — et de sa facturation — sans effacer la trace de l'erreur.
     */
    deletedAt: deletedAt(),
  },
  (table) => [
    foreignKey({
      name: 'mail_items_client_fk',
      columns: [table.tenantId, table.clientId],
      foreignColumns: [clients.tenantId, clients.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'mail_items_requested_by_fk',
      columns: [table.tenantId, table.openingRequestedBy],
      foreignColumns: [clientMembers.tenantId, clientMembers.id],
    }).onDelete('restrict'),
    unique('mail_items_tenant_id_id_key').on(table.tenantId, table.id),

    // L'état et ses dates ne peuvent pas se contredire : c'est sur `opened_at`
    // que repose la facturation, un statut « ouvert » sans date échapperait au
    // relevé.
    check(
      'mail_items_status_consistent',
      sql`case ${table.status}
        when 'received' then ${table.openingRequestedAt} is null and ${table.openedAt} is null
        when 'opening_requested' then ${table.openingRequestedAt} is not null and ${table.openedAt} is null
        when 'opened' then ${table.openedAt} is not null
        else false
      end`,
    ),
    check(
      'mail_items_request_complete',
      sql`(${table.openingRequestedAt} is null) = (${table.openingRequestedBy} is null)`,
    ),
    check(
      'mail_items_opening_complete',
      sql`(${table.openedAt} is null) = (${table.openedBy} is null)`,
    ),

    index('mail_items_client_received_idx').on(table.tenantId, table.clientId, table.receivedAt),
    index('mail_items_tenant_received_idx').on(table.tenantId, table.receivedAt),
    // File des ouvertures à faire : peu de lignes parmi beaucoup.
    index('mail_items_requested_idx')
      .on(table.tenantId, table.openingRequestedAt)
      .where(sql`status = 'opening_requested' and deleted_at is null`),
    // Relevé mensuel des ouvertures.
    index('mail_items_opened_idx')
      .on(table.tenantId, table.openedAt)
      .where(sql`opened_at is not null`),
  ],
)

export type MailItem = typeof mailItems.$inferSelect
export type NewMailItem = typeof mailItems.$inferInsert

/** Recto de l'enveloppe, ou contenu du pli une fois ouvert. */
export const mailScanSides = ['envelope', 'content'] as const
export type MailScanSide = (typeof mailScanSides)[number]
export const mailScanSideEnum = pgEnum('mail_scan_side', mailScanSides)

/**
 * Numérisations. Le fichier vit dans le stockage objet, la base n'en garde que
 * la clé : jamais d'URL publique, chaque lecture passe par l'application et
 * laisse une trace dans `mail_scan_views`.
 */
export const mailScans = pgTable(
  'mail_scans',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    mailItemId: uuid('mail_item_id').notNull(),
    side: mailScanSideEnum('side').notNull(),
    storageKey: text('storage_key').notNull(),
    /** Déterminé par le contenu du fichier, pas par ce que le navigateur déclare. */
    contentType: text('content_type').notNull(),
    byteSize: integer('byte_size').notNull(),
    uploadedBy: uuid('uploaded_by').references(() => staffMembers.id, { onDelete: 'restrict' }),
    ...timestamps(),
    /** Purge au terme de la durée de conservation : le fichier part, la ligne reste. */
    deletedAt: deletedAt(),
  },
  (table) => [
    foreignKey({
      name: 'mail_scans_mail_item_fk',
      columns: [table.tenantId, table.mailItemId],
      foreignColumns: [mailItems.tenantId, mailItems.id],
    }).onDelete('restrict'),
    unique('mail_scans_tenant_id_id_key').on(table.tenantId, table.id),
    unique('mail_scans_storage_key_key').on(table.storageKey),
    // Une enveloppe et un contenu par pli.
    uniqueIndex('mail_scans_item_side_key')
      .on(table.mailItemId, table.side)
      .where(sql`deleted_at is null`),
    check(
      'mail_scans_content_type_allowed',
      sql`${table.contentType} in ('application/pdf', 'image/jpeg', 'image/png')`,
    ),
    check('mail_scans_byte_size_positive', sql`${table.byteSize} > 0`),
  ],
)

export type MailScan = typeof mailScans.$inferSelect
export type NewMailScan = typeof mailScans.$inferInsert

/**
 * Journal d'accès aux numérisations, exigé par `CLAUDE.md` (RGPD).
 *
 * Une ligne par consultation, par le centre comme par le client. Le journal ne
 * se corrige pas : le rôle applicatif n'a ni `UPDATE` ni `DELETE` sur cette
 * table (migration 0020). Un journal que l'application peut réécrire ne prouve
 * rien.
 */
export const mailScanViewers = ['staff', 'client'] as const
export type MailScanViewer = (typeof mailScanViewers)[number]

export const mailScanViews = pgTable(
  'mail_scan_views',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    mailScanId: uuid('mail_scan_id').notNull(),
    viewedAt: timestamp('viewed_at', { withTimezone: true }).notNull().defaultNow(),
    viewer: text('viewer').$type<MailScanViewer>().notNull(),
    staffMemberId: uuid('staff_member_id').references(() => staffMembers.id, {
      onDelete: 'restrict',
    }),
    clientMemberId: uuid('client_member_id'),
    /** Le compte lui-même : il survit au retrait de la personne de la fiche. */
    authUserId: text('auth_user_id').notNull(),
  },
  (table) => [
    foreignKey({
      name: 'mail_scan_views_scan_fk',
      columns: [table.tenantId, table.mailScanId],
      foreignColumns: [mailScans.tenantId, mailScans.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'mail_scan_views_client_member_fk',
      columns: [table.tenantId, table.clientMemberId],
      foreignColumns: [clientMembers.tenantId, clientMembers.id],
    }).onDelete('restrict'),
    check(
      'mail_scan_views_viewer_consistent',
      sql`case ${table.viewer}
        when 'staff' then ${table.staffMemberId} is not null and ${table.clientMemberId} is null
        when 'client' then ${table.clientMemberId} is not null and ${table.staffMemberId} is null
        else false
      end`,
    ),
    index('mail_scan_views_scan_idx').on(table.tenantId, table.mailScanId, table.viewedAt),
  ],
)

export type MailScanView = typeof mailScanViews.$inferSelect
