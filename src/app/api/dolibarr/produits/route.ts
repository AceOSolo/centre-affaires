import { revalidatePath } from 'next/cache'

import { receiveDolibarrProduct } from './recevoir.ts'

/**
 * Produits envoyés par le module Webhook de Dolibarr (ADR 049,
 * `docs/integrations/dolibarr-produits.md`) :
 *
 *   POST /api/dolibarr/produits?jeton=<jeton>
 *   { "triggercode": "PRODUCT_MODIFY", "object": { "ref": "courrier.ouverture", … } }
 *
 * Le jeton — celui de l'écran « Connexion au CRM », ou `DOLIBARR_API_TOKEN`
 * tant qu'aucun n'y est réglé (ADR 065) — passe dans l'adresse, le module ne
 * sachant poser aucun en-tête ; `Authorization: Bearer …` est accepté aussi.
 * Sans jeton valide, la route n'existe pas (404).
 *
 * 200 quand le produit est pris en compte ou n'a rien à faire sur le site,
 * 400 quand le site le refuse (référence, prix ou TVA illisible, grille par
 * défaut ou ressource absente), avec un message qui dit quoi corriger. Détail
 * et journal du serveur : `recevoir.ts`.
 */
export async function POST(request: Request) {
  const { response, changed } = await receiveDolibarrProduct(request)
  // Les prix et les services se lisent partout : back-office, réservation en
  // ligne, demandes de devis.
  if (changed) revalidatePath('/', 'layout')
  return response
}
