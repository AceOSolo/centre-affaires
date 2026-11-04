'use server'

import { revalidatePath } from 'next/cache'
import { after } from 'next/server'

import { and, eq } from 'drizzle-orm'

import { withTenant } from '../../db/index.ts'
import { INVITATION_JOURS } from '../../lib/auth/messages.ts'
import { requirePermission } from '../../lib/auth/staff.ts'
import { emailEnabled } from '../../lib/courriel.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { DuplicateClientMemberError, addClientMember, removeClientMember } from './comptes.ts'
import { sendInvitation } from './invitation.ts'
import { clientMembers } from './schema.ts'

export type MemberFormState = {
  ok?: string
  fieldErrors?: { email?: string }
  values?: { email: string; fullName: string }
} | null

/** Contrôle volontairement sommaire : c'est l'authentification qui vérifiera l'adresse. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export async function addClientMemberAction(
  _previous: MemberFormState,
  formData: FormData,
): Promise<MemberFormState> {
  await requirePermission('clients.gerer')
  const clientId = String(formData.get('clientId') ?? '')
  const values = {
    email: String(formData.get('email') ?? '').trim().toLowerCase(),
    fullName: String(formData.get('fullName') ?? '').trim(),
  }

  if (!EMAIL.test(values.email)) {
    return { fieldErrors: { email: 'Saisissez une adresse électronique valide.' }, values }
  }

  try {
    await addClientMember({ clientId, email: values.email, fullName: values.fullName || null })
  } catch (error) {
    if (error instanceof DuplicateClientMemberError) {
      return { fieldErrors: { email: error.message }, values }
    }
    throw error
  }

  after(() => sendInvitation(clientId, values.email))
  revalidatePath(`/clients/${clientId}`)
  return {
    ok: emailEnabled()
      ? `Accès ajouté pour ${values.email}. Un courriel lui donne le lien pour choisir son mot de passe, valable ${INVITATION_JOURS} jours.`
      : `Accès ajouté pour ${values.email}. Prévenez la personne : aucun courriel n’est envoyé tant que le SMTP n’est pas configuré.`,
  }
}

export type ResendInvitationState = { ok?: string; error?: string } | null

/**
 * Renvoie l'invitation d'un accès qui ne s'est pas encore connecté (ADR 059) :
 * un nouveau lien, valable de nouveau sept jours. L'envoi est attendu pour
 * dire à l'accueil s'il est parti.
 */
export async function resendInvitationAction(
  _previous: ResendInvitationState,
  formData: FormData,
): Promise<ResendInvitationState> {
  await requirePermission('clients.gerer')
  const clientId = String(formData.get('clientId') ?? '')
  const id = String(formData.get('id') ?? '')
  const tenantId = currentTenantId()
  const [member] = await withTenant(tenantId, (tx) =>
    tx
      .select({ email: clientMembers.email, authUserId: clientMembers.authUserId, deletedAt: clientMembers.deletedAt })
      .from(clientMembers)
      .where(and(eq(clientMembers.tenantId, tenantId), eq(clientMembers.id, id), eq(clientMembers.clientId, clientId))),
  )
  if (!member || member.deletedAt) return { error: 'Cet accès a été retiré : il n’y a plus d’invitation à envoyer.' }
  if (member.authUserId) {
    return {
      error: `${member.email} s’est déjà connecté : son accès est actif. En cas d’oubli, « Mot de passe oublié » sur la page de connexion lui donne un nouveau mot de passe.`,
    }
  }

  const outcome = await sendInvitation(clientId, member.email)
  revalidatePath(`/clients/${clientId}`)
  switch (outcome?.status) {
    case 'sent':
      return { ok: `Invitation renvoyée à ${member.email} : un nouveau lien, valable ${INVITATION_JOURS} jours.` }
    case 'not_configured':
      return {
        error: `Aucun courriel n’est parti : l’envoi n’est pas configuré sur le serveur (Réglages, « Courriels »). Prévenez ${member.email} autrement.`,
      }
    case 'failed':
      return { error: `L’envoi à ${member.email} a échoué. ${outcome.error ?? ''}`.trim() }
    case 'skipped':
      return { error: outcome.error ?? 'Le message n’est pas parti.' }
    default:
      return { error: 'L’invitation n’a pas pu être préparée. Réessayez dans un instant.' }
  }
}

export async function removeClientMemberAction(formData: FormData): Promise<void> {
  await requirePermission('clients.gerer')
  const clientId = String(formData.get('clientId') ?? '')
  const id = String(formData.get('id') ?? '')
  if (!id || !clientId) return
  await removeClientMember(id, clientId)
  revalidatePath(`/clients/${clientId}`)
}
