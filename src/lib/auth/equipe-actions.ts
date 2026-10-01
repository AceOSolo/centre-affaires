'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { staffRoleLabels, staffRoles, type StaffRole } from '../../db/staff.ts'
import { isUuid } from '../uuid.ts'
import {
  inscribeTeamMember,
  teamRefusalMessages,
  updateTeamMember,
  type TeamChange,
} from './equipe.ts'
import { requirePermission } from './staff.ts'

/**
 * Actions de l'écran Équipe, réservées à l'exploitant (`equipe.gerer`). Chacune
 * revérifie le droit : une action serveur s'invoque par son identifiant,
 * depuis n'importe quelle page (ADR 008).
 */

export type TeamFormState = {
  ok?: string
  fieldErrors?: { email?: string; role?: string }
  values?: { email: string; fullName: string; role: string }
} | null

/** Contrôle volontairement sommaire : c'est Neon Auth qui vérifiera l'adresse. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const isRole = (value: string): value is StaffRole =>
  (staffRoles as readonly string[]).includes(value)

export async function addTeamMemberAction(
  _previous: TeamFormState,
  formData: FormData,
): Promise<TeamFormState> {
  await requirePermission('equipe.gerer')
  const values = {
    email: String(formData.get('email') ?? '').trim().toLowerCase(),
    fullName: String(formData.get('fullName') ?? '').trim(),
    role: String(formData.get('role') ?? ''),
  }

  const fieldErrors: NonNullable<TeamFormState>['fieldErrors'] = {}
  if (!EMAIL.test(values.email)) fieldErrors.email = 'Saisissez une adresse électronique valide.'
  if (!isRole(values.role)) fieldErrors.role = 'Choisissez un rôle.'
  if (Object.keys(fieldErrors).length > 0) return { fieldErrors, values }

  const created = await inscribeTeamMember({
    email: values.email,
    fullName: values.fullName || null,
    role: values.role as StaffRole,
  })
  if (!created) {
    return { fieldErrors: { email: `${values.email} fait déjà partie de l’équipe.` }, values }
  }

  revalidatePath('/equipe')
  return {
    ok:
      `${created.email} inscrit comme ${staffRoleLabels[created.role]}. ` +
      'La personne crée son accès sur la page de connexion avec cette adresse ; le rattachement se fait à sa première connexion.',
  }
}

/** Réponse rendue à côté des boutons d'une ligne, annoncée au lecteur d'écran. */
export type TeamRowState = { ok?: string; error?: string } | null

/**
 * Actions d'une ligne : changer le rôle (`intent=role`) ou retirer de
 * l'équipe (`intent=retrait`), sous la règle de `equipe.ts`.
 *
 * Un retrait fait disparaître la ligne, et avec elle tout message qu'elle
 * porterait : son succès est dit par la page, où l'on revient.
 */
export async function teamRowAction(
  _previous: TeamRowState,
  formData: FormData,
): Promise<TeamRowState> {
  const { member } = await requirePermission('equipe.gerer')
  const id = String(formData.get('id') ?? '')
  const intent = String(formData.get('intent') ?? '')
  const role = String(formData.get('role') ?? '')
  const change: TeamChange | undefined =
    intent === 'retrait'
      ? { kind: 'retrait' }
      : intent === 'role' && isRole(role)
        ? { kind: 'role', role }
        : undefined
  if (!isUuid(id) || !change) return { error: 'Demande illisible : rechargez la page.' }

  const result = await updateTeamMember(member.id, id, change)
  if (!result.ok) return { error: teamRefusalMessages[result.refusal] }

  revalidatePath('/equipe')
  const changed = result.member
  // Hors de tout try : `redirect` interrompt par une exception.
  if (change.kind === 'retrait') redirect(`/equipe?retire=${changed.id}`)
  return { ok: `${changed.fullName ?? changed.email} est maintenant ${staffRoleLabels[changed.role]}.` }
}
