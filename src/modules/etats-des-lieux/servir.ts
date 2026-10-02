import {
  DocumentIntegrityError,
  DocumentKeyError,
  openDocument,
} from '../../lib/chiffrement-documents.ts'
import { toIsoDate } from '../../lib/dates.ts'
import { readObjectBytes } from '../../lib/stockage.ts'
import { currentTimeZone } from '../../lib/tenant.ts'
import { photoExtensions } from './photos.ts'
import { logInspectionPhotoView, type PhotoToServe } from './queries.ts'

type Viewer =
  | { viewer: 'staff'; staffMemberId: string; authUserId: string }
  | { viewer: 'client'; clientMemberId: string; authUserId: string; clientId: string }

const refusalHeaders = {
  'Content-Type': 'text/plain; charset=utf-8',
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
}

/**
 * Renvoie une photo d'état des lieux à qui a le droit de la voir — droit
 * vérifié par l'appelant, qui a trouvé `photo` avec ses propres filtres.
 *
 * Même règle que pour les numérisations de courrier (`courrier/servir.ts`,
 * ADR 020) : le fichier est lu et déchiffré d'abord, la consultation
 * journalisée ensuite, et l'envoi n'a lieu que si le journal est écrit. Une
 * photo altérée, ou chiffrée avec une autre clé, est refusée.
 *
 * `read` est le stockage, passé en paramètre pour que la règle s'éprouve sans
 * stockage réel.
 */
export async function serveInspectionPhoto(
  photo: PhotoToServe,
  who: Viewer,
  read: (key: string) => Promise<Uint8Array> = readObjectBytes,
): Promise<Response> {
  const [stored, timeZone] = await Promise.all([read(photo.storageKey), currentTimeZone()])

  let image: Uint8Array
  try {
    image = openDocument(stored, photo.encryptionKeyVersion, photo.storageKey)
  } catch (error) {
    if (error instanceof DocumentIntegrityError || error instanceof DocumentKeyError) {
      console.error(`Photo d’état des lieux ${photo.id} refusée à la lecture`, error)
      const message =
        error instanceof DocumentKeyError
          ? 'Photo momentanément illisible : la clé de déchiffrement des documents n’est pas configurée sur ce serveur.'
          : 'Photo refusée : son contenu ne correspond pas à celui qui a été déposé. Elle n’a pas été affichée.'
      return new Response(message, { status: 500, headers: refusalHeaders })
    }
    throw error
  }

  await logInspectionPhotoView({ ...who, photoId: photo.id })

  const filename = `etat-des-lieux-${photo.kind === 'entry' ? 'entree' : 'sortie'}-${toIsoDate(
    photo.performedAt,
    timeZone,
  )}.${photoExtensions[photo.contentType]}`

  return new Response(new Uint8Array(image), {
    headers: {
      'Content-Type': photo.contentType,
      'Content-Disposition': `inline; filename="${filename}"`,
      // Aucune copie gardée : chaque affichage repasse par le contrôle et le journal.
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  })
}
