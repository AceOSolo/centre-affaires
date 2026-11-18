import { sql } from 'drizzle-orm'
import { char, check, json, mysqlEnum, mysqlTable, uniqueIndex, varchar } from 'drizzle-orm/mysql-core'

import { primaryKeyId, timestamps } from '../../db/columns.ts'
import { staffMembers } from '../../db/staff.ts'
import { tenantId } from '../../db/tenants.ts'
import { formulaires, type Question } from './questionnaires.ts'

/**
 * Formulaires de demande réglés par le centre (ADR 074) : le nom et la phrase
 * du service tels que le visiteur les choisit, et les questions posées.
 *
 * Une ligne au plus par centre et par formulaire. Sans ligne, le formulaire
 * pose les questions par défaut du code (`defaultQuestionnaires`) : rien ne
 * change tant que le centre n'y touche pas.
 *
 * Un réglage, pas une entité métier : il se remplace sur place, comme la
 * connexion au CRM (ADR 065). Une question n'est jamais retirée, seulement
 * masquée ; ce qu'un demandeur a lu est figé sur son devis
 * (`proposals.described_answers`).
 */
export const requestForms = mysqlTable(
  'questionnaires',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    form: mysqlEnum('form', formulaires).notNull(),
    label: varchar('label', { length: 120 }).notNull(),
    description: varchar('description', { length: 300 }).notNull(),
    /** Les questions, dans l'ordre, validées par le code (`questionnaireProblem`). */
    questions: json('questions').$type<Question[]>().notNull(),
    /**
     * Domiciliation : codes des services du catalogue (reçus de Dolibarr,
     * ADR 049) que le formulaire propose en option, dans l'ordre.
     */
    serviceCodes: json('service_codes').$type<string[]>().notNull().default(sql`(json_array())`),
    updatedBy: char('updated_by', { length: 36 }).references(() => staffMembers.id, { onDelete: 'restrict' }),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('questionnaires_tenant_form_key').on(table.tenantId, table.form),
    check('questionnaires_label_not_blank', sql`trim(${table.label}) <> ''`),
    check('questionnaires_questions_array', sql`json_type(${table.questions}) = 'ARRAY'`),
    check('questionnaires_service_codes_array', sql`json_type(${table.serviceCodes}) = 'ARRAY'`),
  ],
)

export type RequestFormRow = typeof requestForms.$inferSelect
