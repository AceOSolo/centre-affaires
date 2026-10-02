import type { ExpiredClientsReport, RemovedMembersReport } from './anonymisation.ts'

/**
 * Ligne du journal de la tâche de nuit pour l'anonymisation (R29, ADR 040).
 *
 * Faite de nombres seulement : le journal de l'application ne doit pas
 * devenir une copie de ce qu'on vient d'effacer — ni nom, ni adresse, ni
 * identifiant qui permette de retrouver la personne dans une sauvegarde.
 */
export function anonymizationLogLine(
  clients: ExpiredClientsReport,
  members: RemovedMembersReport,
): string {
  const companies = plural(clients.clients, 'entreprise anonymisée', 'entreprises anonymisées')
  const detail = [
    plural(clients.contacts, 'contact', 'contacts'),
    plural(clients.accesses, 'accès', 'accès'),
    plural(clients.mailSenders, 'pli', 'plis'),
  ].join(', ')
  return (
    `Conservation (RGPD) : ${companies} (${detail}) ; ` +
    `${plural(members.accesses, 'accès retiré anonymisé', 'accès retirés anonymisés')}, ` +
    `${plural(members.staff, 'membre retiré de l’équipe anonymisé', 'membres retirés de l’équipe anonymisés')}.`
  )
}

function plural(value: number, singular: string, pluralForm: string): string {
  // En français, 0 et 1 prennent le singulier.
  return `${value} ${value > 1 ? pluralForm : singular}`
}
