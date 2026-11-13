'use server'

import { revalidatePath } from 'next/cache'

import { requirePermission } from '../../lib/auth/staff.ts'
import { deleteObject, putObject } from '../../lib/stockage.ts'
import { currentTenantId } from '../../lib/tenant.ts'
import { isUuid, uuidv7 } from '../../lib/uuid.ts'
import {
  describeListingMedia,
  listingMediaKey,
  MAX_LISTING_MEDIA,
  moveListingMedia,
  readListingMedia,
  withoutListingMedia,
  type MediaMove,
} from './annonces-medias.ts'
import { changeListingMedia, findListingMediaForServing } from './annonces-queries.ts'

/**
 * Photos et vidéos d'une annonce (ADR 073). Chaque action vérifie le droit
 * elle-même : une action serveur s'invoque par son identifiant depuis
 * n'importe quel chemin (ADR 008).
 */
export type MediaResult = { error?: string }

const LIMIT_MESSAGE = `Une annonce montre au plus ${MAX_LISTING_MEDIA} photos et vidéos. Retirez-en une avant d’en ajouter.`
const NOT_FOUND = { error: 'Annonce introuvable : elle a peut-être été retirée. Rechargez la page.' }

function revalidate(slug: string): void {
  revalidatePath('/ressources/annonces', 'layout')
  revalidatePath('/annonces')
  revalidatePath(`/annonces/${slug}`)
}

/** Un fichier par appel : une connexion qui flanche ne perd que celui en cours. */
export async function uploadListingMediaAction(formData: FormData): Promise<MediaResult> {
  await requirePermission('ressources.gerer')
  const listingId = String(formData.get('listingId') ?? '')
  if (!isUuid(listingId)) return NOT_FOUND

  const { media: file, error } = await readListingMedia(formData.get('fichier'))
  if (!file) return { error: error ?? 'Aucun fichier reçu.' }

  // Vérifié avant le dépôt : inutile d'envoyer au stockage un fichier refusé.
  const current = await findListingMediaForServing(listingId)
  if (!current) return NOT_FOUND
  if (current.media.length >= MAX_LISTING_MEDIA) return { error: LIMIT_MESSAGE }

  const id = uuidv7()
  const key = listingMediaKey(currentTenantId(), listingId, id, file.contentType)
  try {
    await putObject(key, file.bytes, file.contentType)
  } catch (cause) {
    console.error(`Média d’annonce ${listingId} non déposé`, cause)
    return { error: 'Le stockage des fichiers ne répond pas. Réessayez dans un instant.' }
  }

  // Revérifié sous verrou : deux envois simultanés ne dépassent pas la limite.
  let full = false
  const result = await changeListingMedia(listingId, (list) => {
    if (list.length >= MAX_LISTING_MEDIA) {
      full = true
      return list
    }
    return [
      ...list,
      {
        id,
        kind: file.kind,
        contentType: file.contentType,
        key,
        byteSize: file.bytes.byteLength,
        width: file.width,
        height: file.height,
        alt: null,
      },
    ]
  })
  if (!result || full) {
    await deleteObject(key).catch((cause) => console.error(`Média ${key} orphelin`, cause))
    return result ? { error: LIMIT_MESSAGE } : NOT_FOUND
  }

  revalidate(result.slug)
  return {}
}

/**
 * Retire un média. La ligne d'abord, le fichier ensuite : un fichier qui
 * resterait dans le stockage ne se voit plus nulle part, alors qu'une ligne
 * sans fichier casserait la galerie.
 *
 * Pas de `deleted_at` ici : une photo de vitrine n'a pas de valeur probante
 * (décision 6, ADR 073).
 */
export async function removeListingMediaAction(listingId: string, mediaId: string): Promise<MediaResult> {
  await requirePermission('ressources.gerer')
  if (!isUuid(listingId)) return NOT_FOUND

  const result = await changeListingMedia(listingId, (list) => withoutListingMedia(list, mediaId))
  if (!result) return NOT_FOUND
  const removed = result.before.find((media) => media.id === mediaId)
  if (removed) {
    await deleteObject(removed.key).catch((cause) =>
      console.error(`Média ${removed.key} retiré de l’annonce mais pas du stockage`, cause),
    )
  }
  revalidate(result.slug)
  return {}
}

const moves: readonly MediaMove[] = ['first', 'earlier', 'later']

export async function moveListingMediaAction(
  listingId: string,
  mediaId: string,
  move: MediaMove,
): Promise<MediaResult> {
  await requirePermission('ressources.gerer')
  if (!isUuid(listingId) || !moves.includes(move)) return NOT_FOUND

  const result = await changeListingMedia(listingId, (list) => moveListingMedia(list, mediaId, move))
  if (!result) return NOT_FOUND
  revalidate(result.slug)
  return {}
}

export async function describeListingMediaAction(
  listingId: string,
  mediaId: string,
  alt: string,
): Promise<MediaResult> {
  await requirePermission('ressources.gerer')
  if (!isUuid(listingId)) return NOT_FOUND

  const result = await changeListingMedia(listingId, (list) =>
    describeListingMedia(list, mediaId, String(alt ?? '')),
  )
  if (!result) return NOT_FOUND
  revalidate(result.slug)
  return {}
}
