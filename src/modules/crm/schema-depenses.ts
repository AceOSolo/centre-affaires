import { sql } from 'drizzle-orm'
import { boolean, char, check, mysqlTable, tinyint, uniqueIndex, varchar } from 'drizzle-orm/mysql-core'

import { primaryKeyId, timestamps } from '../../db/columns.ts'
import { staffMembers } from '../../db/staff.ts'
import { tenantId } from '../../db/tenants.ts'

/**
 * Ce que l'espace client montre des dépenses de chaque entreprise (ADR 081),
 * réglé par centre dans Réglages > « Dépenses dans l'espace client ».
 *
 * Une ligne au plus par centre. **Sans ligne, les valeurs par défaut**
 * (`depenses-reglages.ts`) : dépenses montrées, actes du courrier estimés,
 * douze mois passés, phrase par défaut sous le total. Un réglage, pas une
 * entité métier : il se remplace sur place, comme la connexion au CRM.
 */
export const clientExpenseSettings = mysqlTable(
  'client_expense_settings',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    /** Montrer « Mes dépenses » dans l'espace client. */
    showExpenses: boolean('show_expenses').notNull().default(true),
    /**
     * Estimer les actes du courrier (ouverture, numérisation, réexpédition,
     * pages en plus) au prix du forfait du client, sinon du catalogue reçu du
     * CRM — la règle déjà annoncée avant chaque demande. Faux : ils sont
     * comptés sans montant, « chiffrés sur la facture ».
     */
    estimateMailActs: boolean('estimate_mail_acts').notNull().default(true),
    /** Mois passés montrés, en plus du mois en cours. */
    historyMonths: tinyint('history_months').notNull().default(12),
    /** Phrase sous le total estimé ; nulle : la phrase par défaut. */
    note: varchar('note', { length: 300 }),
    updatedBy: char('updated_by', { length: 36 }).references(() => staffMembers.id, { onDelete: 'restrict' }),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('client_expense_settings_tenant_key').on(table.tenantId),
    check('client_expense_settings_history_months_valid', sql`${table.historyMonths} between 1 and 24`),
    check('client_expense_settings_note_not_blank', sql`${table.note} is null or trim(${table.note}) <> ''`),
  ],
)

export type ClientExpenseSettingsRow = typeof clientExpenseSettings.$inferSelect
