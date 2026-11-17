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
 *
 * Une rubrique s'ajoute par une ligne de `clientSections`, dans l'ordre
 * d'usage (règle des lots de la recette du 17/11).
 */

export type SpaceSignals = {
  /** Contrat de domiciliation en cours, ou du courrier déjà reçu. */
  domiciliated: boolean
  invoices: number
  contracts: number
  inspections: number
  /** Plis non lus par la personne : la pastille de l'onglet « Courrier » (ADR 077). */
  unreadMail?: number
}

export type SpaceSection = {
  href: string
  label: string
  /**
   * Nombre de nouveautés de la rubrique, dit sur l'onglet : les plis non lus
   * du courrier (ADR 077). Absent : la rubrique n'a pas de pastille.
   */
  unread?: number
}

export function clientSections(signals: SpaceSignals): SpaceSection[] {
  const sections: (SpaceSection & { show: boolean })[] = [
    { href: '/compte', label: 'Accueil', show: true },
    { href: '/compte/reservations', label: 'Réservations', show: true },
    { href: '/compte/courrier', label: 'Courrier', show: signals.domiciliated, unread: signals.unreadMail ?? 0 },
    { href: '/compte/factures', label: 'Factures', show: signals.invoices > 0 },
    { href: '/compte/contrats', label: 'Contrats', show: signals.contracts > 0 },
    { href: '/compte/etats-des-lieux', label: 'États des lieux', show: signals.inspections > 0 },
  ]
  return sections.filter((section) => section.show).map(({ show: _show, ...section }) => section)
}

/** L'accueil ne s'allume que sur lui-même ; une rubrique, sur ses sous-pages aussi. */
export function isActiveSection(href: string, pathname: string): boolean {
  if (href === '/compte') return pathname === '/compte'
  return pathname === href || pathname.startsWith(`${href}/`)
}

/** Ce que la pastille d'une rubrique affiche : rien à zéro, « 99+ » au-delà de 99. */
export function sectionBadge(count: number | undefined): string | null {
  if (!count || count <= 0) return null
  return count > 99 ? '99+' : String(count)
}
