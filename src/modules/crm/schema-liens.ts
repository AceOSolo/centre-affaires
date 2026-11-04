import { sql } from 'drizzle-orm'
import { char, check, index, mysqlEnum, mysqlTable, tinyint, uniqueIndex, varchar } from 'drizzle-orm/mysql-core'

import { instant, primaryKeyId, timestamps } from '../../db/columns.ts'
import { tenantId } from '../../db/tenants.ts'
import { crmConnectorIds } from './connecteurs.ts'

/**
 * Ce que le site a reçu du CRM, et sous quelle référence (ADR 066).
 *
 * Le CRM fait référence pour les tiers et les contrats (ADR 046) : chaque
 * fiche du site qu'il tient garde ici son identifiant chez lui. C'est la
 * « référence Dolibarr sur chaque fiche reçue » de l'ADR 046 § 5, tenue à
 * part pour rester la même quel que soit le CRM, et pour ne toucher ni la
 * table des clients ni celle des contrats.
 *
 * - `entity` : ce que la ligne relie — une entreprise (`clients`), un contact
 *   (`client_contacts`), un contrat (`contracts`) ;
 * - `external_id` : l'identifiant du CRM (le `rowid` de Dolibarr), unique par
 *   centre, CRM et nature : un tiers du CRM n'est qu'une fiche du site ;
 * - une fiche du site n'est reliée qu'à un objet vivant du CRM à la fois ;
 * - `removed_at` : l'objet a été supprimé dans le CRM. La fiche du site
 *   reste (décision 6), la ligne aussi : elle dit d'où venait la fiche.
 *
 * Pas de clé étrangère vers la fiche : la ligne vise trois tables. Les
 * lectures la joignent en filtrant le centre, comme partout.
 */
export const crmLinkEntities = ['client', 'contact', 'contract'] as const
export type CrmLinkEntity = (typeof crmLinkEntities)[number]

export const crmLinks = mysqlTable(
  'crm_links',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    connector: mysqlEnum('connector', crmConnectorIds).notNull(),
    entity: mysqlEnum('entity', crmLinkEntities).notNull(),
    /** La fiche du site : `clients.id`, `client_contacts.id` ou `contracts.id`. */
    localId: char('local_id', { length: 36 }).notNull(),
    /** Identifiant de l'objet dans le CRM. */
    externalId: varchar('external_id', { length: 64 }).notNull(),
    /** Référence lisible dans le CRM (`CU2611-0042`), si le CRM la donne. */
    externalRef: varchar('external_ref', { length: 64 }),
    /** Dernier envoi reçu du CRM pour cette fiche. */
    receivedAt: instant('received_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
    /** Supprimé dans le CRM : la fiche du site reste, elle n'est plus tenue par lui. */
    removedAt: instant('removed_at'),
    ...timestamps(),
    /** `1` tant que le lien vaut, `NULL` après une suppression dans le CRM (index partiel). */
    live: tinyint('live').generatedAlwaysAs(sql`if(removed_at is null, 1, null)`, { mode: 'virtual' }),
  },
  (table) => [
    uniqueIndex('crm_links_external_key').on(table.tenantId, table.connector, table.entity, table.externalId),
    uniqueIndex('crm_links_local_key').on(table.tenantId, table.connector, table.entity, table.localId, table.live),
    index('crm_links_local_idx').on(table.tenantId, table.entity, table.localId),
    check('crm_links_external_id_not_blank', sql`trim(${table.externalId}) <> ''`),
  ],
)

export type CrmLink = typeof crmLinks.$inferSelect
