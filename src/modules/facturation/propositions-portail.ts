import { and, desc, eq, inArray } from 'drizzle-orm'

import { currentTenantId } from '../../lib/tenant.ts'
import { inClientSpace, type ClientAccount } from '../clients/comptes.ts'
import { proposals, type ProposalStatus } from './schema-devis.ts'

/**
 * Demandes de domiciliation en cours, vues depuis l'espace client (ADR 068).
 * Une domiciliation ne se réserve pas : sa demande n'est qu'un devis
 * (ADR 043), qu'aucune autre rubrique de l'espace ne montre. Le demandeur
 * qui crée son espace par le lien de l'accusé de réception l'y retrouve.
 *
 * Ni montant ni ligne : le devis se rédige au centre et part de Dolibarr.
 * Le filtre sur `client_id` est obligatoire : la base ne filtre pas les
 * lectures sous `inClientSpace` (ADR 019).
 */

/** Ouverte : pas encore signée, refusée ni annulée. */
const OPEN_STATUSES: readonly ProposalStatus[] = ['draft', 'ready', 'sent']

export type PortalDomiciliationRequest = {
  id: string
  number: string
  company: string | null
  status: ProposalStatus
  createdAt: Date
}

export async function listOpenDomiciliationRequests(
  accounts: readonly Pick<ClientAccount, 'clientId'>[],
): Promise<PortalDomiciliationRequest[]> {
  if (accounts.length === 0) return []
  return inClientSpace(accounts, (tx) =>
    tx
      .select({
        id: proposals.id,
        number: proposals.number,
        company: proposals.requesterCompany,
        status: proposals.status,
        createdAt: proposals.createdAt,
      })
      .from(proposals)
      .where(
        and(
          eq(proposals.tenantId, currentTenantId()),
          inArray(
            proposals.clientId,
            accounts.map((account) => account.clientId),
          ),
          eq(proposals.product, 'domiciliation'),
          inArray(proposals.status, [...OPEN_STATUSES]),
        ),
      )
      .orderBy(desc(proposals.createdAt))
      .limit(5),
  )
}

/** Où en est la demande, en texte : jamais la seule couleur. */
export function domiciliationRequestStatusLabel(status: ProposalStatus): string {
  return status === 'sent' ? 'Devis envoyé par courriel' : 'En cours d’étude par le centre'
}
