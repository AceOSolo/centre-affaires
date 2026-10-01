'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { requirePermission } from '../../lib/auth/staff.ts'

import { resourceTypes, type ResourceType } from '../ressources/schema.ts'
import { validateRatePlanForm } from './grilles-formulaire.ts'
import {
  ArchivedRatePlanError,
  DefaultRatePlanConflictError,
  DuplicateRateError,
  addRatePlanItem,
  archiveRatePlan,
  createRatePlan,
  removeRatePlanItem,
  updateRatePlan,
} from './queries.ts'
import { rateUnits, type RateUnit } from './schema.ts'
import { parseAmountToCents } from './tarifs.ts'

/**
 * État rendu aux formulaires. `fieldErrors` rattache chaque erreur à son champ
 * (affichée à côté et reprise dans le résumé en tête), `values` rend la saisie
 * après un échec, `saved` dit qu'une modification a réussi.
 */
export type FormState = {
  error?: string
  fieldErrors?: Record<string, string>
  values?: Record<string, string>
  saved?: boolean
} | null

function text(formData: FormData, key: string): string {
  return String(formData.get(key) ?? '').trim()
}

/** Saisie d'une grille : nom, validité (R08), rôle de grille par défaut. */
function readRatePlanForm(formData: FormData) {
  const values = {
    name: text(formData, 'name'),
    validFrom: text(formData, 'validFrom'),
    validTo: text(formData, 'validTo'),
  }
  return { values, isDefault: formData.get('isDefault') === 'on' }
}

export async function createRatePlanAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  // Contrôle d'accès dans l'action elle-même : une action serveur s'invoque
  // par son identifiant depuis n'importe quel chemin, le filtre de routes ne
  // la protège pas (ADR 008).
  await requirePermission('tarifs.gerer')
  const { values, isDefault } = readRatePlanForm(formData)
  const result = validateRatePlanForm({ ...values, isDefault })
  if (!result.ok) return { fieldErrors: result.fieldErrors, values }

  let id: string
  try {
    id = (await createRatePlan(result.input)).id
  } catch (error) {
    if (error instanceof DefaultRatePlanConflictError) return { error: error.message, values }
    throw error
  }

  revalidatePath('/tarifs')
  redirect(`/tarifs/${id}`)
}

/**
 * Modification d'une grille : nom, dates de validité, grille par défaut. Les
 * dates s'appliquent dès l'enregistrement aux devis à venir ; une réservation
 * déjà chiffrée garde son prix (ADR 023).
 */
export async function updateRatePlanAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  await requirePermission('tarifs.gerer')
  const id = text(formData, 'id')
  const { values, isDefault } = readRatePlanForm(formData)
  const result = validateRatePlanForm({ ...values, isDefault })
  if (!result.ok) return { fieldErrors: result.fieldErrors, values }

  try {
    if (!(await updateRatePlan(id, result.input))) {
      return { error: 'Cette grille est archivée ou introuvable : elle ne se modifie plus.', values }
    }
  } catch (error) {
    if (error instanceof DefaultRatePlanConflictError) return { error: error.message, values }
    throw error
  }

  revalidatePath('/tarifs')
  revalidatePath(`/tarifs/${id}`)
  return { saved: true }
}

export async function addRatePlanItemAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  await requirePermission('tarifs.gerer')
  const ratePlanId = text(formData, 'ratePlanId')
  const resourceType = text(formData, 'resourceType')
  const unit = text(formData, 'unit')

  if (!ratePlanId) return { error: 'Grille introuvable.' }
  if (!resourceTypes.includes(resourceType as ResourceType)) {
    return { error: 'Type de ressource inconnu.' }
  }
  if (!rateUnits.includes(unit as RateUnit)) return { error: 'Unité inconnue.' }

  const amountCents = parseAmountToCents(text(formData, 'amount'))
  if (amountCents === undefined) return { error: 'Montant illisible. Exemple : 25,00' }

  try {
    await addRatePlanItem({
      ratePlanId,
      resourceType: resourceType as ResourceType,
      resourceId: text(formData, 'resourceId') || null,
      unit: unit as RateUnit,
      amountCents,
    })
  } catch (error) {
    if (error instanceof DuplicateRateError || error instanceof ArchivedRatePlanError) {
      return { error: error.message }
    }
    throw error
  }

  revalidatePath(`/tarifs/${ratePlanId}`)
  return null
}

export async function removeRatePlanItemAction(formData: FormData): Promise<void> {
  await requirePermission('tarifs.gerer')
  const id = text(formData, 'id')
  const ratePlanId = text(formData, 'ratePlanId')
  if (!id) return
  // Retrait logique (décision 6) : le prix cesse de s'appliquer, la ligne
  // reste pour expliquer un montant déjà calculé avec lui. Sur une grille
  // archivée, le bouton est désactivé ; une requête qui arrive quand même ne
  // change rien.
  try {
    await removeRatePlanItem(id)
  } catch (error) {
    if (!(error instanceof ArchivedRatePlanError)) throw error
  }
  revalidatePath(`/tarifs/${ratePlanId}`)
}

export async function archiveRatePlanAction(formData: FormData): Promise<void> {
  await requirePermission('tarifs.gerer')
  const id = text(formData, 'id')
  if (!id) return
  await archiveRatePlan(id)
  revalidatePath('/tarifs')
  redirect('/tarifs')
}
