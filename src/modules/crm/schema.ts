import { sql } from 'drizzle-orm'
import {
  boolean,
  char,
  check,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  smallint,
  text,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core'

import { instant, primaryKeyId, timestamps } from '../../db/columns.ts'
import { staffMembers } from '../../db/staff.ts'
import { tenantId } from '../../db/tenants.ts'
import { crmConnectorIds } from './connecteurs.ts'
import { crmFlows, defaultEnabledFlows, type CrmFlowId } from './flux.ts'

/**
 * Connexion d'un centre à son CRM (ADR 065), réglée par la direction à
 * l'écran « Connexion au CRM ».
 *
 * Une ligne au plus par centre : un centre a un CRM. Sans ligne, le centre
 * garde ce qui tournait avant l'écran — Dolibarr, le jeton du serveur, les
 * devis et les produits ouverts.
 *
 * Aucun secret en clair :
 *
 * - le jeton que le CRM présente au site n'est gardé que par son empreinte
 *   (`jeton.ts`) : il est montré une fois, à sa génération ;
 * - la clé qui sert à appeler le CRM est chiffrée (`sealSecret`,
 *   `SECRETS_ENCRYPTION_KEY`, comme le jeton Google de l'ADR 014).
 *
 * Un réglage, pas une entité métier : il se remplace sur place, comme la
 * connexion Google (ADR 014). Ce qui s'est passé se lit dans `crm_exchanges`.
 */
export const crmConnections = mysqlTable(
  'crm_connections',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    connector: mysqlEnum('connector', crmConnectorIds).notNull().default('dolibarr'),
    /** Adresse du CRM, en https, sans barre finale. */
    baseUrl: varchar('base_url', { length: 500 }),
    /**
     * Empreinte SHA-256 (hexadécimal) du jeton réglé à l'écran. Unique sur
     * toute la base : c'est elle qui désigne le centre d'un appel.
     */
    inboundTokenHash: char('inbound_token_hash', { length: 64 }),
    inboundTokenSetAt: instant('inbound_token_set_at'),
    inboundTokenSetBy: char('inbound_token_set_by', { length: 36 }).references(() => staffMembers.id, {
      onDelete: 'restrict',
    }),
    /** Clé pour appeler le CRM, chiffrée. Jamais relue pour l'affichage. */
    outboundKeySealed: text('outbound_key_sealed'),
    outboundKeySetAt: instant('outbound_key_set_at'),
    /** Flux activés (`flux.ts`). Une valeur inconnue du code est ignorée à la lecture. */
    enabledFlows: json('enabled_flows')
      .$type<CrmFlowId[]>()
      .notNull()
      .default(sql.raw(`(JSON_ARRAY(${defaultEnabledFlows.map((flow) => `'${flow}'`).join(', ')}))`)),
    updatedBy: char('updated_by', { length: 36 }).references(() => staffMembers.id, { onDelete: 'restrict' }),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('crm_connections_tenant_key').on(table.tenantId),
    // Plusieurs `NULL` coexistent : les centres sans jeton d'écran.
    uniqueIndex('crm_connections_inbound_token_key').on(table.inboundTokenHash),
    check(
      'crm_connections_token_hash_format',
      sql`${table.inboundTokenHash} is null or REGEXP_LIKE(${table.inboundTokenHash}, '^[0-9a-f]{64}$', 'c')`,
    ),
    check(
      'crm_connections_token_traced',
      sql`(${table.inboundTokenHash} is null) = (${table.inboundTokenSetAt} is null)`,
    ),
    check(
      'crm_connections_key_traced',
      sql`(${table.outboundKeySealed} is null) = (${table.outboundKeySetAt} is null)`,
    ),
    check('crm_connections_base_url_https', sql`${table.baseUrl} is null or ${table.baseUrl} like 'https://%'`),
    check('crm_connections_enabled_flows_array', sql`JSON_TYPE(${table.enabledFlows}) = 'ARRAY'`),
  ],
)

export type CrmConnection = typeof crmConnections.$inferSelect

/** Sens d'un appel : le CRM appelle le site, ou le site appelle le CRM. */
export const crmExchangeDirections = ['inbound', 'outbound'] as const
export type CrmExchangeDirection = (typeof crmExchangeDirections)[number]

/** Jeton qui a ouvert un appel reçu (`acces.ts`). */
export const crmCredentials = ['screen', 'server'] as const

/**
 * Journal des échanges d'un centre avec son CRM (ADR 065) : chaque appel reçu
 * dont le jeton désigne le centre, chaque test de connexion. Un appel au jeton
 * inconnu n'a pas de centre : il ne laisse qu'une ligne au journal du serveur.
 *
 * Ni corps, ni jeton, ni adresse IP : l'opération, son code, une phrase
 * (« 3 devis », ou le message d'erreur rendu au CRM). Purgé au-delà de
 * `CRM_EXCHANGE_RETENTION_DAYS` à chaque écriture (`queries.ts`).
 */
export const crmExchanges = mysqlTable(
  'crm_exchanges',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    connector: mysqlEnum('connector', crmConnectorIds).notNull(),
    direction: mysqlEnum('direction', crmExchangeDirections).notNull(),
    /** Flux de l'échange ; nul pour un test de connexion. */
    flow: mysqlEnum('flow', crmFlows),
    /** « GET /api/dolibarr/devis », « Test de connexion ». */
    operation: varchar('operation', { length: 120 }).notNull(),
    /** Code HTTP rendu (appel reçu) ou reçu (appel sortant) ; nul si le CRM n'a pas répondu. */
    statusCode: smallint('status_code'),
    ok: boolean('ok').notNull(),
    message: varchar('message', { length: 500 }),
    credential: mysqlEnum('credential', crmCredentials),
    durationMs: int('duration_ms').notNull().default(0),
    createdAt: instant('created_at').notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    index('crm_exchanges_tenant_created_idx').on(table.tenantId, table.createdAt),
    check(
      'crm_exchanges_status_code_valid',
      sql`${table.statusCode} is null or ${table.statusCode} between 100 and 599`,
    ),
    check('crm_exchanges_duration_valid', sql`${table.durationMs} >= 0`),
    // Un appel reçu a toujours un jeton et un flux ; un appel sortant n'a pas de jeton.
    check(
      'crm_exchanges_inbound_complete',
      sql`(${table.direction} = 'inbound' and ${table.credential} is not null and ${table.flow} is not null and ${table.statusCode} is not null) or (${table.direction} = 'outbound' and ${table.credential} is null)`,
    ),
  ],
)

export type CrmExchange = typeof crmExchanges.$inferSelect
