'use client'

import { useEffect, useRef, useState, type ElementType, type ReactNode } from 'react'

/**
 * Apparition d'un bloc quand il entre dans l'écran.
 *
 * L'état masqué vit en CSS (`.reveal` dans `globals.css`), ce composant ne fait
 * que poser `data-visible` au bon moment. Une fois vu, le bloc n'est plus
 * observé : une section qui réapparaîtrait en remontant ne doit pas se rejouer,
 * c'est fatigant à la lecture.
 *
 * Sans JavaScript, la règle `<noscript>` de la coque publique rend tout visible.
 * Avec `prefers-reduced-motion`, la feuille de style neutralise l'animation sans
 * que ce composant ait à le savoir.
 */
export function Reveal({
  children,
  as: Tag = 'div',
  delayMs = 0,
  className,
}: {
  children: ReactNode
  /** Balise rendue — `li` dans une liste, `section` dans une page. */
  as?: ElementType
  /** Décalage en cascade pour les éléments d'une même grille. */
  delayMs?: number
  className?: string
}) {
  const ref = useRef<HTMLElement>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const element = ref.current
    if (!element) return

    // Navigateur sans IntersectionObserver : on montre sans attendre plutôt
    // que de risquer un blanc. Écrit sur le nœud et non dans l'état — un
    // `setState` synchrone dans un effet provoque un second rendu pour rien.
    if (typeof IntersectionObserver === 'undefined') {
      element.dataset.visible = 'true'
      return
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return
        setVisible(true)
        observer.disconnect()
      },
      // Déclenche un peu avant le bord bas : le bloc est en place quand le
      // regard y arrive.
      { rootMargin: '0px 0px -10% 0px', threshold: 0.05 },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return (
    <Tag
      ref={ref}
      className={className ? `reveal ${className}` : 'reveal'}
      data-visible={visible ? 'true' : 'false'}
      style={delayMs ? ({ '--reveal-delay': `${delayMs}ms` } as React.CSSProperties) : undefined}
    >
      {children}
    </Tag>
  )
}
