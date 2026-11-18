import { readObjectBytes } from '../../../../../lib/stockage.ts'
import { currentTenantId } from '../../../../../lib/tenant.ts'
import {
  emailLogoHeaders,
  emailLogoKey,
  parseEmailLogoFile,
} from '../../../../../modules/notifications/logo-courriels.ts'

const refusal = (status: number, message: string) =>
  new Response(message, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  })

/**
 * Logo des courriels (ADR 080), servi par l'application depuis le stockage
 * européen : les messageries le chargent à l'ouverture d'un courriel, sans
 * session. Hors du filtre `proxy.ts`, comme les médias des annonces.
 *
 * Un logo ne change jamais sous le même identifiant — en déposer un autre en
 * crée un nouveau — : la réponse se garde un an. Un logo remplacé reste servi
 * tant que son fichier existe, pour les courriels déjà reçus.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ fichier: string }> }) {
  const { fichier } = await params
  const file = parseEmailLogoFile(fichier)
  if (!file) return refusal(404, 'Logo introuvable.')

  let bytes: Uint8Array
  try {
    bytes = await readObjectBytes(emailLogoKey(currentTenantId(), file.id, file.contentType))
  } catch (error) {
    if ((error as { name?: string }).name === 'NoSuchKey') return refusal(404, 'Logo introuvable.')
    console.error(`Logo des courriels ${fichier} illisible`, error)
    return refusal(503, 'Logo momentanément indisponible.')
  }
  return new Response(new Uint8Array(bytes), { headers: emailLogoHeaders(file.contentType, bytes.byteLength) })
}
