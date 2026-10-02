'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { requirePermission } from '../../lib/auth/staff.ts'
import { todayIsoDate } from '../../lib/dates.ts'
import { currentTenant } from '../../lib/tenant.ts'
import { isUuid } from '../../lib/uuid.ts'
import { resourceTypes } from '../ressources/schema.ts'
import {
  ArchivedOfferError,
  addOfferItem,
  archiveOffer,
  createOffer,
  loadOfferCatalogue,
  removeOfferItem,
  updateOffer,
  updateOfferItem,
} from './offres-queries.ts'
import {
  offerItemValues,
  readOfferHeaderForm,
  validateOfferItem,
  type OfferHeaderErrors,
  type OfferHeaderValues,
  type OfferItemErrors,
  type OfferItemValues,
} from './offres-regles.ts'

export type OfferFormState = {
  fieldErrors?: OfferHeaderErrors
  message?: string
  values?: OfferHeaderValues
} | null

/**
 * Création ou modification de l'en-tête d'une offre (nom, description,
 * période de facturation, engagement proposé). Réservé à l'exploitant
 * (`services.gerer`, ADR 024).
 */
export async function saveOfferAction(
  _previous: OfferFormState,
  formData: FormData,
): Promise<OfferFormState> {
  // Contrôle d'accès dans l'action elle-même (ADR 008, ADR 019).
  await requirePermission('services.gerer')
  const id = String(formData.get('id') ?? '') || null
  if (id !== null && !isUuid(id)) return { message: 'Offre introuvable.' }

  const read = readOfferHeaderForm(formData)
  if (read.fieldErrors) return { fieldErrors: read.fieldErrors, values: read.values }

  let savedId = id
  try {
    if (id) await updateOffer(id, read.input)
    else {
      // La devise de l'offre est celle du centre.
      const tenant = await currentTenant()
      savedId = (await createOffer({ ...read.input, currency: tenant.currency })).id
    }
  } catch (error) {
    if (error instanceof ArchivedOfferError) return { message: error.message, values: read.values }
    throw error
  }

  revalidatePath('/offres')
  redirect(`/offres/${savedId}?enregistre=${id ? 'modifiee' : 'creee'}`)
}

export async function archiveOfferAction(formData: FormData): Promise<void> {
  await requirePermission('services.gerer')
  const id = String(formData.get('id') ?? '')
  if (!isUuid(id)) return
  await archiveOffer(id)
  revalidatePath('/offres')
  redirect(`/offres/${id}?enregistre=archivee`)
}

export type OfferItemFormState = {
  fieldErrors?: OfferItemErrors
  message?: string
  values?: OfferItemValues
} | null

/** Ajout d'une ligne à une offre, ou modification si le formulaire porte un `itemId`. */
export async function saveOfferItemAction(
  _previous: OfferItemFormState,
  formData: FormData,
): Promise<OfferItemFormState> {
  await requirePermission('services.gerer')
  const offerId = String(formData.get('offerId') ?? '')
  const itemId = String(formData.get('itemId') ?? '') || null
  if (!isUuid(offerId) || (itemId !== null && !isUuid(itemId))) {
    return { message: 'Offre introuvable.' }
  }

  const tenant = await currentTenant()
  const catalogue = await loadOfferCatalogue(todayIsoDate(tenant.timezone))
  const values = offerItemValues(formData)
  const { input, errors } = validateOfferItem(values, {
    resourceTypes,
    resources: catalogue.resources,
    services: catalogue.services,
  })
  if (!input) return { fieldErrors: errors, values }

  try {
    if (itemId) {
      const updated = await updateOfferItem(offerId, itemId, input)
      if (!updated) return { message: 'Cette ligne a été retirée de l’offre entre-temps.', values }
    } else {
      await addOfferItem(offerId, input)
    }
  } catch (error) {
    if (error instanceof ArchivedOfferError) return { message: error.message, values }
    throw error
  }

  revalidatePath(`/offres/${offerId}`)
  revalidatePath('/offres')
  redirect(`/offres/${offerId}?enregistre=${itemId ? 'ligne-modifiee' : 'ligne-ajoutee'}#lignes`)
}

/** Retrait logique d'une ligne d'offre (décision 6). */
export async function removeOfferItemAction(formData: FormData): Promise<void> {
  await requirePermission('services.gerer')
  const offerId = String(formData.get('offerId') ?? '')
  const itemId = String(formData.get('itemId') ?? '')
  if (!isUuid(offerId) || !isUuid(itemId)) return
  let removed = false
  try {
    removed = await removeOfferItem(offerId, itemId)
  } catch (error) {
    // Offre archivée entre l'affichage et l'envoi : rien n'est retiré, la page le montre.
    if (!(error instanceof ArchivedOfferError)) throw error
  }
  revalidatePath(`/offres/${offerId}`)
  revalidatePath('/offres')
  redirect(removed ? `/offres/${offerId}?enregistre=ligne-retiree#lignes` : `/offres/${offerId}`)
}
