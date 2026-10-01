'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { requirePermission } from '../../lib/auth/staff.ts'

import { resourceTypes, type ResourceType } from '../ressources/schema.ts'
import {
  DefaultRatePlanConflictError,
  DuplicateRateError,
  addRatePlanItem,
  archiveRatePlan,
  createRatePlan,
  removeRatePlanItem,
} from './queries.ts'
import { rateUnits, type RateUnit } from './schema.ts'
import { parseAmountToCents } from './tarifs.ts'

export type FormState = { error?: string } | null

function text(formData: FormData, key: string): string {
  return String(formData.get(key) ?? '').trim()
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export async function createRatePlanAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  // Contrôle d'accès dans l'action elle-même : une action serveur s'invoque
  // par son identifiant depuis n'importe quel chemin, le filtre de routes ne
  // la protège pas (ADR 008).
  await requirePermission('tarifs.gerer')
  const name = text(formData, 'name')
  if (!name) return { error: 'Nommer la grille.' }

  const validFrom = text(formData, 'validFrom')
  const validTo = text(formData, 'validTo')
  if (validFrom && !ISO_DATE.test(validFrom)) return { error: 'Date de début illisible.' }
  if (validTo && !ISO_DATE.test(validTo)) return { error: 'Date de fin illisible.' }
  if (validFrom && validTo && validTo < validFrom) {
    return { error: 'La fin de validité doit suivre le début.' }
  }

  let id: string
  try {
    id = (
      await createRatePlan({
        name,
        isDefault: formData.get('isDefault') === 'on',
        validFrom: validFrom || null,
        validTo: validTo || null,
      })
    ).id
  } catch (error) {
    if (error instanceof DefaultRatePlanConflictError) return { error: error.message }
    throw error
  }

  revalidatePath('/tarifs')
  redirect(`/tarifs/${id}`)
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
    if (error instanceof DuplicateRateError) return { error: error.message }
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
  // Une ligne de grille n'est pas une donnée métier à conserver : elle n'a ni
  // historique ni portée légale, contrairement au contrat qui s'y réfère et qui
  // porte, lui, son propre montant.
  await removeRatePlanItem(id)
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
