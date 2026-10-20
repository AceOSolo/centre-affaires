import { creerCompteur, ipDuVisiteur } from '../../../lib/anti-robot.ts'
import { preuveHumaine } from '../../../lib/preuve-humaine.ts'

// Un défi neuf à chaque appel : jamais mis en cache.
export const dynamic = 'force-dynamic'

/**
 * Défis ALTCHA des formulaires sans compte (`lib/preuve-humaine.ts`, ADR 047),
 * demandés par le widget. Joignable sans session : c'est avant de s'inscrire
 * ou de déposer une demande qu'on en a besoin.
 *
 * Un défi coûte peu au serveur ; le plafond par adresse IP empêche seulement
 * d'en faire une source de charge. Une personne en demande un par formulaire,
 * un de plus à chaque expiration.
 */
const compteur = creerCompteur()
const PAR_ADRESSE_IP = { fenetreSecondes: 600, max: 30 }

export async function GET(request: Request) {
  const ip = ipDuVisiteur(request.headers) ?? 'inconnue'
  if (compteur.passer([[`defi|${ip}`, PAR_ADRESSE_IP]])) {
    return Response.json({ error: 'Trop de demandes.' }, { status: 429, headers: { 'Retry-After': '600' } })
  }
  return Response.json(await preuveHumaine().defi(), { headers: { 'Cache-Control': 'no-store' } })
}
