'use client'

import { useEffect, useRef } from 'react'

import { CheckIcon } from './icons.tsx'

/**
 * Confirmation d'une action réussie, affichée sur la page où elle mène.
 *
 * Toute soumission rend un état (`CLAUDE.md`). Après une redirection, une
 * région `role="status"` déjà remplie au chargement n'est pas toujours lue :
 * le focus y est donc porté, comme le fait le résumé d'erreurs, pour que
 * l'utilisateur au clavier ou au lecteur d'écran apprenne le succès là où il
 * arrive. Remonter le composant (par sa `key`) refocalise.
 */
export function FlashNotice({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    ref.current?.focus()
  }, [])

  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="status"
      className="flex items-start gap-2 rounded-md border border-primary/20 bg-primary/5 px-4 py-3 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      <CheckIcon size={20} className="shrink-0 text-primary" />
      <div>{children}</div>
    </div>
  )
}
