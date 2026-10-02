import { sql } from 'drizzle-orm'
import {
  char,
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  smallint,
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
 *
 * Depuis la vague 3 (ADR 037), `opening_requested` et les colonnes
 * `opening_requested_*` sont le **résumé** de la demande d'ouverture en cours,
 * tenu par la base depuis `mail_requests` : le code ne les écrit plus
 * (SQLSTATE `CA008`). Une demande annulée remet le résumé à `received`, la
 * trace reste dans `mail_requests`.
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
    /**
     * Anonymisation de l'expéditeur et de la note (R29, ADR 040), avec la
     * fiche du client : le pli, ses dates et son ouverture restent au relevé.
     */
    senderAnonymizedAt: timestamp('sender_anonymized_at', { withTimezone: true }),
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
    // Cible des demandes (ADR 037) : une demande porte le client de son pli.
    unique('mail_items_tenant_id_client_key').on(table.tenantId, table.id, table.clientId),
    check(
      'mail_items_sender_anonymized',
      sql`${table.senderAnonymizedAt} is null or (${table.sender} is null and ${table.note} is null)`,
    ),

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

/**
 * Demandes du client sur un pli (R21, R24, ADR 037).
 *
 * - `open_and_scan` : ouvrir un pli fermé et en numériser le contenu. Seul un
 *   client la dépose (`requested_by_member_id`) : le centre qui ouvre de
 *   lui-même ouvre directement le pli (ADR 015). L'ouverture reste facturée
 *   **par le pli** (`invoice_lines.mail_item_id`, `courrier.ouverture`) :
 *   la demande n'en est que l'origine, jamais une seconde source ;
 * - `scan` : numériser un pli déjà ouvert (contenu non numérisé, numérisation
 *   purgée, pages supplémentaires). Source de facturation propre,
 *   `courrier.numerisation` ;
 * - `forward` : réexpédier le pli, à une adresse figée à la demande. Source de
 *   facturation propre, `courrier.reexpedition`, et des frais
 *   d'affranchissement relevés à l'envoi (ligne `other`).
 */
export const mailRequestKinds = ['open_and_scan', 'scan', 'forward'] as const
export type MailRequestKind = (typeof mailRequestKinds)[number]
export const mailRequestKindEnum = pgEnum('mail_request_kind', mailRequestKinds)

/**
 * `requested` → `in_progress` → `done` ; `requested` ou `in_progress` →
 * `refused` (par le centre, avec un motif) ; `requested` → `cancelled` (par
 * le client, ou par l'accueil à sa demande). `done`, `refused` et `cancelled`
 * sont définitifs. Chaque transition porte sa date, posée par la base, et son
 * auteur. Rien ne s'efface : l'annulation est un état, pas une suppression.
 */
export const mailRequestStatuses = [
  'requested',
  'in_progress',
  'done',
  'refused',
  'cancelled',
] as const
export type MailRequestStatus = (typeof mailRequestStatuses)[number]
export const mailRequestStatusEnum = pgEnum('mail_request_status', mailRequestStatuses)

/**
 * Un pli reçoit plusieurs demandes dans le temps : ouverture, puis
 * numérisation de pages oubliées, puis réexpédition. Au plus une demande en
 * cours par pli et par nature (`mail_requests_pending_key`).
 *
 * Garanties tenues par la base (migration 0041, ADR 037) :
 *
 * - transitions, dates et auteurs : trigger `mail_requests_guard` (`CA008`) ;
 *   sous portée client, seules la création et l'annulation par une personne
 *   de l'entreprise passent ;
 * - le résumé `mail_items.status` / `opening_requested_*` suit la demande
 *   d'ouverture en cours ; l'ouverture du pli clôt sa demande, son retrait
 *   refuse les demandes en cours ;
 * - une demande faite se facture au plus une fois par nature de ligne, hors
 *   avoir (`invoice_lines_mail_request_key`), et seulement faite (`CA003`) ;
 * - ni suppression ni réécriture de l'adresse figée.
 */
export const mailRequests = pgTable(
  'mail_requests',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    mailItemId: uuid('mail_item_id').notNull(),
    /** Client du pli, recopié pour la portée client ; la clé étrangère le tient égal. */
    clientId: uuid('client_id').notNull(),
    kind: mailRequestKindEnum('kind').notNull(),
    status: mailRequestStatusEnum('status').notNull().default('requested'),

    /** Posée par la base à l'insertion. */
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    /** Exactement un auteur : une personne de l'entreprise, ou l'accueil (consigne par téléphone). */
    requestedByMemberId: uuid('requested_by_member_id'),
    requestedByStaffId: uuid('requested_by_staff_id').references(() => staffMembers.id, {
      onDelete: 'restrict',
    }),
    /** Consigne du client : « numériser aussi les annexes ». Figée. */
    clientNote: text('client_note'),

    /* Réexpédition : adresse figée à la demande (une demande = un pli). */
    forwardRecipient: text('forward_recipient'),
    forwardAddressLine1: text('forward_address_line1'),
    forwardAddressLine2: text('forward_address_line2'),
    forwardPostalCode: text('forward_postal_code'),
    forwardCity: text('forward_city'),
    /** ISO 3166-1 alpha-2. */
    forwardCountry: char('forward_country', { length: 2 }),
    /** Numéro de suivi de l'envoi, relevé par l'accueil. */
    forwardTrackingNumber: text('forward_tracking_number'),
    /**
     * Frais d'affranchissement réels, en centimes, relevés à l'envoi
     * (décision 5). Refacturés tels quels par une ligne `other` de la facture,
     * à côté de l'acte `courrier.reexpedition`. Modifiables tant que la
     * demande n'est pas facturée.
     */
    postageCents: integer('postage_cents'),
    postageCurrency: char('postage_currency', { length: 3 }),

    /* Transitions : date posée par la base, auteur posé par le code. */
    startedAt: timestamp('started_at', { withTimezone: true }),
    startedByStaffId: uuid('started_by_staff_id').references(() => staffMembers.id, {
      onDelete: 'restrict',
    }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    completedByStaffId: uuid('completed_by_staff_id').references(() => staffMembers.id, {
      onDelete: 'restrict',
    }),
    refusedAt: timestamp('refused_at', { withTimezone: true }),
    /** Nul : refus posé par la base (pli retiré). */
    refusedByStaffId: uuid('refused_by_staff_id').references(() => staffMembers.id, {
      onDelete: 'restrict',
    }),
    /** Motif, montré au client. */
    refusalReason: text('refusal_reason'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelledByMemberId: uuid('cancelled_by_member_id'),
    cancelledByStaffId: uuid('cancelled_by_staff_id').references(() => staffMembers.id, {
      onDelete: 'restrict',
    }),
    ...timestamps(),
  },
  (table) => [
    unique('mail_requests_tenant_id_id_key').on(table.tenantId, table.id),
    // Cible des numérisations produites par une demande : même pli.
    unique('mail_requests_tenant_id_item_key').on(table.tenantId, table.id, table.mailItemId),
    // Le pli, et son client.
    foreignKey({
      name: 'mail_requests_mail_item_fk',
      columns: [table.tenantId, table.mailItemId, table.clientId],
      foreignColumns: [mailItems.tenantId, mailItems.id, mailItems.clientId],
    }).onDelete('restrict'),
    // Les personnes relèvent de l'entreprise destinataire du pli.
    foreignKey({
      name: 'mail_requests_requested_by_member_fk',
      columns: [table.tenantId, table.clientId, table.requestedByMemberId],
      foreignColumns: [clientMembers.tenantId, clientMembers.clientId, clientMembers.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'mail_requests_cancelled_by_member_fk',
      columns: [table.tenantId, table.clientId, table.cancelledByMemberId],
      foreignColumns: [clientMembers.tenantId, clientMembers.clientId, clientMembers.id],
    }).onDelete('restrict'),
    // Au plus une demande en cours par pli et par nature : deux clics, deux
    // collègues, une seule demande.
    uniqueIndex('mail_requests_pending_key')
      .on(table.tenantId, table.mailItemId, table.kind)
      .where(sql`status in ('requested', 'in_progress')`),
    check(
      'mail_requests_one_author',
      sql`num_nonnulls(${table.requestedByMemberId}, ${table.requestedByStaffId}) = 1`,
    ),
    check(
      'mail_requests_opening_by_client',
      sql`${table.kind} <> 'open_and_scan' or ${table.requestedByMemberId} is not null`,
    ),
    check(
      'mail_requests_forward_address',
      sql`case when ${table.kind} = 'forward'
        then num_nulls(${table.forwardRecipient}, ${table.forwardAddressLine1}, ${table.forwardPostalCode}, ${table.forwardCity}, ${table.forwardCountry}) = 0
             and btrim(${table.forwardRecipient}) <> '' and btrim(${table.forwardAddressLine1}) <> ''
             and btrim(${table.forwardPostalCode}) <> '' and btrim(${table.forwardCity}) <> ''
        else num_nonnulls(${table.forwardRecipient}, ${table.forwardAddressLine1}, ${table.forwardAddressLine2}, ${table.forwardPostalCode}, ${table.forwardCity}, ${table.forwardCountry}, ${table.forwardTrackingNumber}) = 0
      end`,
    ),
    check(
      'mail_requests_postage_valid',
      sql`(${table.postageCents} is null) = (${table.postageCurrency} is null) and (${table.postageCents} is null or (${table.kind} = 'forward' and ${table.status} = 'done' and ${table.postageCents} >= 0))`,
    ),
    check(
      'mail_requests_status_consistent',
      sql`(${table.startedAt} is null) = (${table.startedByStaffId} is null)
        and (${table.completedAt} is null) = (${table.completedByStaffId} is null)
        and (${table.status} = 'done') = (${table.completedAt} is not null)
        and (${table.status} = 'refused') = (${table.refusedAt} is not null)
        and (${table.refusedAt} is null) = (${table.refusalReason} is null)
        and (${table.refusalReason} is null or btrim(${table.refusalReason}) <> '')
        and (${table.refusedByStaffId} is null or ${table.refusedAt} is not null)
        and (${table.status} = 'cancelled') = (${table.cancelledAt} is not null)
        and (case when ${table.cancelledAt} is null
              then num_nonnulls(${table.cancelledByMemberId}, ${table.cancelledByStaffId}) = 0
              else num_nonnulls(${table.cancelledByMemberId}, ${table.cancelledByStaffId}) = 1 end)
        and (${table.status} <> 'requested' or ${table.startedAt} is null)
        and (${table.status} <> 'in_progress' or ${table.startedAt} is not null)
        and (${table.status} <> 'cancelled' or ${table.startedAt} is null)`,
    ),
    // Historique d'un pli, et d'un client dans son espace.
    index('mail_requests_item_idx').on(table.tenantId, table.mailItemId, table.requestedAt),
    index('mail_requests_client_idx').on(table.tenantId, table.clientId, table.requestedAt),
    // File de l'accueil : les demandes à traiter, dans l'ordre d'arrivée.
    index('mail_requests_queue_idx')
      .on(table.tenantId, table.requestedAt)
      .where(sql`status in ('requested', 'in_progress')`),
    // Lot de facturation : les demandes faites d'une période.
    index('mail_requests_done_idx')
      .on(table.tenantId, table.completedAt)
      .where(sql`status = 'done' and kind in ('scan', 'forward')`),
  ],
)

export type MailRequest = typeof mailRequests.$inferSelect
export type NewMailRequest = typeof mailRequests.$inferInsert

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
    /**
     * Chiffrement au repos de l'objet stocké (R22, ADR 020).
     *
     * Nul : objet déposé en clair, avant le chiffrement — il reste lisible tel
     * quel le temps de la reprise. Sinon, la version de la clé avec laquelle
     * l'objet a été chiffré : c'est elle qui choisit la clé au déchiffrement,
     * et qui permet de changer de clé sans rendre illisibles les anciens objets.
     *
     * `content_type` et `byte_size` décrivent toujours le document en clair,
     * celui que l'on rend à la lecture, pas le chiffré du stockage.
     */
    encryptionKeyVersion: smallint('encryption_key_version'),
    /**
     * Demande qui a produit ce contenu (ADR 037) : une ouverture demandée, ou
     * une numérisation seule d'un pli déjà ouvert. Nulle pour l'enveloppe, et
     * pour un contenu numérisé d'office par le centre.
     */
    mailRequestId: uuid('mail_request_id'),
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
    // La demande est une demande de ce pli.
    foreignKey({
      name: 'mail_scans_mail_request_fk',
      columns: [table.tenantId, table.mailRequestId, table.mailItemId],
      foreignColumns: [mailRequests.tenantId, mailRequests.id, mailRequests.mailItemId],
    }).onDelete('restrict'),
    unique('mail_scans_tenant_id_id_key').on(table.tenantId, table.id),
    unique('mail_scans_storage_key_key').on(table.storageKey),
    // Une enveloppe par pli ; un contenu par pli et par demande — celui de
    // l'ouverture, puis un par numérisation demandée ensuite (ADR 037).
    uniqueIndex('mail_scans_item_side_key')
      .on(
        table.mailItemId,
        table.side,
        sql`coalesce(mail_request_id, '00000000-0000-0000-0000-000000000000'::uuid)`,
      )
      .where(sql`deleted_at is null`),
    check(
      'mail_scans_request_content_only',
      sql`${table.mailRequestId} is null or ${table.side} = 'content'`,
    ),
    check(
      'mail_scans_content_type_allowed',
      sql`${table.contentType} in ('application/pdf', 'image/jpeg', 'image/png')`,
    ),
    check('mail_scans_byte_size_positive', sql`${table.byteSize} > 0`),
    check(
      'mail_scans_encryption_key_version_positive',
      sql`${table.encryptionKeyVersion} is null or ${table.encryptionKeyVersion} > 0`,
    ),
    // File de la reprise : les objets encore en clair, du plus ancien au plus
    // récent. Elle se vide à mesure qu'ils sont chiffrés.
    index('mail_scans_unencrypted_idx')
      .on(table.tenantId, table.createdAt)
      .where(sql`encryption_key_version is null and deleted_at is null`),
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
