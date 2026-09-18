'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const sections = [
  { href: '/reservations', label: 'Planning' },
  // Les demandes du site public bloquent un créneau tant qu'elles ne sont pas
  // traitées (ADR 005) : leur nombre est affiché en permanence.
  { href: '/demandes', label: 'Demandes' },
  { href: '/ressources', label: 'Ressources' },
  { href: '/clients', label: 'Clients' },
  { href: '/contrats', label: 'Contrats' },
  { href: '/tarifs', label: 'Tarifs' },
]

/**
 * Navigation du back-office. Client parce que l'onglet actif dépend de l'URL
 * courante ; le reste de la coque reste rendu sur le serveur.
 */
export function Nav({ pendingCount = 0 }: { pendingCount?: number }) {
  const pathname = usePathname()

  return (
    <nav className="flex gap-1">
      {sections.map((section) => {
        const active = pathname.startsWith(section.href)
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
          </Link>
        )
      })}
    </nav>
  )
}
