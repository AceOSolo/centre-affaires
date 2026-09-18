import type { ClientStatus } from './schema.ts'

/**
 * Libellés d'affichage. Séparés des valeurs stockées : celles-ci sont des
 * identifiants de base, elles ne changent pas quand le vocabulaire du centre
 * change.
 */
export const clientStatusLabels: Record<ClientStatus, string> = {
  prospect: 'Prospect',
  active: 'Client actif',
  inactive: 'Inactif',
}

export const clientStatusStyles: Record<ClientStatus, string> = {
  prospect: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300',
  active: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  inactive: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-400',
}

/** « 12 rue de la Paix, 75002 Paris » — adresse sur une ligne, sans trous. */
export function formatAddress(client: {
  addressLine1?: string | null
  addressLine2?: string | null
  postalCode?: string | null
  city?: string | null
  country?: string | null
}): string {
  const lieu = [client.postalCode, client.city].filter(Boolean).join(' ')
  return [
    client.addressLine1,
    client.addressLine2,
    lieu,
    client.country && client.country !== 'FR' ? client.country : null,
  ]
    .filter(Boolean)
    .join(', ')
}

/** « 123 456 789 00012 » — le SIRET se lit par groupes. */
export function formatSiret(siret: string | null | undefined): string {
  if (!siret) return '—'
  return siret.replace(/^(\d{3})(\d{3})(\d{3})(\d{5})$/, '$1 $2 $3 $4')
}
