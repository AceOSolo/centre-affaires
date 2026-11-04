import { revalidatePath } from 'next/cache'

import { listContrats, receiveContrat } from './recevoir.ts'

/**
 * Contrats tenus par Dolibarr (ADR 066, `docs/integrations/dolibarr.md`) :
 *
 *   POST /api/dolibarr/contrats               un contrat créé, modifié, résilié ou supprimé
 *   GET  /api/dolibarr/contrats?rapproche=non  les contrats du site pas encore rapprochés
 *
 * Recevoir un contrat en cours pose l'occupation de sa ressource (ADR 018).
 * Jeton en `Authorization: Bearer …` (ADR 065). Sans jeton valide, 404 ; flux
 * « Contrats » coupé à l'écran, 403.
 */
export async function POST(request: Request) {
  const { response, changed } = await receiveContrat(request)
  // Fiches, planning, occupation, « Aujourd'hui », espace client.
  if (changed) revalidatePath('/', 'layout')
  return response
}

export async function GET(request: Request) {
  return listContrats(request)
}
