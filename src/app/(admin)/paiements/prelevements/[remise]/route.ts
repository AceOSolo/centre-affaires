import { requirePermission } from '../../../../../lib/auth/staff.ts'
import { RemittanceError, buildRemittanceFile } from '../../../../../modules/facturation/prelevements.ts'

/**
 * Fichier `pain.008` d'une remise, à déposer à la banque (R16, ADR 030).
 * Reconstruit à chaque téléchargement depuis les paiements de la remise ; il
 * contient les IBAN des débiteurs en clair, et n'est ni stocké ni mis en cache.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ remise: string }> }) {
  await requirePermission('paiements.gerer')
  const { remise } = await params
  let file
  try {
    file = await buildRemittanceFile(remise)
  } catch (error) {
    if (error instanceof RemittanceError) {
      return new Response(`Fichier impossible : ${error.problems.join(' ; ')}.`, {
        status: 409,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      })
    }
    throw error
  }
  if (!file) return new Response('Remise introuvable.', { status: 404 })

  return new Response(file.xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Content-Disposition': `attachment; filename="${file.fileName}"`,
      'Cache-Control': 'private, no-store',
    },
  })
}
