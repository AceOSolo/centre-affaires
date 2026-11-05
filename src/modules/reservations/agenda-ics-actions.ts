'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { requirePermission } from '../../lib/auth/staff.ts'
import { AGENDAS_PATH } from './agenda-ics.ts'
import { createFeeds, regenerateFeed, removeFeeds } from './agenda-ics-queries.ts'

/*
 * Liens d'agenda des ressources (ADR 071). Chaque action revérifie le droit :
 * une action serveur s'invoque par son identifiant, depuis n'importe quelle
 * page (ADR 008).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function resourceIds(formData: FormData): string[] {
  return formData
    .getAll('resourceId')
    .map(String)
    .filter((id) => UUID.test(id))
}

/** Crée le lien de la ressource choisie, ou de toutes celles envoyées. */
export async function createFeedsAction(formData: FormData): Promise<void> {
  const { member } = await requirePermission('agenda-google.gerer')
  const created = await createFeeds(resourceIds(formData), member.id)
  revalidatePath(AGENDAS_PATH)
  redirect(`${AGENDAS_PATH}?liens=crees&n=${created}`)
}

export async function regenerateFeedAction(formData: FormData): Promise<void> {
  const { member } = await requirePermission('agenda-google.gerer')
  const [id] = resourceIds(formData)
  const done = id ? await regenerateFeed(id, member.id) : false
  revalidatePath(AGENDAS_PATH)
  redirect(`${AGENDAS_PATH}?liens=${done ? 'regenere' : 'aucun'}`)
}

export async function removeFeedAction(formData: FormData): Promise<void> {
  await requirePermission('agenda-google.gerer')
  const removed = await removeFeeds(resourceIds(formData).slice(0, 1))
  revalidatePath(AGENDAS_PATH)
  redirect(`${AGENDAS_PATH}?liens=${removed ? 'desactive' : 'aucun'}`)
}
