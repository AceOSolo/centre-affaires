'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { isActiveSection, type SpaceSection } from '../../../modules/clients/espace-rubriques.ts'

/** Colonnes sur téléphone : aucune case vide pour deux, trois ou quatre rubriques. */
const mobileColumns: Record<number, string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-2',
  4: 'grid-cols-2',
}

/**
 * Rubriques de l'espace client, celles que l'entreprise utilise seulement
 * (`clientSections`). Client parce que l'onglet actif dépend de l'URL ; l'état
 * actif est dit par `aria-current`, pas par la seule couleur.
 *
 * Mobile d'abord (R25) : une grille, chaque rubrique visible et haute de
 * 44 px, à 8 px de sa voisine — une bande qui défile cacherait les dernières.
 * À partir de `sm`, la barre d'onglets habituelle.
 */
export function CompteNav({ sections }: { sections: SpaceSection[] }) {
  const pathname = usePathname()
  return (
    <nav
      aria-label="Espace client"
      className={`grid ${mobileColumns[sections.length] ?? 'grid-cols-3'} gap-2 sm:flex sm:gap-1 sm:overflow-x-auto sm:border-b sm:border-border`}
    >
      {sections.map((section) => {
        const active = isActiveSection(section.href, pathname)
        return (
          <Link
            key={section.href}
            href={section.href}
            aria-current={active ? 'page' : undefined}
            className={`inline-flex min-h-11 min-w-0 items-center justify-center rounded-md border px-1 text-center text-sm font-medium transition-colors sm:-mb-px sm:justify-start sm:whitespace-nowrap sm:rounded-none sm:border-0 sm:border-b-2 sm:px-4 ${
              active
                ? 'border-primary bg-primary text-primary-foreground sm:bg-transparent sm:text-primary'
                : 'border-border bg-white text-muted-foreground hover:text-primary sm:border-transparent sm:bg-transparent'
            }`}
          >
            {section.label}
          </Link>
        )
      })}
    </nav>
  )
}
