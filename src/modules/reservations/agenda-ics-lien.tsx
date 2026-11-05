'use client'

import { useRef, useState } from 'react'

const focus = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

/**
 * Lien d'agenda d'une ressource (ADR 071), en lecture seule, avec un bouton
 * « Copier » qui dit ce qu'il a fait. Sans presse-papiers (page servie en
 * HTTP, navigateur qui refuse), le lien est sélectionné et l'écran dit de le
 * copier au clavier.
 */
export function FeedLinkField({ id, label, url }: { id: string; label: string; url: string }) {
  const field = useRef<HTMLInputElement>(null)
  const [outcome, setOutcome] = useState<'copie' | 'manuel'>()

  const copy = async () => {
    field.current?.select()
    try {
      await navigator.clipboard.writeText(url)
      setOutcome('copie')
    } catch {
      setOutcome('manuel')
    }
  }

  return (
    <div className="flex min-w-80 flex-col gap-1">
      <div className="flex gap-2">
        <input
          id={id}
          ref={field}
          readOnly
          value={url}
          aria-label={label}
          onFocus={(event) => event.currentTarget.select()}
          className="min-w-0 flex-1 rounded-sm border border-border bg-muted px-3 py-2 text-xs text-foreground outline-none focus:border-accent focus:ring-2 focus:ring-accent/40"
        />
        <button
          type="button"
          onClick={copy}
          className={`shrink-0 rounded-md border border-border bg-white px-3 py-2 text-sm font-medium transition-colors duration-150 ease-out hover:bg-muted ${focus}`}
        >
          Copier
        </button>
      </div>
      {/* Toujours présent, vide au départ : le message est annoncé quand il change. */}
      <p role="status" className="text-xs text-muted-foreground">
        {outcome === 'copie' && 'Copié.'}
        {outcome === 'manuel' && 'Copie automatique impossible : le lien est sélectionné, faites Ctrl+C.'}
      </p>
    </div>
  )
}
