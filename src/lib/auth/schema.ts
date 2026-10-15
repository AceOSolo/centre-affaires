import { boolean, index, mysqlTable, text, varchar } from 'drizzle-orm/mysql-core'

import { instant } from '../../db/columns.ts'

/**
 * Tables de Better Auth, dans la même base MySQL que le métier (ADR 042).
 *
 * Elles remplacent le schéma `neon_auth` de Neon Auth. Les noms de propriétés
 * sont ceux que Better Auth attend (`emailVerified`, `userId`…) ; les colonnes
 * sont en `snake_case` comme le reste de la base.
 *
 * `auth_users.id` est un texte généré par Better Auth, pas un UUID : c'est
 * cette valeur que `staff_members.auth_user_id` et `client_members.auth_user_id`
 * rattachent à une personne. Pas de clé étrangère depuis ces tables : le
 * rattachement se fait à la première connexion, sur l'adresse (ADR 008).
 */
export const authUsers = mysqlTable('auth_users', {
  id: varchar('id', { length: 36 }).primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: instant('created_at').notNull(),
  updatedAt: instant('updated_at').notNull(),
})

export const authSessions = mysqlTable(
  'auth_sessions',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    expiresAt: instant('expires_at').notNull(),
    token: varchar('token', { length: 255 }).notNull().unique(),
    createdAt: instant('created_at').notNull(),
    updatedAt: instant('updated_at').notNull(),
    ipAddress: varchar('ip_address', { length: 64 }),
    userAgent: text('user_agent'),
    userId: varchar('user_id', { length: 36 })
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
  },
  (table) => [index('auth_sessions_user_idx').on(table.userId)],
)

export const authAccounts = mysqlTable(
  'auth_accounts',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    accountId: varchar('account_id', { length: 255 }).notNull(),
    providerId: varchar('provider_id', { length: 255 }).notNull(),
    userId: varchar('user_id', { length: 36 })
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: instant('access_token_expires_at'),
    refreshTokenExpiresAt: instant('refresh_token_expires_at'),
    scope: text('scope'),
    /** Empreinte du mot de passe (scrypt), jamais le mot de passe. */
    password: text('password'),
    createdAt: instant('created_at').notNull(),
    updatedAt: instant('updated_at').notNull(),
  },
  (table) => [index('auth_accounts_user_idx').on(table.userId)],
)

export const authVerifications = mysqlTable(
  'auth_verifications',
  {
    id: varchar('id', { length: 36 }).primaryKey(),
    identifier: varchar('identifier', { length: 255 }).notNull(),
    value: text('value').notNull(),
    expiresAt: instant('expires_at').notNull(),
    createdAt: instant('created_at').notNull(),
    updatedAt: instant('updated_at').notNull(),
  },
  (table) => [index('auth_verifications_identifier_idx').on(table.identifier)],
)
