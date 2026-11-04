/**
 * Rayons pliés du menu du back-office (ADR 064), sans rendu : `nav.tsx`
 * l'affiche, `nav-plie.test.ts` vérifie les règles.
 *
 * Le pliage est tiré des données de `menu.ts`, sans liste de rayons écrite
 * ici : un rayon ajouté au menu se plie comme les autres.
 */

/**
 * Rayons pliés, retenus par navigateur. Un cookie et non le stockage local :
 * le serveur le lit au rendu, la barre latérale arrive déjà pliée, sans saut
 * de mise en page au chargement.
 */
export const FOLDED_COOKIE = 'menu_plie'
/** Un an : c'est une préférence d'affichage, pas une session. */
export const FOLDED_COOKIE_MAX_AGE = 365 * 24 * 60 * 60

/** Une clé : minuscules, chiffres et tirets, ce qu'un cookie porte sans encodage. */
const KEY = /^[a-z0-9-]{1,40}$/
/** Plus de rayons que le menu n'en aura jamais : un cookie bricolé ne grossit pas. */
const MAX_KEYS = 20

type Group = { label: string; entries: readonly { label: string }[] }

/**
 * Un groupe qui porte le nom de sa première entrée (« Aujourd’hui »,
 * « Réglages ») n'a pas de titre visible, donc rien sur quoi cliquer : il ne
 * se plie pas. « Aujourd’hui » et « Demandes » restent ainsi toujours à
 * l'écran, et « Réglages », seul lien de son groupe, ne serait pas plus court
 * plié.
 *
 * Lu sur le groupe tel que `menu.ts` le déclare, pas sur ce qu'un rôle en
 * voit : un rôle sans « Aujourd’hui » ne doit pas pouvoir plier « Demandes ».
 */
export function isFoldable(group: Group): boolean {
  return group.entries[0]?.label !== group.label
}

/** Clé d'un groupe dans le cookie : son libellé sans accents ni espaces (« tous-les-services »). */
export function groupKey(label: string): string {
  return label
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Rayons pliés lus dans le cookie. Ce qui n'est pas une clé est ignoré, sans erreur. */
export function parseFolded(value: string | undefined): string[] {
  if (!value) return []
  return [...new Set(value.split('.').filter((key) => KEY.test(key)))].sort().slice(0, MAX_KEYS)
}

/** Valeur du cookie, la même pour le même ensemble : le serveur et le navigateur la comparent. */
export function serializeFolded(keys: readonly string[]): string {
  return parseFolded(keys.join('.')).join('.')
}

/** Rayons pliés après un clic sur le titre d'un rayon, ouvert (`open`) ou plié. */
export function toggleFolded(folded: readonly string[], key: string, open: boolean): string[] {
  return open ? parseFolded([...folded, key].join('.')) : folded.filter((candidate) => candidate !== key)
}

/**
 * Un rayon est ouvert s'il ne se plie pas, s'il n'est pas plié, ou s'il
 * contient la page en cours (`active`) : on ne perd jamais de vue où l'on est.
 * Ce dernier reste pliable à la main ; plié sur cette page (`dismissed`), il
 * se rouvre à la page suivante du même rayon.
 */
export function isGroupOpen(
  group: { key: string; foldable: boolean },
  { folded, active, dismissed }: { folded: readonly string[]; active?: string; dismissed?: string },
): boolean {
  if (!group.foldable) return true
  if (group.key === active && group.key !== dismissed) return true
  return !folded.includes(group.key)
}
