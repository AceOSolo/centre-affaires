'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const sections = [
  { href: '/reservations', label: 'Planning' },
  // Les demandes du site public bloquent un créneau tant qu'elles ne sont pas
  // traitées (ADR 005) : leur nombre est affiché en permanence.
  { href: '/demandes', label: 'Demandes' },
  { href: '/ressources', label: 'Ressources' },
  { href: '/disponibilites', label: 'Disponibilités' },
  { href: '/ressources/annonces', label: 'Annonces' },
  { href: '/ressources/agendas', label: 'Agendas Google' },
  { href: '/clients', label: 'Clients' },
  { href: '/contrats', label: 'Contrats' },
  { href: '/tarifs', label: 'Tarifs' },
  // Les plis dont le client attend l'ouverture sont comptés, comme les
  // demandes : c'est une file d'attente, pas une liste de consultation.
  { href: '/courrier', label: 'Courrier' },
]

/**
 * Navigation du back-office. Client parce que l'onglet actif dépend de l'URL
 * courante ; le reste de la coque reste rendu sur le serveur.
 */
export function Nav({
  pendingCount = 0,
  mailRequestCount = 0,
}: {
  pendingCount?: number
  mailRequestCount?: number
}) {
  const pathname = usePathname()

  // Le plus long chemin qui correspond l'emporte : `/ressources/annonces` ne
  // doit pas allumer aussi l'onglet `/ressources`.
  const actif = sections
    .filter(
      (section) => pathname === section.href || pathname.startsWith(`${section.href}/`),
    )
    .sort((a, b) => b.href.length - a.href.length)[0]?.href

  return (
    <nav className="flex gap-1">
      {sections.map((section) => {
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
                aria-label={`${mailRequestCount} courrier${mailRequestCount > 1 ? 's' : ''} à ouvrir`}
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
