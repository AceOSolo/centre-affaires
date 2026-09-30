import { requireStaff } from '../../../../../lib/auth/staff.ts'
import { findScanForStaff } from '../../../../../modules/courrier/queries.ts'
import { serveScan } from '../../../../../modules/courrier/servir.ts'

/**
 * Consultation d'une numérisation par l'équipe. Journalisée comme celle du
 * client : le journal d'accès vaut pour tout le monde, le centre compris.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ scanId: string }> },
) {
  // Une route ne passe pas par la coque du back-office : elle se protège seule.
  const { user, member } = await requireStaff()
  const { scanId } = await params

  const scan = await findScanForStaff(scanId)
  if (!scan) return new Response('Numérisation introuvable.', { status: 404 })

  return serveScan(scan, { viewer: 'staff', staffMemberId: member.id, authUserId: user.id })
}
