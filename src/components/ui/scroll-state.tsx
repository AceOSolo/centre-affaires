'use client'

import { useEffect } from 'react'

/**
 * Pose `data-scrolled` sur la racine du document dès que la page a défilé.
 *
 * Ne rend rien : c'est la feuille de style qui décide quoi en faire — ici une
 * ombre sous l'en-tête collant. Passer par un attribut plutôt que par l'état
 * d'un composant évite de rendre toute la coque côté client pour un ombrage.
 *
 * L'écouteur est passif : il ne bloque jamais le défilement.
 */
export function ScrollState({ threshold = 8 }: { threshold?: number }) {
  useEffect(() => {
    const racine = document.documentElement
    let dernier: boolean | null = null

    const appliquer = () => {
      const defile = window.scrollY > threshold
      // On n'écrit dans le DOM que sur changement d'état, pas à chaque pixel.
      if (defile === dernier) return
      dernier = defile
      racine.dataset.scrolled = defile ? 'true' : 'false'
    }

    appliquer()
    window.addEventListener('scroll', appliquer, { passive: true })
    return () => {
      window.removeEventListener('scroll', appliquer)
      delete racine.dataset.scrolled
    }
  }, [threshold])

  return null
}
