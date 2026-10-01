'use server'

import { revalidatePath } from 'next/cache'

import { PG_UNIQUE_VIOLATION, pgErrorCode } from '../../db/errors.ts'
import { requirePermission } from '../../lib/auth/staff.ts'

import { listBookableResources } from './queries.ts'
import {
  addClosure,
  addOpeningHour,
  copierHorairesDuCentre,
  removeClosure,
  removeOpeningHour,
  replaceOpeningHours,
} from './ouverture-queries.ts'

export type FormState = { error?: string } | null

function text(formData: FormData, key: string): string {
  return String(formData.get(key) ?? '').trim()
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const WALL_TIME = /^([01]\d|2[0-4]):[0-5]\d$/

/** Les écrans touchés par un changement d'horaire. */
function revalidateAvailability(): void {
  revalidatePath('/disponibilites')
  revalidatePath('/reservations')
  // Le site public annonce des créneaux : il ment dès que les horaires changent.
  revalidatePath('/')
}

export async function addOpeningHourAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  // Contrôle d'accès dans l'action elle-même : une action serveur s'invoque par
  // son identifiant depuis n'importe quel chemin (ADR 008).
  await requirePermission('horaires.gerer')

  const weekday = Number(text(formData, 'weekday'))
  const opensAt = text(formData, 'opensAt')
  const closesAt = text(formData, 'closesAt')

  if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) {
    return { error: 'Jour de la semaine inconnu.' }
  }
  if (!WALL_TIME.test(opensAt) || !WALL_TIME.test(closesAt)) {
    return { error: 'Horaires illisibles. Exemple : 09:00' }
  }
  if (closesAt <= opensAt) {
    return { error: "L'heure de fermeture doit suivre l'heure d'ouverture." }
  }

  try {
    await addOpeningHour({
      resourceId: text(formData, 'resourceId') || null,
      weekday,
      opensAt,
      closesAt,
    })
  } catch (error) {
    // L'unicité est tenue par un index partiel : deux plages identiques le même
    // jour sont une saisie en double, pas une intention.
    if (pgErrorCode(error) === PG_UNIQUE_VIOLATION) {
      return { error: 'Cette plage existe déjà pour ce jour.' }
    }
    throw error
  }

  revalidateAvailability()
  return null
}

export async function removeOpeningHourAction(formData: FormData): Promise<void> {
  await requirePermission('horaires.gerer')
  const id = text(formData, 'id')
  if (!id) return
  await removeOpeningHour(id)
  revalidateAvailability()
}

/**
 * Applique la semaine type d'un coup : mêmes horaires du lundi au vendredi.
 *
 * C'est la saisie de très loin la plus fréquente, et la faire ligne par ligne
 * invite à en oublier une — un jour ouvré manquant ferme le centre en silence.
 */
export async function setWeekdayHoursAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  await requirePermission('horaires.gerer')

  const opensAt = text(formData, 'opensAt')
  const closesAt = text(formData, 'closesAt')
  if (!WALL_TIME.test(opensAt) || !WALL_TIME.test(closesAt)) {
    return { error: 'Horaires illisibles. Exemple : 09:00' }
  }
  if (closesAt <= opensAt) {
    return { error: "L'heure de fermeture doit suivre l'heure d'ouverture." }
  }

  const jours = [1, 2, 3, 4, 5].filter((jour) => formData.get(`jour-${jour}`) === 'on')
  if (jours.length === 0) {
    return { error: 'Cocher au moins un jour.' }
  }

  await replaceOpeningHours(
    text(formData, 'resourceId') || null,
    jours.map((weekday) => ({ weekday, opensAt, closesAt })),
  )
  revalidateAvailability()
  return null
}

export async function addClosureAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  await requirePermission('horaires.gerer')

  const startsOn = text(formData, 'startsOn')
  const endsOn = text(formData, 'endsOn') || startsOn

  if (!ISO_DATE.test(startsOn)) return { error: 'Date de début illisible.' }
  if (!ISO_DATE.test(endsOn)) return { error: 'Date de fin illisible.' }
  if (endsOn < startsOn) return { error: 'La date de fin doit suivre la date de début.' }

  await addClosure({
    resourceId: text(formData, 'resourceId') || null,
    startsOn,
    endsOn,
    reason: text(formData, 'reason') || null,
  })
  revalidateAvailability()
  return null
}

export async function removeClosureAction(formData: FormData): Promise<void> {
  await requirePermission('horaires.gerer')
  const id = text(formData, 'id')
  if (!id) return
  await removeClosure(id)
  revalidateAvailability()
}

/**
 * Bascule toutes les ressources en service sur leurs horaires propres (ADR 012).
 *
 * Reprise des ressources déclarées avant cette décision : celles créées depuis
 * reçoivent leurs horaires dès la déclaration. L'action est rejouable et
 * n'écrase jamais une saisie existante.
 */
export async function copierHorairesDuCentreAction(): Promise<FormState> {
  await requirePermission('horaires.gerer')

  const resources = await listBookableResources()
  if (resources.length === 0) {
    return { error: 'Aucune ressource en service à basculer.' }
  }

  const dotees = await copierHorairesDuCentre(resources.map((resource) => resource.id))
  if (dotees === 0) {
    return { error: 'Rien à reprendre : chaque ressource a déjà ses horaires.' }
  }

  revalidateAvailability()
  return null
}
