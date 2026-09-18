'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const sections = [
  { href: '/reservations', label: 'Planning' },
  { href: '/ressources', label: 'Ressources' },
]

/**
 * Navigation du back-office. Client parce que l'onglet actif dépend de l'URL
 * courante ; le reste de la coque reste rendu sur le serveur.
 */
export function Nav() {
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
                ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100'
            }`}
          >
            {section.label}
          </Link>
        )
      })}
    </nav>
  )
}
