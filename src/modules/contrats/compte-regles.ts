import { lastContractDay, type ContractPeriod } from './occupation.ts'
import type { ContractStatus } from './schema.ts'

/**
 * Un contrat vu depuis l'espace client (R17) : où il en est, dit en toutes
 * lettres. Le statut de la base (`draft`, `active`, `terminated`) ne dit pas
 * tout au client : un contrat « en cours » dont le terme est passé est arrivé
 * à terme, un contrat résilié court jusqu'à la fin de son préavis.
 *
 * Fonction pure, éprouvée seule.
 */

/**
 * - `upcoming` : signé, pas encore commencé ;
 * - `active` : en cours ;
 * - `ending` : résilié, mais court encore jusqu'à son dernier jour ;
 * - `ended` : arrivé à son terme ;
 * - `terminated` : résilié, terminé.
 */
export type ClientContractTone = 'upcoming' | 'active' | 'ending' | 'ended' | 'terminated'

export type ClientContractState = { tone: ClientContractTone; label: string }

/**
 * État d'un contrat au jour `today` du centre (`YYYY-MM-DD`). Les bornes sont
 * des jours de calendrier comprises, comme en base : un contrat dont le dernier
 * jour est aujourd'hui est encore en cours.
 *
 * Un brouillon n'atteint jamais l'espace client (filtre des requêtes) : il
 * n'engage rien et n'a pas de document.
 */
export function clientContractState(
  contract: ContractPeriod & { status: Exclude<ContractStatus, 'draft'> },
  today: string,
): ClientContractState {
  const lastDay = lastContractDay(contract)
  const over = lastDay !== null && lastDay < today
  if (contract.status === 'terminated') {
    if (over || (lastDay !== null && lastDay < contract.startsOn)) {
      return { tone: 'terminated', label: 'Résilié' }
    }
    return { tone: 'ending', label: 'Résilié, en cours jusqu’à son terme' }
  }
  if (over) return { tone: 'ended', label: 'Arrivé à terme' }
  if (contract.startsOn > today) return { tone: 'upcoming', label: 'À venir' }
  return { tone: 'active', label: 'En cours' }
}

/** Mêmes bleus que les réservations : provisoire, en vigueur, éteint. */
export const clientContractToneStyles: Record<ClientContractTone, string> = {
  upcoming: 'bg-accent/15 text-primary',
  active: 'bg-primary text-primary-foreground',
  ending: 'border border-primary bg-white text-primary',
  ended: 'bg-muted text-muted-foreground',
  terminated: 'bg-muted text-muted-foreground',
}
