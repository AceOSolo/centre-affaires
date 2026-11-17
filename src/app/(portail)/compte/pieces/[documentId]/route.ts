import { findDocumentForAccounts } from '../../../../../modules/clients/pieces-queries.ts'
import { serveClientDocument } from '../../../../../modules/clients/pieces-servir.ts'
import { requireClientAccount } from '../../../../../modules/clients/session.ts'

/**
 * Une pièce justificative ouverte depuis l'espace client (ADR 075) : celles
 * des entreprises du compte seulement, déchiffrée et journalisée au nom de la
 * personne. Même réponse pour « n'existe pas » et « pas à vous ».
 */
export async function GET(_request: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { user, accounts } = await requireClientAccount()
  const { documentId } = await params

  const document = await findDocumentForAccounts(documentId, accounts)
  const account = document && accounts.find((candidate) => candidate.clientId === document.clientId)
  if (!document || !account) return new Response('Pièce introuvable.', { status: 404 })

  return serveClientDocument(document, {
    viewer: 'client',
    clientMemberId: account.memberId,
    authUserId: user.id,
    clientId: account.clientId,
  })
}
