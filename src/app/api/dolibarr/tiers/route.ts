import { revalidatePath } from 'next/cache'

import { listTiers, receiveTiers } from './recevoir.ts'

/**
 * Tiers tenus par Dolibarr (ADR 066, `docs/integrations/dolibarr.md`) :
 *
 *   POST /api/dolibarr/tiers              un tiers créé, modifié, fermé ou supprimé
 *   GET  /api/dolibarr/tiers?rapproche=non les fiches du site pas encore rapprochées
 *
 * Jeton en `Authorization: Bearer …` (ADR 065). Sans jeton valide, 404 ; flux
 * « Tiers » coupé à l'écran, 403.
 */
export async function POST(request: Request) {
  const { response, changed } = await receiveTiers(request)
  // Fiches, listes et sélecteurs de client : partout dans le back-office.
  if (changed) revalidatePath('/', 'layout')
  return response
}

export async function GET(request: Request) {
  return listTiers(request)
}
