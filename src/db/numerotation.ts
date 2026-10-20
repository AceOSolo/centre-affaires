import { sql } from 'drizzle-orm'
import { char, check, int, mysqlEnum, mysqlTable, uniqueIndex } from 'drizzle-orm/mysql-core'

import { primaryKeyId, timestamps } from './columns.ts'
import { tenantContext } from './contexte.ts'
import { DEFAULT_TENANT_ID, tenants } from './tenants.ts'

/**
 * Numérotation des documents d'un centre : contrats, factures, avoirs (ADR 021).
 *
 * Posée dans `src/db/` et non dans un module : elle sert à plusieurs domaines
 * (contrats aujourd'hui, facturation en vague 2), au même titre que `tenants`.
 *
 * Le code ne lit ni n'écrit jamais ces compteurs lui-même. Il demande un numéro
 * à la fonction SQL `next_document_number(type)` (`src/db/regles/05-fondations.sql`),
 * seule à pouvoir les faire avancer : l'utilisateur applicatif n'a que la
 * lecture sur cette table (`infra/migrer.ts`) et la fonction s'exécute avec les
 * droits de son créateur (`SQL SECURITY DEFINER`). Un compteur que l'application peut remettre à zéro ne garantit plus
 * une numérotation sans trou ni doublon.
 */
export const documentTypes = ['contract', 'invoice', 'credit_note', 'proposal'] as const
export type DocumentType = (typeof documentTypes)[number]
export const documentTypeEnum = (name: string) => mysqlEnum(name, documentTypes)

/** Préfixe porté par chaque numéro, tel que l'écrit `next_document_number()`. */
export const documentPrefixes: Record<DocumentType, string> = {
  contract: 'CT',
  invoice: 'FA',
  credit_note: 'AV',
  /** Devis transmis à Dolibarr (ADR 043). */
  proposal: 'DV',
}

export const documentSequences = mysqlTable(
  'document_sequences',
  {
    id: primaryKeyId(),
    /**
     * Pas `tenantId()` : un compteur n'a aucune existence hors de son centre,
     * il part avec lui (`cascade`) au lieu d'en bloquer la suppression. Les
     * centres ne sont jamais supprimés physiquement en production (décision 6) ;
     * la cascade sert les bases de test, qui en créent et en effacent.
     */
    tenantId: char('tenant_id', { length: 36 })
      .notNull()
      .default(DEFAULT_TENANT_ID)
      .$defaultFn(() => tenantContext.getStore() ?? DEFAULT_TENANT_ID)
      .references(() => tenants.id, { onDelete: 'cascade' }),
    documentType: documentTypeEnum('document_type').notNull(),
    /**
     * Année civile du centre (dans son fuseau) à laquelle appartient la série :
     * une série par an, chacune continue, l'année figurant dans le numéro.
     */
    year: int('year').notNull(),
    /** Dernier numéro attribué dans la série. 0 : aucun encore. */
    lastValue: int('last_value').notNull().default(0),
    ...timestamps(),
  },
  (table) => [
    // Cible de l'`ON DUPLICATE KEY UPDATE` de `next_document_number()` : une ligne par série.
    uniqueIndex('document_sequences_series_key').on(
      table.tenantId,
      table.documentType,
      table.year,
    ),
    check('document_sequences_last_value_positive', sql`${table.lastValue} >= 0`),
    check('document_sequences_year_valid', sql`${table.year} between 2000 and 9999`),
  ],
)

export type DocumentSequence = typeof documentSequences.$inferSelect
