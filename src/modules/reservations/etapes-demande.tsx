'use client'

import type { ReactNode, RefObject } from 'react'

import { ArrowLeftIcon, ArrowRightIcon } from '../../components/ui/icons.tsx'
import { CHAMP_PIEGE } from '../../lib/champs-anti-robot.ts'

/**
 * Pièces communes aux demandes du site public (créneau, domiciliation), qui
 * s'ouvrent dans le dialogue de réservation : même en-tête d'étape, même barre
 * d'actions collée au bas du dialogue.
 */

export const fieldClass = 'w-full min-h-12 rounded-sm border border-border bg-background px-3 py-2.5 text-base outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-accent/40 aria-[invalid=true]:border-destructive'
export const focusClass = 'focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary'
export const primaryClass = `press inline-flex min-h-12 items-center justify-center gap-2 rounded-md bg-primary px-6 py-3 font-medium text-primary-foreground transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50 ${focusClass}`
/** Pastille de choix : date, famille d'espace. */
export const chipClass = (on: boolean) => `rounded-md border text-sm font-medium transition-colors ${focusClass} ${on ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background text-foreground hover:border-primary'}`

/**
 * Nouvelle étape : le dialogue remonte en haut, pour que la progression se
 * lise, et le focus va au titre pour que le lecteur d'écran l'annonce.
 */
export function showStep(heading: RefObject<HTMLHeadingElement | null>) {
  requestAnimationFrame(() => {
    const title = heading.current
    if (!title) return
    title.focus({ preventScroll: true })
    const body = title.closest('[data-defilement]')
    if (body) body.scrollTop = 0
    else title.scrollIntoView({ block: 'nearest' })
  })
}

export function StepHeader({ step, titles, headingRef, description }: {
  step: number
  titles: readonly string[]
  headingRef: RefObject<HTMLHeadingElement | null>
  description?: string
}) {
  return (
    <div>
      <p className="text-sm font-medium text-muted-foreground">Étape {step} sur {titles.length}</p>
      {/* La progression se lit déjà dans le texte au-dessus. */}
      <div aria-hidden="true" className="mt-2 grid gap-1.5" style={{ gridTemplateColumns: `repeat(${titles.length}, minmax(0, 1fr))` }}>
        {titles.map((title, index) => <span key={title} className={`h-1 rounded-full transition-colors duration-200 ease-out ${index < step ? 'bg-primary' : 'bg-border'}`} />)}
      </div>
      {/* Focalisable par programme (`showStep`), avec le même repère clavier que les actions. */}
      <h3 ref={headingRef} tabIndex={-1} className={`mt-5 rounded-sm text-2xl font-semibold tracking-tight text-primary ${focusClass}`}>{titles[step - 1]}</h3>
      {description && <p className="mt-2 text-sm text-muted-foreground">{description}</p>}
    </div>
  )
}

/** Barre d'actions collée au bas du dialogue, même quand le contenu défile. */
export function StepActions({ onBack, pending, disabled, label, last, hint }: {
  /** Absent à la première étape. */
  onBack?: () => void
  pending: boolean
  disabled?: boolean
  label: string
  last: boolean
  /** Texte à la place du bouton « Retour » à la première étape. */
  hint: ReactNode
}) {
  return (
    <div className="sticky bottom-0 flex items-center justify-between gap-3 border-t border-border bg-background px-5 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-8">
      {onBack
        ? <button type="button" disabled={pending} onClick={onBack} className={`inline-flex min-h-12 items-center gap-2 rounded-md px-3 text-sm font-medium text-primary hover:bg-muted disabled:opacity-50 ${focusClass}`}><ArrowLeftIcon size={18} />Retour</button>
        : <span className="text-xs text-muted-foreground">{hint}</span>}
      <button type="submit" disabled={pending || disabled} className={primaryClass}>
        {pending ? 'Envoi…' : label}
        {!last && !pending && <ArrowRightIcon size={18} />}
      </button>
    </div>
  )
}

/** Un récapitulatif modifiable : « Votre créneau — Modifier ». */
export function RecapBlock({ title, onEdit, pending, children }: { title: string; onEdit: () => void; pending: boolean; children: ReactNode }) {
  return (
    <div className="rounded-lg bg-muted p-4 text-sm">
      <div className="flex items-start justify-between gap-3">
        <p className="font-medium text-foreground">{title}</p>
        <button type="button" onClick={onEdit} disabled={pending} className={`-my-3 min-h-11 font-medium text-primary underline underline-offset-2 ${focusClass}`}>Modifier</button>
      </div>
      <div className="mt-1">{children}</div>
    </div>
  )
}

/**
 * Champ piège contre les robots (`lib/anti-robot.ts`) : hors de l'écran, hors
 * de la tabulation, masqué aux lecteurs d'écran. Rempli, la demande est
 * refusée.
 */
export function ChampPiege() {
  return (
    <div aria-hidden="true" className="absolute -left-[9999px] top-auto h-px w-px overflow-hidden">
      <label>
        Ne pas remplir
        <input type="text" name={CHAMP_PIEGE} tabIndex={-1} autoComplete="off" defaultValue="" />
      </label>
    </div>
  )
}
