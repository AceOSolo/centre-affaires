'use client'

import { useEffect, useState } from 'react'

import Link from 'next/link'

export type Section = { href: string; label: string }

/**
 * Navigation du site public : elle suit la lecture.
 *
 * La section à l'écran est signalée dans la barre, ce qui situe le visiteur sans
 * qu'il ait à le demander. Le repère n'est pas porté par la seule couleur —
 * `aria-current` le dit aussi aux outils d'assistance.
 *
 * Client parce que ça dépend du défilement ; le reste de la coque reste rendu
 * sur le serveur.
 */
export function SectionNav({
  sections,
  className,
  linkClassName,
  activeClassName,
}: {
  sections: Section[]
  className?: string
  linkClassName: string
  activeClassName: string
}) {
  const [active, setActive] = useState<string | null>(null)

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return

    const ids = sections.map((section) => section.href.split('#')[1]).filter(Boolean)
    const elements = ids
      .map((id) => document.getElementById(id))
      .filter((element): element is HTMLElement => element !== null)
    if (elements.length === 0) return

    // Une bande étroite au tiers haut de l'écran : la section « courante » est
    // celle qu'on lit, pas celle qui entre tout juste par le bas.
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]
        if (visible) setActive(visible.target.id)
      },
      { rootMargin: '-25% 0px -60% 0px', threshold: 0 },
    )
    for (const element of elements) observer.observe(element)
    return () => observer.disconnect()
  }, [sections])

  return (
    <nav className={className}>
      {sections.map((section) => {
        const id = section.href.split('#')[1]
        const courante = active === id
        return (
          <Link
            key={section.href}
            href={section.href}
            aria-current={courante ? 'true' : undefined}
            className={courante ? `${linkClassName} ${activeClassName}` : linkClassName}
          >
            {section.label}
          </Link>
        )
      })}
    </nav>
  )
}
