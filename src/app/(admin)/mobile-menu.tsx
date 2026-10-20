'use client'

import { useId, useRef, useState } from 'react'

/**
 * Bouton « Menu » des écrans étroits : la barre latérale n'y tient pas, la
 * navigation se déplie sous l'en-tête. Le back-office est pensé pour le bureau
 * (CLAUDE.md), mais il doit rester utilisable sur une tablette d'accueil.
 */
export function MobileMenu({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const buttonRef = useRef<HTMLButtonElement>(null)

  return (
    <div className="lg:hidden">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-11 items-center gap-2 rounded-md border border-border px-3 text-sm font-medium transition-colors duration-150 ease-out hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <svg
          width={20}
          height={20}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          aria-hidden="true"
          focusable="false"
        >
          {open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
        </svg>
        {open ? 'Fermer' : 'Menu'}
      </button>
      <div
        id={panelId}
        hidden={!open}
        // Un lien suivi referme le panneau ; Échap aussi, en rendant le focus
        // au bouton pour ne pas perdre l'utilisateur au clavier.
        onClick={(event) => {
          if ((event.target as HTMLElement).closest('a')) setOpen(false)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setOpen(false)
            buttonRef.current?.focus()
          }
        }}
        className="absolute inset-x-0 top-full z-20 max-h-[calc(100vh-4rem)] overflow-y-auto border-b border-border bg-white px-4 py-4 shadow-sm"
      >
        {children}
      </div>
    </div>
  )
}
