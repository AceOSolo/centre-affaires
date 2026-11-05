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
import { createInvitedClient } from './invitation-rapide.ts'
import { clientMembers } from './schema.ts'

export type QuickInviteFormState = {
  ok?: string
  /** Fiche créée, ou fiche où l'adresse a déjà son accès : le lien du message. */
  client?: { id: string; name: string }
  fieldErrors?: { email?: string; fullName?: string; company?: string }
  values?: { email: string; fullName: string; company: string }
} | null

/**
 * « Inviter un client » de l'écran Comptes (ADR 068) : une adresse suffit.
 * La fiche prospect et l'accès sont créés ensemble, puis l'invitation part
 * comme depuis la fiche — lien pour choisir son mot de passe, sept jours.
 * Une adresse qui a déjà un accès en cours n'en reçoit pas un second : le
 * message mène à sa fiche, d'où l'on renvoie l'invitation.
 */
export async function inviteNewClientAction(
  _previous: QuickInviteFormState,
  formData: FormData,
): Promise<QuickInviteFormState> {
  await requirePermission('clients.gerer')
  const values = {
    email: String(formData.get('email') ?? '').trim().toLowerCase(),
    fullName: String(formData.get('fullName') ?? '').trim(),
    company: String(formData.get('company') ?? '').trim(),
  }
  const fieldErrors: NonNullable<QuickInviteFormState>['fieldErrors'] = {}
  if (!EMAIL.test(values.email)) fieldErrors.email = 'Saisissez une adresse électronique valide.'
  if (values.fullName.length > 255) fieldErrors.fullName = 'Le nom compte 255 caractères au plus.'
  if (values.company.length > 255) fieldErrors.company = 'Le nom de l’entreprise compte 255 caractères au plus.'
  if (Object.keys(fieldErrors).length > 0) return { fieldErrors, values }

  const result = await createInvitedClient({
    email: values.email,
    fullName: values.fullName || null,
    company: values.company || null,
  })
  const client = { id: result.clientId, name: result.clientName }
  if (!result.ok) {
    return {
      client,
      fieldErrors: {
        email: `${values.email} a déjà accès à l’espace de ${result.clientName}. Renvoyez l’invitation depuis sa fiche si besoin.`,
      },
      values,
    }
  }

  after(() => sendInvitation(result.clientId, values.email))
  revalidatePath('/comptes')
  revalidatePath('/clients')
  return {
    client,
    ok: emailEnabled()
      ? `Fiche « ${result.clientName} » créée. ${values.email} reçoit le lien pour choisir son mot de passe, valable ${INVITATION_JOURS} jours.`
      : `Fiche « ${result.clientName} » créée. Aucun courriel n’est parti : l’envoi n’est pas configuré (Réglages, « Courriels »). Prévenez la personne autrement.`,
  }
}

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
