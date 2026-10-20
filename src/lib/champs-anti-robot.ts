/**
 * Noms partagés par les formulaires sans compte (navigateur) et le serveur,
 * contre les robots (ADR 047). À part d'`anti-robot.ts` et de
 * `preuve-humaine.ts` : le navigateur n'a besoin que des noms, pas de Better
 * Auth ni du calcul des défis.
 */

/**
 * Champ piège : invisible, hors de la tabulation et masqué aux lecteurs
 * d'écran (`ChampPiege`, `modules/reservations/etapes-demande.tsx`). Une
 * personne ne le remplit jamais ; un robot qui remplit tous les champs, si.
 * Nom choisi pour ne pas attirer le remplissage automatique du navigateur.
 */
export const CHAMP_PIEGE = 'reference_interne'

export function champPiegeRempli(formData: FormData): boolean {
  return String(formData.get(CHAMP_PIEGE) ?? '').trim() !== ''
}

/** Champ où le widget ALTCHA dépose sa réponse (son nom par défaut). */
export const CHAMP_PREUVE = 'altcha'

/** En-tête qui porte cette réponse vers Better Auth, à l'inscription. */
export const EN_TETE_PREUVE = 'x-preuve-humaine'
