import { sql } from 'drizzle-orm'
import { char, check, index, mysqlTable, text, varchar } from 'drizzle-orm/mysql-core'

import { instant, primaryKeyId, timestamps } from '../../db/columns.ts'
import { staffMembers } from '../../db/staff.ts'
import { tenantId } from '../../db/tenants.ts'

/**
 * Bannissements de comptes du site, par centre (ADR 045).
 *
 * Le compte (`auth_users`) n'a pas de centre : en multi-centres, un même compte
 * pourra relever de plusieurs centres, et un centre ne doit pas en fermer
 * l'accès aux autres. Le bannissement est donc une ligne du centre, pas un
 * drapeau sur le compte.
 *
 * Une ligne par bannissement, jamais supprimée (décision 6) : la levée la
 * clôt (`lifted_at`), ce qui garde qui a banni, pourquoi et quand. Un
 * bannissement est en vigueur tant qu'il n'est pas levé et que son terme
 * (`banned_until`), s'il en a un, n'est pas passé.
 */
export const accountBans = mysqlTable(
  'account_bans',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    /**
     * Compte banni (`auth_users.id`). Pas de clé étrangère vers `auth_*`, pour
     * la même raison que `staff_members.auth_user_id` (ADR 008).
     */
    authUserId: varchar('auth_user_id', { length: 36 }).notNull(),
    /** Motif, lu par l'équipe seulement : jamais montré à la personne. */
    reason: text('reason').notNull(),
    /** Terme d'un bannissement temporaire ; nul : jusqu'à sa levée. */
    bannedUntil: instant('banned_until'),
    bannedBy: char('banned_by', { length: 36 })
      .notNull()
      .references(() => staffMembers.id, { onDelete: 'restrict' }),
    liftedAt: instant('lifted_at'),
    liftedBy: char('lifted_by', { length: 36 }).references(() => staffMembers.id, {
      onDelete: 'restrict',
    }),
    ...timestamps(),
  },
  (table) => [
    index('account_bans_tenant_user_idx').on(table.tenantId, table.authUserId),
    // Une levée dit qui l'a faite.
    check(
      'account_bans_lift_traced',
      sql`(${table.liftedAt} is null) = (${table.liftedBy} is null)`,
    ),
    check(
      'account_bans_reason_present',
      sql`char_length(trim(${table.reason})) > 0`,
    ),
  ],
)

export type AccountBan = typeof accountBans.$inferSelect
