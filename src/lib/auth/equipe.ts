import { and, asc, eq, isNull, or, sql } from 'drizzle-orm'

import { maintenant } from '../../db/columns.ts'
import { withTenant, type Transaction } from '../../db/index.ts'
import { updateReturning } from '../../db/returning.ts'
import { staffMembers, staffRoles, type StaffMember, type StaffRole } from '../../db/staff.ts'
import { inCurrentTenant } from './membre.ts'
import { can } from './permissions.ts'
import { currentTenantId } from '../tenant.ts'
import { isUuid, uuidv7 } from '../uuid.ts'

/**
 * L'équipe du centre, gérée depuis le back-office (R27, ADR 019) : la
 * direction nomme et retire les exploitants, l'exploitant inscrit et retire
 * l'accueil (ADR 054). Remplace l'usage courant de
 * `infra/ajouter-membre-staff.mjs`, qui reste la porte d'amorçage : tant
 * qu'aucune direction n'existe, personne ne peut nommer d'exploitant depuis
 * l'application.
 *
 * Comme `membre.ts`, ce module ne connaît ni Next ni la session : les règles
 * s'éprouvent contre une vraie base (`equipe.db.test.ts`).
 */

/** Ce qui fait refuser un changement dans l'équipe. */
export type TeamRefusal = 'soi-meme' | 'reserve-direction' | 'derniere-direction' | 'introuvable'

export const teamRefusalMessages: Record<TeamRefusal, string> = {
  'soi-meme':
    'Vous ne pouvez ni vous retirer de l’équipe ni changer votre propre rôle : demandez-le à la direction.',
  'reserve-direction':
    'Seule la direction nomme, rétrograde ou retire un exploitant ou un membre de la direction.',
  'derniere-direction':
    'C’est le dernier membre de la direction : nommez-en un autre avant de le retirer ou de changer son rôle.',
  introuvable: 'Ce membre ne fait plus partie de l’équipe.',
}

export type TeamChange = { kind: 'retrait' } | { kind: 'role'; role: StaffRole }

/**
 * Les rôles qu'un membre peut donner (ADR 054) : tous pour la direction,
 * l'accueil seul pour l'exploitant, aucun pour l'accueil. Sert à
 * l'inscription, au changement de rôle, et à dire sur qui l'on a la main :
 * on ne touche qu'un membre dont on pourrait donner le rôle.
 */
export function assignableRoles(role: StaffRole | null | undefined): StaffRole[] {
  if (can(role, 'equipe.exploitants')) return [...staffRoles]
  if (can(role, 'equipe.gerer')) return ['staff']
  return []
}

/**
 * La règle, seule :
 *
 * - on ne se retire pas soi-même, on ne change pas son propre rôle ;
 * - on ne touche qu'un membre dont on peut donner le rôle, et l'on ne donne
 *   que ces rôles-là : la direction seule nomme, rétrograde ou retire un
 *   exploitant ou un membre de la direction ;
 * - le centre garde toujours au moins un membre de la direction.
 *
 * `actor` est relu en base sous verrou, pas pris de la session : un membre
 * rétrogradé à l'instant n'a plus la main. `activeDirectionCount` compte la
 * direction active, la cible comprise.
 */
export function checkTeamChange(input: {
  actor: Pick<StaffMember, 'id' | 'role'> | undefined
  target: Pick<StaffMember, 'id' | 'role'>
  change: TeamChange
  activeDirectionCount: number
}): TeamRefusal | null {
  const { actor, target, change, activeDirectionCount } = input
  if (target.id === actor?.id) return 'soi-meme'
  const allowed = assignableRoles(actor?.role)
  if (!allowed.includes(target.role) || (change.kind === 'role' && !allowed.includes(change.role))) {
    return 'reserve-direction'
  }
  // Ne se déclenche que si une règle ci-dessus change : la direction ne
  // touche qu'une autre direction, il en reste donc une. Gardée exprès.
  const losesDirection =
    target.role === 'super_admin' && (change.kind === 'retrait' || change.role !== 'super_admin')
  if (losesDirection && activeDirectionCount <= 1) return 'derniere-direction'
  return null
}

/** Membres actifs : la direction, les exploitants puis l'accueil, par adresse. */
export async function listTeam(tx: Transaction): Promise<StaffMember[]> {
  return tx
    .select()
    .from(staffMembers)
    .where(and(inCurrentTenant(), isNull(staffMembers.deletedAt)))
    .orderBy(asc(staffMembers.role), asc(staffMembers.email))
}

/**
 * Inscription par adresse. Rend `undefined` quand l'adresse est déjà celle
 * d'un membre actif : l'index unique (adresse, `live`) en décide, sans lecture
 * préalable qui laisserait passer deux inscriptions simultanées.
 *
 * L'identifiant est posé avant l'insertion : si une autre ligne l'a emporté,
 * il n'existe pas en base et la relecture ne rend rien.
 * `ON DUPLICATE KEY UPDATE` no-op plutôt que `INSERT IGNORE`, qui avalerait
 * aussi les erreurs de clé étrangère et de contrôle.
 *
 * Le compte est rattaché à la première connexion (`resolveStaffMember`).
 */
export async function addTeamMember(
  tx: Transaction,
  input: { email: string; fullName: string | null; role: StaffRole },
): Promise<StaffMember | undefined> {
  const id = uuidv7()
  await tx
    .insert(staffMembers)
    .values({
      id,
      email: input.email.trim().toLowerCase(),
      fullName: input.fullName,
      role: input.role,
    })
    .onDuplicateKeyUpdate({ set: { id: sql`id` } })
  const [created] = await tx.select().from(staffMembers).where(eq(staffMembers.id, id)).limit(1)
  return created
}

export type TeamChangeResult =
  | { ok: true; member: StaffMember }
  | { ok: false; refusal: TeamRefusal }

/**
 * Changement de rôle ou retrait, sous la règle de `checkTeamChange`.
 *
 * La direction active, l'auteur et la cible sont verrouillés ensemble, dans
 * l'ordre des identifiants : deux membres de la direction qui se rétrogradent
 * l'un l'autre au même instant passent l'un après l'autre, et le second relit
 * son propre rôle, déjà perdu. Sans ce verrou, chacun se croirait encore de la
 * direction et le centre finirait sans aucune.
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
        inCurrentTenant(),
        isNull(staffMembers.deletedAt),
        or(
          eq(staffMembers.role, 'super_admin'),
          eq(staffMembers.id, targetId),
          eq(staffMembers.id, actorId),
        ),
      ),
    )
    .orderBy(asc(staffMembers.id))
    .for('update')

  const target = locked.find((row) => row.id === targetId)
  if (!target) return { ok: false, refusal: 'introuvable' }

  const refusal = checkTeamChange({
    actor: locked.find((row) => row.id === actorId),
    target,
    change,
    activeDirectionCount: locked.filter((row) => row.role === 'super_admin').length,
  })
  if (refusal) return { ok: false, refusal }

  const [updated] = await updateReturning(
    tx,
    staffMembers,
    change.kind === 'retrait'
      ? // Retrait logique : l'accès cesse, la trace reste (décision 6).
        { deletedAt: maintenant() }
      : { role: change.role },
    and(inCurrentTenant(), eq(staffMembers.id, targetId), isNull(staffMembers.deletedAt)),
  )
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
    tx
      .select()
      .from(staffMembers)
      .where(and(inCurrentTenant(), eq(staffMembers.id, id)))
      .limit(1),
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
