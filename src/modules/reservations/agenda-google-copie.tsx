'use client'

import { useRef, useState } from 'react'

const focus = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

/**
 * Texte à recopier ailleurs (code d'intégration d'un agenda Google, ADR 064),
 * en lecture seule, avec un bouton « Copier » qui dit ce qu'il a fait.
 *
 * Sans presse-papiers (page servie en HTTP, navigateur qui refuse), le texte
 * est sélectionné et l'écran dit de le copier au clavier.
 */
export function CopyField({ id, label, value, rows = 1 }: { id: string; label: string; value: string; rows?: number }) {
  const field = useRef<HTMLTextAreaElement>(null)
  const [outcome, setOutcome] = useState<'copie' | 'manuel'>()

  const copy = async () => {
    field.current?.select()
    try {
      await navigator.clipboard.writeText(value)
      setOutcome('copie')
    } catch {
      setOutcome('manuel')
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      <textarea
        id={id}
        ref={field}
        readOnly
        rows={rows}
        value={value}
        onFocus={(event) => event.currentTarget.select()}
        className="w-full resize-none break-all rounded-sm border border-border bg-muted px-3 py-2 text-xs text-foreground outline-none focus:border-accent focus:ring-2 focus:ring-accent/40"
      />
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={copy}
          className={`rounded-md border border-border bg-white px-4 py-2 text-sm font-medium transition-colors duration-150 ease-out hover:bg-muted ${focus}`}
        >
          Copier
        </button>
        {/* Toujours présent, vide au départ : le message est annoncé quand il change. */}
        <p role="status" className="text-sm text-muted-foreground">
          {outcome === 'copie' && 'Copié.'}
          {outcome === 'manuel' && 'Copie automatique impossible : le texte est sélectionné, faites Ctrl+C.'}
        </p>
      </div>
    </div>
  )
}
