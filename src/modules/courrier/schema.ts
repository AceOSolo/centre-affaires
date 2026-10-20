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
import { mailCategories, type MailCategory } from './categories.ts'

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
export const mailKindEnum = (name: string) => mysqlEnum(name, mailKinds)

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
export const mailStatusEnum = (name: string) => mysqlEnum(name, mailStatuses)

/**
 * Tournées du courrier (ADR 044). L'accueil enregistre le courrier du jour
 * pli par pli dans la tournée ouverte ; rien ne part vers les domiciliés tant
 * qu'elle n'est pas terminée. À la fin, un seul message par entreprise :
 * « N courriers reçus », ou « pas de courrier aujourd'hui » pour les
 * domiciliés sans pli.
 *
 * Au plus une tournée ouverte par centre (`mail_batches_open_key`). Une
 * tournée terminée ne se rouvre pas, ne se supprime pas, et ne reçoit plus de
 * pli (`60-courrier.sql`, `CA017`). Elle peut être terminée vide : c'est
 * ainsi que l'accueil signale qu'aucun courrier n'est arrivé.
 */
export const mailBatches = mysqlTable(
  'mail_batches',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    openedAt: instant('opened_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
    openedBy: char('opened_by', { length: 36 })
      .notNull()
      .references(() => staffMembers.id, { onDelete: 'restrict' }),
    closedAt: instant('closed_at'),
    closedBy: char('closed_by', { length: 36 }).references(() => staffMembers.id, { onDelete: 'restrict' }),
    /**
     * Colonne générée : 1 tant que la tournée est ouverte, NULL ensuite. Porte
     * l'unicité « une tournée ouverte par centre ». Jamais écrite.
     */
    openLive: tinyint('open_live').generatedAlwaysAs(sql`if(closed_at is null, 1, null)`, {
      mode: 'virtual',
    }),
    ...timestamps(),
  },
  (table) => [
    unique('mail_batches_tenant_id_id_key').on(table.tenantId, table.id),
    uniqueIndex('mail_batches_open_key').on(table.tenantId, table.openLive),
    check('mail_batches_closing_complete', sql`(${table.closedAt} is null) = (${table.closedBy} is null)`),
    check('mail_batches_closed_after_opened', sql`${table.closedAt} is null or ${table.closedAt} >= ${table.openedAt}`),
    // Tournées terminées d'une journée : la première prévient les domiciliés sans courrier.
    index('mail_batches_closed_idx').on(table.tenantId, table.closedAt),
  ],
)

export type MailBatch = typeof mailBatches.$inferSelect

