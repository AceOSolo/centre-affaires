'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

import type { Permission } from '../../lib/auth/permissions.ts'

// Chaque entrée porte le droit de sa page (ADR 019) : la navigation ne montre
// que ce que le rôle permet. La page revérifie de son côté.
const sections: { href: string; label: string; permission: Permission }[] = [
  { href: '/reservations', label: 'Planning', permission: 'reservations.gerer' },
  // Les demandes du site public bloquent un créneau tant qu'elles ne sont pas
  // traitées (ADR 005) : leur nombre est affiché en permanence.
  { href: '/demandes', label: 'Demandes', permission: 'demandes.traiter' },
  { href: '/ressources', label: 'Ressources', permission: 'ressources.gerer' },
  { href: '/disponibilites', label: 'Disponibilités', permission: 'horaires.gerer' },
  { href: '/ressources/annonces', label: 'Annonces', permission: 'ressources.gerer' },
  { href: '/ressources/agendas', label: 'Agendas Google', permission: 'agenda-google.gerer' },
  { href: '/clients', label: 'Clients', permission: 'clients.gerer' },
  { href: '/contrats', label: 'Contrats', permission: 'contrats.consulter' },
  { href: '/factures', label: 'Factures', permission: 'facturation.consulter' },
  // Règlements et export comptable (R16, ADR 030) : l'accueil consulte, l'exploitant pointe.
  { href: '/paiements', label: 'Règlements', permission: 'facturation.consulter' },
  { href: '/comptabilite', label: 'Comptabilité', permission: 'comptabilite.exporter' },
  { href: '/tarifs', label: 'Tarifs', permission: 'tarifs.gerer' },
  { href: '/services', label: 'Services', permission: 'services.gerer' },
  { href: '/offres', label: 'Offres', permission: 'services.gerer' },
  // Les demandes de courrier à traiter (ouverture, numérisation,
  // réexpédition) sont comptées : c'est une file d'attente (ADR 037).
  { href: '/courrier', label: 'Courrier', permission: 'courrier.gerer' },
  { href: '/indicateurs', label: 'Indicateurs', permission: 'indicateurs.consulter' },
  { href: '/equipe', label: 'Équipe', permission: 'equipe.gerer' },
  { href: '/configuration', label: 'Configuration', permission: 'centre.configurer' },
]

/**
 * Navigation du back-office. Client parce que l'onglet actif dépend de l'URL
 * courante ; le reste de la coque reste rendu sur le serveur.
 */
export function Nav({
  pendingCount = 0,
  mailRequestCount = 0,
  allowed,
}: {
  pendingCount?: number
  mailRequestCount?: number
  /** Droits du membre connecté (`permissionsOf`). */
  allowed: readonly Permission[]
}) {
  const pathname = usePathname()
  const visibles = sections.filter((section) => allowed.includes(section.permission))

  // Le plus long chemin qui correspond l'emporte : `/ressources/annonces` ne
  // doit pas allumer aussi l'onglet `/ressources`.
  const actif = visibles
    .filter(
      (section) => pathname === section.href || pathname.startsWith(`${section.href}/`),
    )
    .sort((a, b) => b.href.length - a.href.length)[0]?.href

  // Dix-neuf entrées depuis la vague 2 : elles passent à la ligne plutôt que de
  // faire défiler la page horizontalement.
  return (
    <nav className="flex flex-wrap gap-1">
      {visibles.map((section) => {
        const active = section.href === actif
        return (
          <Link
            key={section.href}
            href={section.href}
            aria-current={active ? 'page' : undefined}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
 active
 ? 'bg-primary text-white'
 : 'text-muted-foreground hover:bg-muted hover:text-foreground'
 }`}
          >
            {section.label}
            {section.href === '/demandes' && pendingCount > 0 && (
              <span
                className="ml-1.5 inline-block rounded-full bg-primary px-1.5 text-xs font-semibold text-white tabular"
                aria-label={`${pendingCount} demande${pendingCount > 1 ? 's' : ''} en attente`}
              >
                {pendingCount}
              </span>
            )}
            {section.href === '/courrier' && mailRequestCount > 0 && (
              <span
                className="ml-1.5 inline-block rounded-full bg-primary px-1.5 text-xs font-semibold text-white tabular"
                aria-label={`${mailRequestCount} demande${mailRequestCount > 1 ? 's' : ''} de courrier à traiter`}
              >
                {mailRequestCount}
              </span>
            )}
          </Link>
        )
      })}
    </nav>
  )
}
