import type { ResourceStatus, ResourceType } from './schema.ts'

/**
 * Libellés d'affichage. Séparés des valeurs stockées : celles-ci sont des
 * identifiants de base, elles ne changent pas quand le vocabulaire du centre
 * change.
 */
export const resourceTypeLabels: Record<ResourceType, string> = {
  salle: 'Salle de réunion',
  bureau: 'Bureau',
  casier: 'Casier',
  vehicule: 'Véhicule',
  boite_aux_lettres: 'Boîte aux lettres',
}

export const resourceStatusLabels: Record<ResourceStatus, string> = {
  active: 'En service',
  maintenance: 'En maintenance',
  retired: 'Retirée du parc',
}

/**
 * La maintenance est le seul état qui sort des bleus : une ressource
 * indisponible est une alerte de fonctionnement, cas que la charte autorise
 * pour l'UI state. Retirée et en service restent sur la palette.
 */
export const resourceStatusStyles: Record<ResourceStatus, string> = {
  active: 'bg-primary text-primary-foreground',
  maintenance: 'bg-warning/15 text-warning-foreground',
  retired: 'bg-muted text-muted-foreground',
}

/** Rend les champs JSONB lisibles sans connaître le type à l'avance. */
export function describeAttributes(attributes: Record<string, unknown>): string {
  const labels: Record<string, (value: unknown) => string> = {
    superficieM2: (value) => `${value} m²`,
    postes: (value) => `${value} poste${Number(value) > 1 ? 's' : ''}`,
    taille: (value) => `taille ${value}`,
    immatriculation: (value) => String(value),
    kilometrage: (value) => `${Number(value).toLocaleString('fr-FR')} km`,
    places: (value) => `${value} place${Number(value) > 1 ? 's' : ''}`,
    equipements: (value) => (Array.isArray(value) ? value.join(', ') : String(value)),
  }

  return Object.entries(attributes)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .filter(([, value]) => !(Array.isArray(value) && value.length === 0))
    .map(([key, value]) => labels[key]?.(value) ?? `${key} : ${String(value)}`)
    .join(' · ')
}

/** Jours de la semaine, en numérotation ISO : 1 = lundi … 7 = dimanche. */
export const weekdayLabels: Record<number, string> = {
  1: 'Lundi',
  2: 'Mardi',
  3: 'Mercredi',
  4: 'Jeudi',
  5: 'Vendredi',
  6: 'Samedi',
  7: 'Dimanche',
}

export const weekdays = [1, 2, 3, 4, 5, 6, 7] as const

/** « 09:00 » — les heures sont stockées en `time`, donc « 09:00:00 ». */
export function formatWallTime(time: string): string {
  return time.slice(0, 5)
}
