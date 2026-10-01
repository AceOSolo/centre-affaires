'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { requirePermission } from '../../lib/auth/staff.ts'

import {
  DuplicateResourceCodeError,
  archiveResource,
  createResource,
  updateResourceStatus,
} from './queries.ts'
import {
  resourceStatuses,
  resourceTypes,
  type ResourceAttributes,
  type ResourceStatus,
  type ResourceType,
} from './schema.ts'

/** Ce qu'un formulaire réaffiche après un échec : le message et la saisie. */
export type FormState = { error?: string } | null

function text(formData: FormData, key: string): string {
  return String(formData.get(key) ?? '').trim()
}

function optionalNumber(formData: FormData, key: string): number | null {
  const raw = text(formData, key)
  if (!raw) return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

/**
 * Champs propres au type (décision 2). Les types sans champ spécifique — une
 * boîte aux lettres — renvoient un objet vide, ce qui est une réponse et non un
 * oubli.
 */
function parseAttributes(
  resourceType: ResourceType,
  formData: FormData,
): ResourceAttributes[ResourceType] {
  switch (resourceType) {
    case 'salle':
      return {
        superficieM2: optionalNumber(formData, 'superficieM2') ?? undefined,
        equipements: text(formData, 'equipements')
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
      }
    case 'bureau':
      return {
        superficieM2: optionalNumber(formData, 'superficieM2') ?? undefined,
        postes: optionalNumber(formData, 'postes') ?? undefined,
      }
    case 'casier': {
      const taille = text(formData, 'taille')
      return taille === 'S' || taille === 'M' || taille === 'L' ? { taille } : {}
    }
    case 'vehicule':
      return {
        immatriculation: text(formData, 'immatriculation') || undefined,
        kilometrage: optionalNumber(formData, 'kilometrage') ?? undefined,
        places: optionalNumber(formData, 'places') ?? undefined,
      }
    case 'boite_aux_lettres':
      return {}
  }
}

export async function createResourceAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  // Contrôle d'accès dans l'action elle-même : une action serveur s'invoque
  // par son identifiant depuis n'importe quel chemin, le filtre de routes ne
  // la protège pas (ADR 008).
  await requirePermission('ressources.gerer')
  const resourceType = text(formData, 'resourceType') as ResourceType
  const code = text(formData, 'code')
  const name = text(formData, 'name')
  const status = text(formData, 'status') as ResourceStatus

  if (!resourceTypes.includes(resourceType)) return { error: 'Type de ressource inconnu.' }
  if (!code) return { error: 'Le code est obligatoire.' }
  if (!name) return { error: 'Le nom est obligatoire.' }

  try {
    await createResource({
      resourceType,
      code,
      name,
      description: text(formData, 'description') || null,
      capacity: optionalNumber(formData, 'capacity'),
      status: resourceStatuses.includes(status) ? status : 'active',
      attributes: parseAttributes(resourceType, formData),
    })
  } catch (error) {
    if (error instanceof DuplicateResourceCodeError) return { error: error.message }
    throw error
  }

  // Hors du `try` : `redirect` interrompt l'exécution en levant, un `catch`
  // l'avalerait et la page resterait sur le formulaire.
  revalidatePath('/ressources')
  redirect('/ressources')
}

export async function updateResourceStatusAction(formData: FormData): Promise<void> {
  await requirePermission('ressources.gerer')
  const id = text(formData, 'id')
  const status = text(formData, 'status') as ResourceStatus
  if (!id || !resourceStatuses.includes(status)) return
  await updateResourceStatus(id, status)
  revalidatePath('/ressources')
  revalidatePath('/reservations')
}

export async function archiveResourceAction(formData: FormData): Promise<void> {
  await requirePermission('ressources.gerer')
  const id = text(formData, 'id')
  if (!id) return
  await archiveResource(id)
  revalidatePath('/ressources')
  revalidatePath('/reservations')
}
