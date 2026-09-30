import { requireClientAccount } from '../../../../../modules/clients/session.ts'
import { findScanForAccounts } from '../../../../../modules/courrier/queries.ts'
import { serveScan } from '../../../../../modules/courrier/servir.ts'

/**
 * Consultation d'une numérisation depuis l'espace client.
 *
 * Même réponse pour « n'existe pas » et « pas à vous » : distinguer les deux
 * renseignerait sur le courrier des autres entreprises.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ scanId: string }> },
) {
  const { user, accounts } = await requireClientAccount()
  const { scanId } = await params

  const scan = await findScanForAccounts(scanId, accounts)
  if (!scan) return new Response('Numérisation introuvable.', { status: 404 })

  // Le journal nomme la personne au titre de l'entreprise destinataire.
  const account = accounts.find((candidate) => candidate.clientId === scan.clientId)
  if (!account) return new Response('Numérisation introuvable.', { status: 404 })

  return serveScan(scan, { viewer: 'client', clientMemberId: account.memberId, authUserId: user.id })
}
