/**
 * Rubriques de l'espace client montrées à une entreprise.
 *
 * Huit onglets pour tout le monde, c'était quatre onglets vides pour qui loue
 * une salle de temps en temps. Une rubrique n'apparaît que si elle a quelque
 * chose à montrer ; la page reste joignable par son adresse, rien n'est
 * verrouillé — c'est la navigation qui se tait.
 *
 * Réservations est toujours là : c'est l'action qu'un client peut faire seul,
 * même le premier jour.
 */

export type SpaceSignals = {
  /** Contrat de domiciliation en cours, ou du courrier déjà reçu. */
  domiciliated: boolean
  invoices: number
  contracts: number
  inspections: number
}

export type SpaceSection = { href: string; label: string }

export function clientSections(signals: SpaceSignals): SpaceSection[] {
  return [
    { href: '/compte', label: 'Accueil', show: true },
    { href: '/compte/reservations', label: 'Réservations', show: true },
    { href: '/compte/courrier', label: 'Courrier', show: signals.domiciliated },
    { href: '/compte/factures', label: 'Factures', show: signals.invoices > 0 },
    { href: '/compte/contrats', label: 'Contrats', show: signals.contracts > 0 },
    { href: '/compte/etats-des-lieux', label: 'États des lieux', show: signals.inspections > 0 },
  ]
    .filter((section) => section.show)
    .map(({ href, label }) => ({ href, label }))
}

/** L'accueil ne s'allume que sur lui-même ; une rubrique, sur ses sous-pages aussi. */
export function isActiveSection(href: string, pathname: string): boolean {
  if (href === '/compte') return pathname === '/compte'
  return pathname === href || pathname.startsWith(`${href}/`)
}
