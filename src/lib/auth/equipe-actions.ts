'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { after } from 'next/server'

import { staffRoleLabels, staffRoles, type StaffRole } from '../../db/staff.ts'
import { emailEnabled } from '../courriel.ts'
import { isUuid } from '../uuid.ts'
import {
  assignableRoles,
  findTeamMember,
  inscribeTeamMember,
  teamRefusalMessages,
  updateTeamMember,
  type TeamChange,
} from './equipe.ts'
import { sendStaffInvitation } from './equipe-invitation.ts'
import { INVITATION_JOURS } from './messages.ts'
import { requirePermission } from './staff.ts'

/**
 * Actions de l'écran Équipe, réservées à l'exploitant et à la direction
 * (`equipe.gerer`). Chacune revérifie le droit : une action serveur s'invoque
 * par son identifiant, depuis n'importe quelle page (ADR 008). Le rôle donné
 * doit être de ceux que l'auteur peut donner (ADR 054).
 */

export type TeamFormState = {
  ok?: string
  fieldErrors?: { email?: string; role?: string }
  values?: { email: string; fullName: string; role: string }
} | null

/** Contrôle volontairement sommaire : le lien d'invitation, parti à cette adresse, la prouvera. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const isRole = (value: string): value is StaffRole =>
  (staffRoles as readonly string[]).includes(value)

export async function addTeamMemberAction(
  _previous: TeamFormState,
  formData: FormData,
): Promise<TeamFormState> {
  const { member } = await requirePermission('equipe.gerer')
  const values = {
    email: String(formData.get('email') ?? '').trim().toLowerCase(),
    fullName: String(formData.get('fullName') ?? '').trim(),
    role: String(formData.get('role') ?? ''),
  }

  const fieldErrors: NonNullable<TeamFormState>['fieldErrors'] = {}
  if (!EMAIL.test(values.email)) fieldErrors.email = 'Saisissez une adresse électronique valide.'
  if (!isRole(values.role)) fieldErrors.role = 'Choisissez un rôle.'
  else if (!assignableRoles(member.role).includes(values.role)) {
    fieldErrors.role = teamRefusalMessages['reserve-direction']
  }
  if (Object.keys(fieldErrors).length > 0) return { fieldErrors, values }

  const created = await inscribeTeamMember({
    email: values.email,
    fullName: values.fullName || null,
    role: values.role as StaffRole,
  })
  if (!created) {
    return { fieldErrors: { email: `${values.email} fait déjà partie de l’équipe.` }, values }
  }

  // Le lien pour choisir son mot de passe (ADR 068), après la réponse.
  after(() => sendStaffInvitation(created.id))
  revalidatePath('/equipe')
  return {
    ok: emailEnabled()
      ? `${created.email} ajouté comme ${staffRoleLabels[created.role]}. Un courriel lui donne le lien pour choisir son mot de passe, valable ${INVITATION_JOURS} jours.`
      : `${created.email} ajouté comme ${staffRoleLabels[created.role]}. Aucun courriel n’est parti : l’envoi n’est pas configuré (Réglages, « Courriels »). Prévenez la personne autrement.`,
  }
}

/**
 * Renvoie l'invitation d'un membre qui ne s'est pas encore connecté
 * (ADR 068) : un nouveau lien, valable de nouveau sept jours. Même règle que
 * les autres actions de la ligne : on ne touche qu'un membre dont on peut
 * donner le rôle. L'envoi est attendu pour dire s'il est parti.
 */
export async function resendStaffInvitationAction(
  _previous: TeamRowState,
  formData: FormData,
): Promise<TeamRowState> {
  const { member } = await requirePermission('equipe.gerer')
  const id = String(formData.get('id') ?? '')
  if (!isUuid(id)) return { error: 'Demande illisible : rechargez la page.' }
  const target = await findTeamMember(id)
  if (!target || target.deletedAt) return { error: 'Ce membre a été retiré : il n’y a plus d’invitation à envoyer.' }
  if (!assignableRoles(member.role).includes(target.role)) return { error: teamRefusalMessages['reserve-direction'] }
  if (target.authUserId) {
    return {
      error: `${target.email} s’est déjà connecté. En cas d’oubli, « Mot de passe oublié » sur la page de connexion de l’équipe lui donne un nouveau mot de passe.`,
    }
  }

  const outcome = await sendStaffInvitation(target.id)
  revalidatePath('/equipe')
  switch (outcome?.status) {
    case 'sent':
      return { ok: `Invitation renvoyée à ${target.email} : un nouveau lien, valable ${INVITATION_JOURS} jours.` }
    case 'not_configured':
      return {
        error: `Aucun courriel n’est parti : l’envoi n’est pas configuré sur le serveur (Réglages, « Courriels »). Prévenez ${target.email} autrement.`,
      }
    case 'failed':
      return { error: `L’envoi à ${target.email} a échoué. ${outcome.error ?? ''}`.trim() }
    case 'skipped':
      return { error: outcome.error ?? 'Le message n’est pas parti.' }
    default:
      return { error: 'L’invitation n’a pas pu être préparée. Réessayez dans un instant.' }
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
