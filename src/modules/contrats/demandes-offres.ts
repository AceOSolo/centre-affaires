import { and, eq } from 'drizzle-orm'

import type { Transaction } from '../../db/index.ts'
import { offerRequests } from './schema.ts'

/**
 * Le contrat tiré d'une offre pour un client clôt sa demande à traiter, s'il
 * y en a une : dans la transaction qui crée le contrat (`createContractFromOffer`).
 */
export async function settleOfferRequests(
  tx: Transaction,
  contract: { id: string; clientId: string; offerId: string },
  staffMemberId: string | null,
): Promise<void> {
  await tx
    .update(offerRequests)
    .set({ status: 'contracted', contractId: contract.id, closedByStaffId: staffMemberId })
    .where(
      and(
        eq(offerRequests.clientId, contract.clientId),
        eq(offerRequests.offerId, contract.offerId),
        eq(offerRequests.status, 'requested'),
      ),
    )
}
