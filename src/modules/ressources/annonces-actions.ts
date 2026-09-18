'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { requireStaff } from '../../lib/auth/staff.ts'

import {
  DuplicateSlugError,
  publishListing,
  saveListing,
  unpublishListing,
} from './annonces-queries.ts'

export type FormState = { error?: string } | null

function text(formData: FormData, key: string): string {
  return String(formData.get(key) ?? '').trim()
}

/** Les écrans touchés par un changement d'annonce, back-office et public. */
function revalidateAnnonces(slug?: string): void {
  revalidatePath('/ressources/annonces')
  revalidatePath('/annonces')
  if (slug) revalidatePath(`/annonces/${slug}`)
}

export async function saveListingAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  // Contrôle d'accès dans l'action elle-même : une action serveur s'invoque par
  // son identifiant depuis n'importe quel chemin (ADR 008).
  await requireStaff()

  const resourceId = text(formData, 'resourceId')
  const headline = text(formData, 'headline')
  if (!resourceId) return { error: 'Ressource introuvable.' }
  if (!headline) return { error: "Donner un titre à l'annonce." }

  // Un point fort par ligne : la saisie d'une liste dans un textarea est plus
  // rapide que cinq champs, et le staff écrit déjà comme ça.
  const highlights = text(formData, 'highlights')
    .split('\n')
    .map((ligne) => ligne.trim())
    .filter(Boolean)
    .slice(0, 8)

  try {
    await saveListing({
      resourceId,
      headline,
      description: text(formData, 'description') || null,
      highlights,
      slug: text(formData, 'slug') || undefined,
    })
  } catch (error) {
    if (error instanceof DuplicateSlugError) return { error: error.message }
    throw error
  }

  revalidateAnnonces()
  redirect('/ressources/annonces')
}

export async function publishListingAction(formData: FormData): Promise<void> {
  await requireStaff()
  const id = text(formData, 'id')
  if (!id) return
  await publishListing(id)
  revalidateAnnonces(text(formData, 'slug'))
}

export async function unpublishListingAction(formData: FormData): Promise<void> {
  await requireStaff()
  const id = text(formData, 'id')
  if (!id) return
  await unpublishListing(id)
  revalidateAnnonces(text(formData, 'slug'))
}
