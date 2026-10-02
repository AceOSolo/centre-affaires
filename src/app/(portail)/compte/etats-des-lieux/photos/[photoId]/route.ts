import { requireClientAccount } from '../../../../../../modules/clients/session.ts'
import { findPhotoForAccounts } from '../../../../../../modules/etats-des-lieux/queries.ts'
import { serveInspectionPhoto } from '../../../../../../modules/etats-des-lieux/servir.ts'

/**
 * Consultation d'une photo d'état des lieux depuis l'espace client : celles
 * des états des lieux clos de ses entreprises seulement, journalisée au nom de
 * la personne. Même réponse pour « n'existe pas » et « pas à vous ».
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ photoId: string }> },
) {
  const { user, accounts } = await requireClientAccount()
  const { photoId } = await params

  const photo = await findPhotoForAccounts(photoId, accounts)
  if (!photo) return new Response('Photo introuvable.', { status: 404 })

  const account = accounts.find((candidate) => candidate.clientId === photo.clientId)
  if (!account) return new Response('Photo introuvable.', { status: 404 })

  return serveInspectionPhoto(photo, {
    viewer: 'client',
    clientMemberId: account.memberId,
    authUserId: user.id,
    clientId: account.clientId,
  })
}
