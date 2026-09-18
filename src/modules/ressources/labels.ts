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

export const resourceStatusStyles: Record<ResourceStatus, string> = {
  active: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  maintenance: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  retired: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-400',
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
