/**
 * Champ piège contre les robots des formulaires sans compte (voir
 * `anti-robot.ts`) : invisible, hors de la tabulation et masqué aux lecteurs
 * d'écran (`ChampPiege`, `modules/reservations/etapes-demande.tsx`). Une
 * personne ne le remplit jamais ; un robot qui remplit tous les champs, si.
 * Nom choisi pour ne pas attirer le remplissage automatique du navigateur.
 *
 * À part d'`anti-robot.ts` : le formulaire, côté navigateur, n'a besoin que du
 * nom du champ, pas de Better Auth.
 */
export const CHAMP_PIEGE = 'reference_interne'

export function champPiegeRempli(formData: FormData): boolean {
  return String(formData.get(CHAMP_PIEGE) ?? '').trim() !== ''
}
