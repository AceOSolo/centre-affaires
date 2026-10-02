'use server'

import { revalidatePath } from 'next/cache'
import { after } from 'next/server'

import { requirePermission } from '../../lib/auth/staff.ts'
import { emailEnabled } from '../../lib/courriel.ts'
import { DuplicateClientMemberError, addClientMember, removeClientMember } from './comptes.ts'
import { sendInvitation } from './invitation.ts'

export type MemberFormState = {
  ok?: string
  fieldErrors?: { email?: string }
  values?: { email: string; fullName: string }
} | null

/** Contrôle volontairement sommaire : c'est Neon Auth qui vérifiera l'adresse. */
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
      ? `Accès ajouté pour ${values.email}. Un courriel l’en informe.`
      : `Accès ajouté pour ${values.email}. Prévenez la personne : aucun courriel n’est envoyé tant que le SMTP n’est pas configuré.`,
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
