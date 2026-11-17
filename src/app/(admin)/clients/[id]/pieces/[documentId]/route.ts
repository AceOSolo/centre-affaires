import { requirePermission } from '../../../../../../lib/auth/staff.ts'
import { findDocumentForStaff } from '../../../../../../modules/clients/pieces-queries.ts'
import { serveClientDocument } from '../../../../../../modules/clients/pieces-servir.ts'

/**
 * Une pièce justificative ouverte par l'équipe (ADR 075) : déchiffrée et
 * journalisée au nom du membre, comme les numérisations du courrier. Une
 * route ne passe pas par la coque du back-office : elle se protège seule.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; documentId: string }> },
) {
  const { user, member } = await requirePermission('pieces.valider')
  const { id, documentId } = await params

  const document = await findDocumentForStaff(documentId, id)
  if (!document) return new Response('Pièce introuvable.', { status: 404 })

  return serveClientDocument(document, { viewer: 'staff', staffMemberId: member.id, authUserId: user.id })
}
