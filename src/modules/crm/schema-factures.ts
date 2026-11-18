import { sql } from 'drizzle-orm'
import {
  char,
  check,
  date,
  foreignKey,
  index,
  int,
  mysqlEnum,
  mysqlTable,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core'

import { instant, primaryKeyId, timestamps } from '../../db/columns.ts'
import { tenantId } from '../../db/tenants.ts'
import { clients } from '../clients/schema.ts'
import { crmConnectorIds } from './connecteurs.ts'

/**
 * Factures émises par le CRM, reçues pour l'espace client (ADR 081).
 *
 * **Le site ne facture rien** (`CLAUDE.md`, Facturation ; ADR 046) : Dolibarr
 * émet les factures et avoirs, en tient les règlements et les relances. Le
 * site en garde une **copie de lecture**, pour que chaque entreprise retrouve
 * dans son espace ses factures, leur montant, leur état (à payer, payée) et
 * le lien vers leur PDF. Rien ne s'y calcule, rien n'en part.
 *
 * - `external_id` : l'identifiant de la facture dans le CRM (le `rowid` de
 *   Dolibarr), unique par centre et par CRM : une facture du CRM n'est qu'une
 *   ligne ici, quel que soit le nombre d'envois ;
 * - `client_id` : l'entreprise, retrouvée par le tiers déjà reçu
 *   (`crm_links`, ADR 066) ;
 * - montants en centimes (décision 5), **positifs** même pour un avoir : le
 *   sens se lit dans `kind` ;
 * - `pdf_url` : l'adresse de téléchargement que le CRM donne (lien public de
 *   Dolibarr), en https. Le document reste chez lui : le site ne le stocke
 *   pas ;
 * - `removed_at` : supprimée dans le CRM, ou repassée en brouillon. La ligne
 *   reste (décision 6), l'espace client ne la montre plus.
 *
 * Les tables de facturation du site (`invoices`…, ADR 026) restent en
 * sommeil : rien ne s'y écrit ni ne s'y lit pour ces factures.
 */
export const crmInvoiceKinds = ['invoice', 'credit_note'] as const
export type CrmInvoiceKind = (typeof crmInvoiceKinds)[number]

/** `unpaid` : à payer (en tout ou en partie) ; `paid` : payée ; `cancelled` : abandonnée dans le CRM. */
export const crmInvoiceStatuses = ['unpaid', 'paid', 'cancelled'] as const
export type CrmInvoiceStatus = (typeof crmInvoiceStatuses)[number]

export const crmInvoices = mysqlTable(
  'crm_invoices',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    connector: mysqlEnum('connector', crmConnectorIds).notNull(),
    /** Identifiant de la facture dans le CRM. */
    externalId: varchar('external_id', { length: 64 }).notNull(),
    clientId: char('client_id', { length: 36 }).notNull(),
    /** Numéro de la facture (`FA2611-0042`), tel que le client le lit. */
    number: varchar('number', { length: 64 }).notNull(),
    kind: mysqlEnum('kind', crmInvoiceKinds).notNull().default('invoice'),
    status: mysqlEnum('status', crmInvoiceStatuses).notNull(),
    issuedOn: date('issued_on', { mode: 'string' }).notNull(),
    /** Échéance de règlement ; nulle : aucune donnée par le CRM. */
    dueOn: date('due_on', { mode: 'string' }),
    totalExclTaxCents: int('total_excl_tax_cents').notNull(),
    totalInclTaxCents: int('total_incl_tax_cents').notNull(),
    /** Reste à payer TTC, quand le CRM le donne (payée en partie) ; nul : non donné. */
    amountDueCents: int('amount_due_cents'),
    currency: char('currency', { length: 3 }).notNull().default('EUR'),
    /** Adresse de téléchargement du PDF chez le CRM, en https ; nulle : pas de lien. */
    pdfUrl: varchar('pdf_url', { length: 1000 }),
    /** Dernier envoi du CRM qui a changé la facture. */
    receivedAt: instant('received_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
    /** Supprimée dans le CRM ou repassée en brouillon : plus montrée au client. */
    removedAt: instant('removed_at'),
    ...timestamps(),
  },
  (table) => [
    foreignKey({
      name: 'crm_invoices_client_fk',
      columns: [table.tenantId, table.clientId],
      foreignColumns: [clients.tenantId, clients.id],
    }).onDelete('restrict'),
    uniqueIndex('crm_invoices_external_key').on(table.tenantId, table.connector, table.externalId),
    // Liste de l'espace client : par entreprise, de la plus récente à la plus ancienne.
    index('crm_invoices_client_idx').on(table.tenantId, table.clientId, table.issuedOn),
    check('crm_invoices_external_id_not_blank', sql`trim(${table.externalId}) <> ''`),
    check('crm_invoices_number_not_blank', sql`trim(${table.number}) <> ''`),
    check(
      'crm_invoices_amounts_valid',
      sql`${table.totalExclTaxCents} >= 0 and ${table.totalInclTaxCents} >= 0 and (${table.amountDueCents} is null or ${table.amountDueCents} between 0 and ${table.totalInclTaxCents})`,
    ),
    // Une facture payée ne laisse rien à payer.
    check(
      'crm_invoices_paid_nothing_due',
      sql`${table.status} <> 'paid' or ${table.amountDueCents} is null or ${table.amountDueCents} = 0`,
    ),
    check('crm_invoices_due_after_issue', sql`${table.dueOn} is null or ${table.dueOn} >= ${table.issuedOn}`),
    check('crm_invoices_currency_format', sql`REGEXP_LIKE(${table.currency}, '^[A-Z]{3}$', 'c')`),
    check('crm_invoices_pdf_url_https', sql`${table.pdfUrl} is null or ${table.pdfUrl} like 'https://%'`),
  ],
)

export type CrmInvoice = typeof crmInvoices.$inferSelect
export type NewCrmInvoice = typeof crmInvoices.$inferInsert
