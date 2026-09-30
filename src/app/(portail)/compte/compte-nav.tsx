'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const sections = [
  { href: '/compte/courrier', label: 'Ma boîte aux lettres' },
  { href: '/compte/reservations', label: 'Mes réservations' },
]

/**
 * Rubriques de l'espace client. Client parce que l'onglet actif dépend de
 * l'URL ; l'état actif est dit par `aria-current`, pas par la seule couleur.
 */
export function CompteNav() {
  const pathname = usePathname()
  return (
    <nav aria-label="Espace client" className="flex gap-1 overflow-x-auto border-b border-border">
      {sections.map((section) => {
        const active = pathname === section.href || pathname.startsWith(`${section.href}/`)
        return (
          <Link
            key={section.href}
            href={section.href}
            aria-current={active ? 'page' : undefined}
            className={`-mb-px inline-flex min-h-11 items-center whitespace-nowrap border-b-2 px-4 text-sm font-medium transition-colors ${
              active
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-primary'
            }`}
          >
            {section.label}
          </Link>
        )
      })}
    </nav>
  )
}
