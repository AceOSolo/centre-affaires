import { sql } from 'drizzle-orm'
import {
  check,
  date,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'

import { deletedAt, primaryKeyId, timestamps } from './columns.ts'
import { tenantId } from './tenants.ts'

/**
 * Membres de l'équipe d'un centre, c'est-à-dire qui a le droit d'entrer dans le
 * back-office (ADR 008).
 *
 * Neon Auth dit **qui** est connecté ; cette table dit **ce à quoi** cette
 * personne a droit. La séparation n'est pas théorique : le relais `/api/auth`
 * expose l'inscription, donc n'importe qui peut se créer un compte. Sans une
 * liste tenue de notre côté, ouvrir l'authentification reviendrait à ouvrir le
 * back-office.
 *
 * Posée dans `src/db/` et non dans `src/modules/` : ce n'est pas un domaine
 * métier au sens de `CLAUDE.md`, c'est du contrôle d'accès transverse — au même
 * titre que `tenants`, qui vit déjà ici.
 */
export const staffRoles = ['admin', 'staff'] as const
export type StaffRole = (typeof staffRoles)[number]
export const staffRoleEnum = pgEnum('staff_role', staffRoles)

/**
 * Les rôles du cahier des charges (R27), sous les valeurs techniques gardées
 * en base (ADR 019) : `admin` est l'exploitant, `staff` l'accueil. C'est ce
 * libellé que l'interface affiche, jamais la valeur.
 */
export const staffRoleLabels: Record<StaffRole, string> = {
  admin: 'Exploitant',
  staff: 'Accueil',
}

/**
 * Fondement d'une anonymisation (R29, ADR 040 et 041), tracé avec elle sur
 * `clients`, `client_members` et `staff_members` :
 *
 * - `retention` : au terme de la durée de conservation, par la tâche de nuit,
 *   sans auteur ;
 * - `erasure_request` : demande d'effacement de la personne (art. 17 du
 *   RGPD), datée du jour où elle a été reçue — le centre a un mois pour y
 *   répondre (art. 12-3) ;
 * - `relationship_ended` : fin de la relation constatée par l'équipe, sans
 *   attendre la durée.
 *
 * Une catégorie et non un motif libre : le motif d'un effacement ne doit pas
 * conserver ce qu'il efface.
 */
export const anonymizationBases = ['retention', 'erasure_request', 'relationship_ended'] as const
export type AnonymizationBasis = (typeof anonymizationBases)[number]
export const anonymizationBasisEnum = pgEnum('anonymization_basis', anonymizationBases)

export const staffMembers = pgTable(
  'staff_members',
  {
    id: primaryKeyId(),
    tenantId: tenantId(),
    /**
     * Identifiant du compte Neon Auth (`neon_auth.user.id`), en texte : le
     * schéma managé n'utilise pas d'UUID.
     *
     * Nul tant que la personne ne s'est pas connectée une première fois : un
     * membre est inscrit par son adresse, et le compte lui est rattaché au
     * premier accès. Pas de clé étrangère vers `neon_auth` — ce schéma est géré
     * par Neon, et le lier en dur ferait échouer nos écritures sur ses
     * évolutions.
     */
    authUserId: text('auth_user_id'),
    /** Toujours en minuscules : c'est la clé de rattachement au compte. */
    email: text('email').notNull(),
    fullName: text('full_name'),
    /** `admin` : exploitant, gère l'équipe ; `staff` : accueil (ADR 019). */
    role: staffRoleEnum('role').notNull().default('staff'),
    ...timestamps(),
    /** Retrait de l'équipe : l'accès cesse, l'historique reste (décision 6). */
    deletedAt: deletedAt(),
    /**
     * Anonymisation de la trace d'un membre retiré (R29, ADR 040) : nom et
     * adresse effacés, compte détaché. La ligne reste, elle signe des plis, des
     * numérisations, des factures. Posée par `anonymize_removed_members()` ou
     * `anonymize_staff_member()`, jamais par le code ; une ligne anonymisée ne
     * change plus (SQLSTATE `CA012`).
     */
    anonymizedAt: timestamp('anonymized_at', { withTimezone: true }),
    /** Membre de l'équipe qui l'a décidée ; nul pour la tâche de nuit (ADR 041). */
    anonymizedBy: uuid('anonymized_by').references((): AnyPgColumn => staffMembers.id, {
      onDelete: 'restrict',
    }),
    anonymizationBasis: anonymizationBasisEnum('anonymization_basis'),
    /** Jour où la demande d'effacement a été reçue, pour `erasure_request`. */
    erasureRequestedOn: date('erasure_requested_on', { mode: 'string' }),
  },
  (table) => [
    // Une adresse ne vaut qu'une fois par centre, et redevient libre après un
    // retrait — quelqu'un qui revient dans l'équipe est réinscrit.
    uniqueIndex('staff_members_tenant_email_key')
      .on(table.tenantId, table.email)
      .where(sql`deleted_at is null`),
    // Un compte ne peut pas être rattaché à deux membres actifs : sans cela, un
    // même identifiant donnerait deux jeux de droits.
    uniqueIndex('staff_members_auth_user_key')
      .on(table.authUserId)
      .where(sql`auth_user_id is not null and deleted_at is null`),
    index('staff_members_tenant_idx').on(table.tenantId),
    // Seul un membre retiré s'anonymise : un membre actif a encore besoin de
    // son adresse pour se connecter.
    check(
      'staff_members_anonymized_removed',
      sql`${table.anonymizedAt} is null or (${table.deletedAt} is not null and ${table.authUserId} is null)`,
    ),
    check(
      'staff_members_anonymization_traced',
      anonymizationTraceCheck(table),
    ),
  ],
)

/**
 * Le fondement, l'auteur et la date de la demande ne valent qu'avec
 * l'anonymisation ; une demande d'effacement est datée, une anonymisation au
 * terme n'a pas d'auteur, une anonymisation à la demande en a un. Un
 * fondement nul : anonymisée avant qu'il ne soit tracé (migration 0044).
 */
export function anonymizationTraceCheck(table: {
  anonymizedAt: AnyPgColumn
  anonymizedBy: AnyPgColumn
  anonymizationBasis: AnyPgColumn
  erasureRequestedOn: AnyPgColumn
}) {
  return sql`(${table.anonymizedAt} is not null or num_nonnulls(${table.anonymizedBy}, ${table.anonymizationBasis}, ${table.erasureRequestedOn}) = 0)
    and (${table.erasureRequestedOn} is null) = (${table.anonymizationBasis} is distinct from 'erasure_request')
    and (${table.anonymizationBasis} is null or (${table.anonymizedBy} is null) = (${table.anonymizationBasis} = 'retention'))`
}

export type StaffMember = typeof staffMembers.$inferSelect
export type NewStaffMember = typeof staffMembers.$inferInsert
