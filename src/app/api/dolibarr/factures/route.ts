import { revalidatePath } from 'next/cache'

import { receiveFacture } from './recevoir.ts'

/**
 * Factures émises par Dolibarr (ADR 081, `docs/integrations/dolibarr.md`) :
 *
 *   POST /api/dolibarr/factures   une facture ou un avoir validé, payé,
 *                                 abandonné, repassé en brouillon ou supprimé
 *
 * Le site en garde une copie de lecture pour l'espace client ; il ne facture
 * rien. Jeton en `Authorization: Bearer …` (ADR 065). Sans jeton valide, 404 ;
 * flux « Factures » coupé à l'écran, 403.
 */
export async function POST(request: Request) {
  const { response, changed } = await receiveFacture(request)
  if (changed) revalidatePath('/compte/factures')
  return response
}
