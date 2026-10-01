import { and, asc, eq, isNull, or, sql } from 'drizzle-orm'

import { withTenant, type Transaction } from '../../db/index.ts'
import { staffMembers, type StaffMember, type StaffRole } from '../../db/staff.ts'
import { currentTenantId } from '../tenant.ts'
import { isUuid } from '../uuid.ts'

/**
 * L'équipe du centre, gérée depuis le back-office par l'exploitant (R27,
 * ADR 019). Remplace l'usage courant de `infra/ajouter-membre-staff.mjs`, qui
 * reste la porte d'amorçage : tant qu'aucun exploitant n'existe, personne ne
 * peut ouvrir cet écran.
 *
 * Comme `membre.ts`, ce module ne connaît ni Next ni la session : les règles
 * s'éprouvent contre une vraie base (`equipe.db.test.ts`).
 */

/** Ce qui fait refuser un changement dans l'équipe. */
export type TeamRefusal = 'soi-meme' | 'dernier-exploitant' | 'introuvable'

export const teamRefusalMessages: Record<TeamRefusal, string> = {
  'soi-meme':
    'Vous ne pouvez ni vous retirer de l’équipe ni changer votre propre rôle : demandez-le à un autre exploitant.',
  'dernier-exploitant':
    'C’est le dernier exploitant du centre : nommez-en un autre avant de le retirer ou de le passer à l’accueil.',
  introuvable: 'Ce membre ne fait plus partie de l’équipe.',
}

export type TeamChange = { kind: 'retrait' } | { kind: 'role'; role: StaffRole }

/**
 * La règle, seule : on ne se retire pas soi-même, on ne change pas son propre
 * rôle, et le centre garde toujours au moins un exploitant — sans lui,
 * personne ne pourrait plus gérer l'équipe depuis l'application.
 *
 * `activeAdminCount` compte les exploitants actifs, la cible comprise.
 */
export function checkTeamChange(input: {
  actorId: string
  target: Pick<StaffMember, 'id' | 'role'>
  change: TeamChange
  activeAdminCount: number
}): TeamRefusal | null {
  const { actorId, target, change, activeAdminCount } = input
  if (target.id === actorId) return 'soi-meme'
  const losesAdmin =
    target.role === 'admin' && (change.kind === 'retrait' || change.role !== 'admin')
  if (losesAdmin && activeAdminCount <= 1) return 'dernier-exploitant'
  return null
}

/** Membres actifs : les exploitants d'abord, puis par adresse. */
export async function listTeam(tx: Transaction): Promise<StaffMember[]> {
  return tx
    .select()
    .from(staffMembers)
    .where(isNull(staffMembers.deletedAt))
    .orderBy(asc(staffMembers.role), asc(staffMembers.email))
}

/**
 * Inscription par adresse. Rend `undefined` quand l'adresse est déjà celle
 * d'un membre actif : l'index unique partiel en décide, sans lecture préalable
 * qui laisserait passer deux inscriptions simultanées.
 *
 * Le compte est rattaché à la première connexion (`resolveStaffMember`).
 */
export async function addTeamMember(
  tx: Transaction,
  input: { email: string; fullName: string | null; role: StaffRole },
): Promise<StaffMember | undefined> {
  const [created] = await tx
    .insert(staffMembers)
    .values({
      email: input.email.trim().toLowerCase(),
      fullName: input.fullName,
      role: input.role,
    })
    .onConflictDoNothing()
    .returning()
  return created
}

export type TeamChangeResult =
  | { ok: true; member: StaffMember }
  | { ok: false; refusal: TeamRefusal }

/**
 * Changement de rôle ou retrait, sous la règle de `checkTeamChange`.
 *
 * Les exploitants actifs et la cible sont verrouillés ensemble, dans l'ordre
 * des identifiants : deux exploitants qui se rétrogradent l'un l'autre au
 * même instant passent l'un après l'autre, et le second relit un exploitant
 * de moins. Sans ce verrou, chacun compterait deux exploitants et le centre
 * finirait sans aucun.
 */
export async function changeTeamMember(
  tx: Transaction,
  actorId: string,
  targetId: string,
  change: TeamChange,
): Promise<TeamChangeResult> {
  const locked = await tx
    .select({ id: staffMembers.id, role: staffMembers.role })
    .from(staffMembers)
    .where(
      and(
        isNull(staffMembers.deletedAt),
        or(eq(staffMembers.role, 'admin'), eq(staffMembers.id, targetId)),
      ),
    )
    .orderBy(asc(staffMembers.id))
    .for('update')

  const target = locked.find((row) => row.id === targetId)
  if (!target) return { ok: false, refusal: 'introuvable' }

  const refusal = checkTeamChange({
    actorId,
    target,
    change,
    activeAdminCount: locked.filter((row) => row.role === 'admin').length,
  })
  if (refusal) return { ok: false, refusal }

  const [updated] = await tx
    .update(staffMembers)
    .set(
      change.kind === 'retrait'
        ? // Retrait logique : l'accès cesse, la trace reste (décision 6).
          { deletedAt: sql`now()` }
        : { role: change.role },
    )
    .where(and(eq(staffMembers.id, targetId), isNull(staffMembers.deletedAt)))
    .returning()
  return updated ? { ok: true, member: updated } : { ok: false, refusal: 'introuvable' }
}

/* -------------------------------------------------------------------------- */
/* Dans le centre courant                                                     */
/* -------------------------------------------------------------------------- */

export function listTeamMembers(): Promise<StaffMember[]> {
  return withTenant(currentTenantId(), listTeam)
}

/** Un membre, retiré compris : pour dire qui vient de quitter l'équipe. */
export async function findTeamMember(id: string): Promise<StaffMember | undefined> {
  if (!isUuid(id)) return undefined
  const [member] = await withTenant(currentTenantId(), (tx) =>
    tx.select().from(staffMembers).where(eq(staffMembers.id, id)).limit(1),
  )
  return member
}

export function inscribeTeamMember(
  input: Parameters<typeof addTeamMember>[1],
): Promise<StaffMember | undefined> {
  return withTenant(currentTenantId(), (tx) => addTeamMember(tx, input))
}

export function updateTeamMember(
  actorId: string,
  targetId: string,
  change: TeamChange,
): Promise<TeamChangeResult> {
  return withTenant(currentTenantId(), (tx) => changeTeamMember(tx, actorId, targetId, change))
}
