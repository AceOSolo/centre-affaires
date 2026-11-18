import {
  DocumentIntegrityError,
  DocumentKeyError,
  openDocument,
} from '../../lib/chiffrement-documents.ts'
import { slugify } from '../../lib/slug.ts'
import { readObjectBytes } from '../../lib/stockage.ts'
import { documentExtensions } from './pieces-regles.ts'
import { logClientDocumentView, type DocumentToServe } from './pieces-queries.ts'

type Viewer =
  | { viewer: 'staff'; staffMemberId: string; authUserId: string }
  | { viewer: 'client'; clientMemberId: string; authUserId: string; clientId: string }

const refusalHeaders = {
  'Content-Type': 'text/plain; charset=utf-8',
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
}

/**
 * Renvoie une pièce justificative à qui a le droit de l'ouvrir — droit vérifié
 * par l'appelant, qui a trouvé `document` avec ses propres filtres.
 *
 * Même règle que pour les numérisations du courrier (`courrier/servir.ts`,
 * ADR 020) : le fichier est lu et déchiffré d'abord, la consultation
 * journalisée ensuite, et l'envoi n'a lieu que si le journal est écrit (RGPD :
 * une pièce d'identité ne s'ouvre pas sans trace). Une pièce altérée, ou
 * chiffrée avec une autre clé, est refusée.
 *
 * `read` est le stockage, passé en paramètre pour que la règle s'éprouve sans
 * stockage réel.
 */
export async function serveClientDocument(
  document: DocumentToServe,
  who: Viewer,
  read: (key: string) => Promise<Uint8Array> = readObjectBytes,
  log: typeof logClientDocumentView = logClientDocumentView,
): Promise<Response> {
  const stored = await read(document.storageKey)

  let plain: Uint8Array
  try {
    plain = openDocument(stored, document.encryptionKeyVersion, document.storageKey)
  } catch (error) {
    if (error instanceof DocumentIntegrityError || error instanceof DocumentKeyError) {
      console.error(`Pièce justificative ${document.id} refusée à la lecture`, error)
      const message =
        error instanceof DocumentKeyError
          ? 'Pièce momentanément illisible : la clé de déchiffrement des documents n’est pas configurée sur ce serveur.'
          : 'Pièce refusée : son contenu ne correspond pas à celui qui a été déposé. Elle n’a pas été affichée.'
      return new Response(message, { status: 500, headers: refusalHeaders })
    }
    throw error
  }

  await log({ ...who, documentId: document.id })

  const filename = `${slugify(document.kindLabel) || 'piece'}.${documentExtensions[document.contentType]}`
  return new Response(new Uint8Array(plain), {
    headers: {
      'Content-Type': document.contentType,
      'Content-Disposition': `inline; filename="${filename}"`,
      // Aucune copie gardée : chaque ouverture repasse par le contrôle et le journal.
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  })
}
