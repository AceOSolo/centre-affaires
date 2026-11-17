'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { isActiveSection, sectionBadge, type SpaceSection } from '../../../modules/clients/espace-rubriques.ts'
import { useUnreadMail, type ClientBellInitial } from '../../../modules/notifications/cloche-client.tsx'
import { unreadMailNoun } from '../../../modules/notifications/cloche-client.ts'

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
 *
 * Barre d'onglets sans barre de défilement parasite (ADR 077) : le trait du
 * bas est une ombre intérieure de la barre, sur laquelle l'onglet actif pose
 * le sien, et non plus une bordure que les onglets chevauchaient d'un pixel
 * (`-mb-px`) — ce pixel débordait, et `overflow-x-auto` en faisait une petite
 * barre de défilement verticale. Le défilement horizontal reste, pour des
 * onglets qui ne tiendraient pas.
 *
 * La pastille de « Courrier » dit le nombre de plis non lus, en chiffres et en
 * toutes lettres pour un lecteur d'écran ; elle suit la cloche, relue à chaque
 * navigation.
 */
export function CompteNav({ sections, initial }: { sections: SpaceSection[]; initial: ClientBellInitial }) {
  const pathname = usePathname()
  const unreadMail = useUnreadMail(initial)
  return (
    <nav
      aria-label="Espace client"
      className={`grid ${mobileColumns[sections.length] ?? 'grid-cols-3'} gap-2 sm:flex sm:gap-1 sm:overflow-x-auto sm:overflow-y-hidden sm:shadow-[inset_0_-1px_0_var(--border)]`}
    >
      {sections.map((section) => {
        const active = isActiveSection(section.href, pathname)
        // La rubrique qui a une pastille la tient à jour avec la cloche.
        const count = section.unread === undefined ? undefined : unreadMail
        const badge = sectionBadge(count)
        return (
          <Link
            key={section.href}
            href={section.href}
            aria-current={active ? 'page' : undefined}
            className={`inline-flex min-h-11 min-w-0 items-center justify-center gap-1.5 rounded-md border px-1 text-center text-sm font-medium transition-colors sm:shrink-0 sm:justify-start sm:whitespace-nowrap sm:rounded-none sm:border-0 sm:border-b-2 sm:px-4 ${
              active
                ? 'border-primary bg-primary text-primary-foreground sm:border-primary sm:bg-transparent sm:text-primary'
                : 'border-border bg-white text-muted-foreground hover:text-primary sm:border-transparent sm:bg-transparent'
            }`}
          >
            {section.label}
            {badge && (
              <span
                className={`min-w-5 rounded-full px-1.5 text-center text-xs font-semibold leading-5 tabular ${
                  active ? 'bg-white text-primary sm:bg-primary sm:text-primary-foreground' : 'bg-primary text-primary-foreground'
                }`}
              >
                {badge}
                <span className="sr-only"> {unreadMailNoun(count ?? 0)}</span>
              </span>
            )}
          </Link>
        )
      })}
    </nav>
  )
}
