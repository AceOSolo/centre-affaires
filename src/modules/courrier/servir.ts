import { toIsoDate } from '../../lib/dates.ts'
import { readObject } from '../../lib/stockage.ts'
import { currentTimeZone } from '../../lib/tenant.ts'
import { scanExtensions, type ScanContentType } from './fichiers.ts'
import { logScanView, type ScanToServe } from './queries.ts'

type Viewer =
  | { viewer: 'staff'; staffMemberId: string; authUserId: string }
  | { viewer: 'client'; clientMemberId: string; authUserId: string; clientId: string }

/**
 * Renvoie une numérisation à qui a le droit de la lire — ce droit est vérifié
 * par l'appelant, qui a trouvé `scan` avec ses propres filtres.
 *
 * Le journal est écrit **avant** l'envoi, et son échec empêche l'envoi : une
 * consultation qui n'a pas pu être tracée n'a pas lieu (RGPD, `CLAUDE.md`).
 * Le fichier est lu d'abord, pour ne pas journaliser une consultation que le
 * stockage n'aurait de toute façon pas pu servir.
 */
export async function serveScan(scan: ScanToServe, who: Viewer): Promise<Response> {
  const [body, timeZone] = await Promise.all([readObject(scan.storageKey), currentTimeZone()])
  try {
    await logScanView({ ...who, mailScanId: scan.id })
  } catch (error) {
    await body.cancel()
    throw error
  }

  const contentType = scan.contentType as ScanContentType
  const filename = `courrier-${toIsoDate(scan.receivedAt, timeZone)}-${
    scan.side === 'envelope' ? 'enveloppe' : 'contenu'
  }.${scanExtensions[contentType]}`

  return new Response(body, {
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
