import {
  DocumentIntegrityError,
  DocumentKeyError,
  openDocument,
} from '../../lib/chiffrement-documents.ts'
import { toIsoDate } from '../../lib/dates.ts'
import { readObjectBytes } from '../../lib/stockage.ts'
import { currentTimeZone } from '../../lib/tenant.ts'
import { scanExtensions, type ScanContentType } from './fichiers.ts'
import { logScanView, type ScanToServe } from './queries.ts'

type Viewer =
  | { viewer: 'staff'; staffMemberId: string; authUserId: string }
  | { viewer: 'client'; clientMemberId: string; authUserId: string }

const refusalHeaders = {
  'Content-Type': 'text/plain; charset=utf-8',
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
}

/**
 * Refus explicite d'un document que l'on ne peut pas garantir : on ne rend ni
 * un fichier faux, ni le chiffré, ni une page d'erreur muette.
 */
function refuse(scan: ScanToServe, error: DocumentIntegrityError | DocumentKeyError): Response {
  // Pour l'exploitation : l'identifiant et la cause, jamais le contenu.
  console.error(`Numérisation ${scan.id} refusée à la lecture`, error)
  const message =
    error instanceof DocumentKeyError
      ? 'Document momentanément illisible : la clé de déchiffrement des documents n’est pas configurée sur ce serveur. Signalez-le au centre.'
      : 'Document refusé : son contenu ne correspond pas à celui qui a été déposé (altération, ou clé de chiffrement différente). Il n’a pas été affiché. Signalez-le au centre.'
  return new Response(message, { status: 500, headers: refusalHeaders })
}

/**
 * Renvoie une numérisation à qui a le droit de la lire — ce droit est vérifié
 * par l'appelant, qui a trouvé `scan` avec ses propres filtres.
 *
 * Le journal est écrit **avant** l'envoi, et son échec empêche l'envoi : une
 * consultation qui n'a pas pu être tracée n'a pas lieu (RGPD, `CLAUDE.md`).
 * Le fichier est lu et déchiffré d'abord (R22, ADR 020), pour ne pas
 * journaliser une consultation que le stockage n'aurait de toute façon pas pu
 * servir. Un document altéré, ou chiffré avec une autre clé, est refusé : GCM
 * l'authentifie en entier avant d'en rendre le moindre octet.
 *
 * `read` est le stockage, passé en paramètre pour que la règle s'éprouve sans
 * stockage réel.
 */
export async function serveScan(
  scan: ScanToServe,
  who: Viewer,
  read: (key: string) => Promise<Uint8Array> = readObjectBytes,
): Promise<Response> {
  const [stored, timeZone] = await Promise.all([read(scan.storageKey), currentTimeZone()])

  let document: Uint8Array
  try {
    document = openDocument(stored, scan.encryptionKeyVersion, scan.storageKey)
  } catch (error) {
    if (error instanceof DocumentIntegrityError || error instanceof DocumentKeyError) {
      return refuse(scan, error)
    }
    throw error
  }

  await logScanView({ ...who, mailScanId: scan.id })

  const contentType = scan.contentType as ScanContentType
  const filename = `courrier-${toIsoDate(scan.receivedAt, timeZone)}-${
    scan.side === 'envelope' ? 'enveloppe' : 'contenu'
  }.${scanExtensions[contentType]}`

  return new Response(new Uint8Array(document), {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `inline; filename="${filename}"`,
      // Ni le navigateur ni un proxy ne gardent de copie : la consultation
      // suivante repasse par le contrôle et par le journal.
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  })
}
