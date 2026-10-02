import { requirePermission } from '../../../../../lib/auth/staff.ts'
import { findPhotoForStaff } from '../../../../../modules/etats-des-lieux/queries.ts'
import { serveInspectionPhoto } from '../../../../../modules/etats-des-lieux/servir.ts'

/**
 * Consultation d'une photo d'état des lieux par l'équipe : déchiffrée et
 * journalisée, comme celle du client (ADR 039).
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ photoId: string }> },
) {
  // Une route ne passe pas par la coque du back-office : elle se protège seule.
  const { user, member } = await requirePermission('etats-des-lieux.gerer')
  const { photoId } = await params

  const photo = await findPhotoForStaff(photoId)
  if (!photo) return new Response('Photo introuvable.', { status: 404 })

  return serveInspectionPhoto(photo, { viewer: 'staff', staffMemberId: member.id, authUserId: user.id })
}
