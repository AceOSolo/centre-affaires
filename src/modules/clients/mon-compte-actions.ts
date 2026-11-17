'use server'

import { revalidatePath } from 'next/cache'

import { getAuth } from '../../lib/auth/server.ts'
import { readProfileForm, type ProfileErrors, type ProfileValues } from './mon-compte.ts'
import { saveMemberProfile } from './mon-compte-queries.ts'
import { requireClientAccount } from './session.ts'

/**
 * « Mon compte » (ADR 077) : nom et téléphone de la personne connectée.
 * L'action revérifie le compte — une action serveur s'invoque par son
 * identifiant depuis n'importe quelle page (ADR 008) — et n'écrit que sur ses
 * propres accès.
 *
 * Le nom est aussi celui du compte (Better Auth) : il sert au « Bonjour » de
 * l'accueil. Le mot de passe se change dans le navigateur, par le client
 * d'authentification (`mot-de-passe-form.tsx`), qui vérifie l'ancien.
 */
export type ProfileFormState = {
  saved?: boolean
  error?: string
  errors?: ProfileErrors
  values?: ProfileValues
} | null

export async function saveProfileAction(_previous: ProfileFormState, formData: FormData): Promise<ProfileFormState> {
  const { user, accounts } = await requireClientAccount()
  const read = readProfileForm(formData)
  if (read.errors) return { errors: read.errors, values: read.values }

  try {
    await saveMemberProfile(accounts, read.input)
  } catch (error) {
    console.error('Mon compte : enregistrement refusé', error)
    return { error: 'Vos informations n’ont pas pu être enregistrées. Réessayez dans quelques instants.', values: read.values }
  }
  try {
    const context = await getAuth().$context
    await context.internalAdapter.updateUser(user.id, { name: read.input.fullName })
  } catch (error) {
    // Les accès sont à jour : seul le « Bonjour » de l'accueil garde l'ancien nom.
    console.error('Mon compte : nom du compte non mis à jour', error)
  }
  revalidatePath('/compte', 'layout')
  return { saved: true, values: { fullName: read.input.fullName, phone: read.input.phone ?? '' } }
}