export const mailItems = mysqlTable(
  'mail_items',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    clientId: char('client_id', { length: 36 }).notNull(),
    /**
     * Tournée où le pli a été enregistré (ADR 044). Nulle pour les plis
     * enregistrés avant les tournées, prévenus un par un à leur arrivée.
     * Posée à l'insertion, dans une tournée ouverte, et jamais changée.
     */
    batchId: char('batch_id', { length: 36 }),
    kind: mailKindEnum('kind').notNull().default('lettre'),
    /** Expéditeur lu sur l'enveloppe. Nul quand il n'y figure pas. */
    sender: text('sender'),
    receivedAt: instant('received_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
    /** Précision du centre, visible du client : « avis de passage, à retirer avant le 12 ». */
    note: text('note'),
    status: mailStatusEnum('status').notNull().default('received'),
    registeredBy: char('registered_by', { length: 36 }).references(() => staffMembers.id, {
      onDelete: 'restrict',
    }),

    /**
     * Demande d'ouverture déposée depuis l'espace client. Nulle quand le centre
     * ouvre de lui-même : l'origine de l'ouverture se lit ici, et le relevé de
     * facturation la montre.
     */
    openingRequestedAt: instant('opening_requested_at'),
    openingRequestedBy: char('opening_requested_by', { length: 36 }),

    /** Ouverture et numérisation du contenu : la prestation facturée. */
    openedAt: instant('opened_at'),
    openedBy: char('opened_by', { length: 36 }).references(() => staffMembers.id, { onDelete: 'restrict' }),

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
    senderAnonymizedAt: instant('sender_anonymized_at'),
  },
  (table) => [
    foreignKey({
      name: 'mail_items_client_fk',
      columns: [table.tenantId, table.clientId],
      foreignColumns: [clients.tenantId, clients.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'mail_items_batch_fk',
      columns: [table.tenantId, table.batchId],
      foreignColumns: [mailBatches.tenantId, mailBatches.id],
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
      // Écrit en OU de cas : MySQL refuse un `CASE` nu comme expression de check.
      sql`(${table.status} = 'received' and ${table.openingRequestedAt} is null and ${table.openedAt} is null)
        or (${table.status} = 'opening_requested' and ${table.openingRequestedAt} is not null and ${table.openedAt} is null)
        or (${table.status} = 'opened' and ${table.openedAt} is not null)`,
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
    // File des ouvertures à faire. MySQL n'a pas d'index partiel : le statut
    // précède la date pour que la file se lise sans balayer le reste.
    index('mail_items_requested_idx').on(table.tenantId, table.status, table.openingRequestedAt),
    // Relevé mensuel des ouvertures (les plis fermés ont `opened_at` nul).
    index('mail_items_opened_idx').on(table.tenantId, table.openedAt),
    // Plis d'une tournée, par entreprise : le message de fin de tournée.
    index('mail_items_batch_idx').on(table.tenantId, table.batchId, table.clientId),
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
export const mailRequestKindEnum = (name: string) => mysqlEnum(name, mailRequestKinds)

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
export const mailRequestStatusEnum = (name: string) => mysqlEnum(name, mailRequestStatuses)

/**
 * Un pli reçoit plusieurs demandes dans le temps : ouverture, puis
 * numérisation de pages oubliées, puis réexpédition. Au plus une demande en
 * cours par pli et par nature (`mail_requests_pending_key`).
 *
 * Garanties tenues par la base (`src/db/regles/60-courrier.sql`, ADR 037) :
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
export const mailRequests = mysqlTable(
  'mail_requests',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    mailItemId: char('mail_item_id', { length: 36 }).notNull(),
    /** Client du pli, recopié pour la portée client ; la clé étrangère le tient égal. */
    clientId: char('client_id', { length: 36 }).notNull(),
    kind: mailRequestKindEnum('kind').notNull(),
    status: mailRequestStatusEnum('status').notNull().default('requested'),

    /**
     * Colonne générée : 1 tant que la demande est en cours (`requested`,
     * `in_progress`), NULL ensuite. Porte l'unicité « une demande en cours par
     * pli et par nature » (MySQL n'a pas d'index partiel). Jamais écrite.
     */
    pendingLive: tinyint('pending_live').generatedAlwaysAs(
      sql`if(status in ('requested', 'in_progress'), 1, null)`,
      { mode: 'virtual' },
    ),
    /** Posée par la base à l'insertion. */
    requestedAt: instant('requested_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
    /** Exactement un auteur : une personne de l'entreprise, ou l'accueil (consigne par téléphone). */
    requestedByMemberId: char('requested_by_member_id', { length: 36 }),
    requestedByStaffId: char('requested_by_staff_id', { length: 36 }).references(() => staffMembers.id, {
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
    postageCents: int('postage_cents'),
    postageCurrency: char('postage_currency', { length: 3 }),

    /* Transitions : date posée par la base, auteur posé par le code. */
    startedAt: instant('started_at'),
    startedByStaffId: char('started_by_staff_id', { length: 36 }).references(() => staffMembers.id, {
      onDelete: 'restrict',
    }),
    completedAt: instant('completed_at'),
    completedByStaffId: char('completed_by_staff_id', { length: 36 }).references(() => staffMembers.id, {
      onDelete: 'restrict',
    }),
    refusedAt: instant('refused_at'),
    /** Nul : refus posé par la base (pli retiré). */
    refusedByStaffId: char('refused_by_staff_id', { length: 36 }).references(() => staffMembers.id, {
      onDelete: 'restrict',
    }),
    /** Motif, montré au client. */
    refusalReason: text('refusal_reason'),
    cancelledAt: instant('cancelled_at'),
    cancelledByMemberId: char('cancelled_by_member_id', { length: 36 }),
    cancelledByStaffId: char('cancelled_by_staff_id', { length: 36 }).references(() => staffMembers.id, {
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
    // collègues, une seule demande. `pending_live` vaut 1 tant que la demande
    // est en cours, NULL ensuite : l'index unique ignore les NULL.
    uniqueIndex('mail_requests_pending_key').on(
      table.tenantId,
      table.mailItemId,
      table.kind,
      table.pendingLive,
    ),
    check(
      'mail_requests_one_author',
      sql`(${table.requestedByMemberId} is not null) + (${table.requestedByStaffId} is not null) = 1`,
    ),
    check(
      'mail_requests_opening_by_client',
      sql`${table.kind} <> 'open_and_scan' or ${table.requestedByMemberId} is not null`,
    ),
    check(
      'mail_requests_forward_address',
      sql`(${table.kind} = 'forward'
        and ${table.forwardRecipient} is not null and ${table.forwardAddressLine1} is not null
             and ${table.forwardPostalCode} is not null and ${table.forwardCity} is not null
             and ${table.forwardCountry} is not null
             and trim(${table.forwardRecipient}) <> '' and trim(${table.forwardAddressLine1}) <> ''
             and trim(${table.forwardPostalCode}) <> '' and trim(${table.forwardCity}) <> '')
        or (${table.kind} <> 'forward'
             and ${table.forwardRecipient} is null and ${table.forwardAddressLine1} is null
             and ${table.forwardAddressLine2} is null and ${table.forwardPostalCode} is null
             and ${table.forwardCity} is null and ${table.forwardCountry} is null
             and ${table.forwardTrackingNumber} is null)`,
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
        and (${table.refusalReason} is null or trim(${table.refusalReason}) <> '')
        and (${table.refusedByStaffId} is null or ${table.refusedAt} is not null)
        and (${table.status} = 'cancelled') = (${table.cancelledAt} is not null)
        and (case when ${table.cancelledAt} is null
              then ${table.cancelledByMemberId} is null and ${table.cancelledByStaffId} is null
              else (${table.cancelledByMemberId} is not null) + (${table.cancelledByStaffId} is not null) = 1 end)
        and (${table.status} <> 'requested' or ${table.startedAt} is null)
        and (${table.status} <> 'in_progress' or ${table.startedAt} is not null)
        and (${table.status} <> 'cancelled' or ${table.startedAt} is null)`,
    ),
    // Historique d'un pli, et d'un client dans son espace.
    index('mail_requests_item_idx').on(table.tenantId, table.mailItemId, table.requestedAt),
    index('mail_requests_client_idx').on(table.tenantId, table.clientId, table.requestedAt),
    // File de l'accueil : les demandes à traiter, dans l'ordre d'arrivée.
    index('mail_requests_queue_idx').on(table.tenantId, table.status, table.requestedAt),
    // Lot de facturation : les demandes faites d'une période.
    index('mail_requests_done_idx').on(table.tenantId, table.status, table.completedAt),
  ],
)

export type MailRequest = typeof mailRequests.$inferSelect
export type NewMailRequest = typeof mailRequests.$inferInsert

/** Recto de l'enveloppe, ou contenu du pli une fois ouvert. */
export const mailScanSides = ['envelope', 'content'] as const
export type MailScanSide = (typeof mailScanSides)[number]
export const mailScanSideEnum = (name: string) => mysqlEnum(name, mailScanSides)

/**
 * Numérisations. Le fichier vit dans le stockage objet, la base n'en garde que
 * la clé : jamais d'URL publique, chaque lecture passe par l'application et
 * laisse une trace dans `mail_scan_views`.
 */
export const mailScans = mysqlTable(
  'mail_scans',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    mailItemId: char('mail_item_id', { length: 36 }).notNull(),
    side: mailScanSideEnum('side').notNull(),
    storageKey: varchar('storage_key', { length: 255 }).notNull(),
    /** Déterminé par le contenu du fichier, pas par ce que le navigateur déclare. */
    contentType: varchar('content_type', { length: 100 }).notNull(),
    byteSize: int('byte_size').notNull(),
    uploadedBy: char('uploaded_by', { length: 36 }).references(() => staffMembers.id, { onDelete: 'restrict' }),
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
    mailRequestId: char('mail_request_id', { length: 36 }),
    /**
     * Pages du contenu numérisé (ADR 044), lues dans le PDF au dépôt ou
     * saisies par l'accueil ; une image compte pour une page. Donnée neutre :
     * le lot de facturation la lit pour les pages au-delà de celles comprises
     * dans l'ouverture, un export vers un autre outil peut la lire aussi.
     * Nulle pour l'enveloppe, et pour les contenus déposés avant le compteur.
     * Elle survit à la purge du fichier : la facture reste justifiée.
     */
    pageCount: smallint('page_count'),
    ...timestamps(),
    /** Purge au terme de la durée de conservation : le fichier part, la ligne reste. */
    deletedAt: deletedAt(),
    /**
     * Colonne générée portant l'unicité « un contenu par pli et par demande » :
     * l'identifiant de la demande (ou un UUID nul pour l'enveloppe et le contenu
     * d'office) tant que la ligne n'est pas purgée, NULL ensuite. Jamais écrite.
     */
    liveKey: char('live_key', { length: 36 }).generatedAlwaysAs(
      sql`if(deleted_at is null, coalesce(mail_request_id, '00000000-0000-0000-0000-000000000000'), null)`,
      { mode: 'virtual' },
    ),
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
    // `live_key` est NULL pour une ligne purgée : elle sort de l'unicité.
    uniqueIndex('mail_scans_item_side_key').on(table.mailItemId, table.side, table.liveKey),
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
      'mail_scans_page_count_valid',
      sql`${table.pageCount} is null or (${table.side} = 'content' and ${table.pageCount} between 1 and 1000)`,
    ),
    check(
      'mail_scans_encryption_key_version_positive',
      sql`${table.encryptionKeyVersion} is null or ${table.encryptionKeyVersion} > 0`,
    ),
    // File de la reprise : les objets encore en clair (version nulle), du plus
    // ancien au plus récent. Elle se vide à mesure qu'ils sont chiffrés.
    index('mail_scans_unencrypted_idx').on(table.tenantId, table.encryptionKeyVersion, table.createdAt),
  ],
)

export type MailScan = typeof mailScans.$inferSelect
export type NewMailScan = typeof mailScans.$inferInsert

/**
 * Journal d'accès aux numérisations, exigé par `CLAUDE.md` (RGPD).
 *
 * Une ligne par consultation, par le centre comme par le client. Le journal ne
 * se corrige pas : des triggers (`mail_scan_views_append_only_*`,
 * `src/db/regles/60-courrier.sql`) refusent tout `UPDATE` et tout `DELETE`, sauf
 * la purge échue `purge_expired_mail_scan_views()`. Un journal que
 * l'application peut réécrire ne prouve rien.
 */
export const mailScanViewers = ['staff', 'client'] as const
export type MailScanViewer = (typeof mailScanViewers)[number]

export const mailScanViews = mysqlTable(
  'mail_scan_views',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    mailScanId: char('mail_scan_id', { length: 36 }).notNull(),
    viewedAt: instant('viewed_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
    viewer: varchar('viewer', { length: 16 }).$type<MailScanViewer>().notNull(),
    staffMemberId: char('staff_member_id', { length: 36 }).references(() => staffMembers.id, {
      onDelete: 'restrict',
    }),
    clientMemberId: char('client_member_id', { length: 36 }),
    /** Le compte lui-même : il survit au retrait de la personne de la fiche. */
    authUserId: varchar('auth_user_id', { length: 255 }).notNull(),
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
      sql`(${table.viewer} = 'staff' and ${table.staffMemberId} is not null and ${table.clientMemberId} is null)
        or (${table.viewer} = 'client' and ${table.clientMemberId} is not null and ${table.staffMemberId} is null)`,
    ),
    index('mail_scan_views_scan_idx').on(table.tenantId, table.mailScanId, table.viewedAt),
  ],
)

export type MailScanView = typeof mailScanViews.$inferSelect

/**
 * Catégories du classement côté client (ADR 044) : liste fixe
 * (`categories.ts`), c'est le client qui range, le centre ne propose rien.
 * Nulle : non classé.
 */
export { mailCategories, type MailCategory }
export const mailCategoryEnum = (name: string) => mysqlEnum(name, mailCategories)

/**
 * Classement personnel d'un pli par une personne de l'espace client
 * (ADR 044) : lu ou non, traité ou non, catégorie, étiquettes. Propre à
 * chaque personne — deux associés rangent le même pli chacun à sa façon — et
 * jamais montré au centre.
 *
 * Sans ligne : non lu, non traité, non classé, sans étiquette. La ligne naît
 * à la première consultation (« lu ») ou au premier geste de classement.
 *
 * Écrite sous portée client : les triggers (`60-courrier.sql`) refusent une
 * entreprise hors de la portée. Les étiquettes sont du texte libre : elles
 * s'effacent avec la personne ou l'entreprise anonymisée (`90-rgpd.sql`).
 */
export const mailItemMemberStates = mysqlTable(
  'mail_item_member_states',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    /** Entreprise du pli, recopiée pour la portée client ; la clé étrangère la tient égale. */
    clientId: char('client_id', { length: 36 }).notNull(),
    mailItemId: char('mail_item_id', { length: 36 }).notNull(),
    clientMemberId: char('client_member_id', { length: 36 }).notNull(),
    /** Première consultation, ou marqué lu. Nulle : non lu. */
    readAt: instant('read_at'),
    /** Marqué traité. Nulle : à traiter. */
    handledAt: instant('handled_at'),
    category: mailCategoryEnum('category'),
    /** Étiquettes libres de la personne, sans doublon. Dix au plus, de 30 caractères. */
    tags: json('tags').$type<string[]>().notNull().default(sql`(JSON_ARRAY())`),
    ...timestamps(),
  },
  (table) => [
    unique('mail_item_member_states_tenant_id_id_key').on(table.tenantId, table.id),
    uniqueIndex('mail_item_member_states_member_key').on(
      table.tenantId,
      table.mailItemId,
      table.clientMemberId,
    ),
    // Le pli, et son entreprise.
    foreignKey({
      name: 'mail_item_member_states_mail_item_fk',
      columns: [table.tenantId, table.mailItemId, table.clientId],
      foreignColumns: [mailItems.tenantId, mailItems.id, mailItems.clientId],
    }).onDelete('restrict'),
    // La personne relève de l'entreprise du pli.
    foreignKey({
      name: 'mail_item_member_states_member_fk',
      columns: [table.tenantId, table.clientId, table.clientMemberId],
      foreignColumns: [clientMembers.tenantId, clientMembers.clientId, clientMembers.id],
    }).onDelete('restrict'),
    check(
      'mail_item_member_states_tags_valid',
      sql`json_type(${table.tags}) = 'ARRAY' and json_length(${table.tags}) <= 10`,
    ),
    // Rubriques et compteurs de la boîte d'une personne.
    index('mail_item_member_states_member_idx').on(
      table.tenantId,
      table.clientMemberId,
      table.category,
    ),
  ],
)

export type MailItemMemberState = typeof mailItemMemberStates.$inferSelect
