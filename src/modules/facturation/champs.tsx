import type { ReactNode } from 'react'

import { CheckIcon } from '../../components/ui/icons.tsx'

/**
 * Champs des formulaires du catalogue, des offres et des souscriptions.
 *
 * Chaque champ a un libellé visible, jamais remplacé par un placeholder ;
 * son `id` est son nom, cible du lien du résumé d'erreurs ; son aide et son
 * erreur lui sont reliées par `aria-describedby`, et l'erreur est annoncée
 * (`CLAUDE.md`, « Formulaires »).
 */

export const fieldClass =
  'w-full rounded-sm border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/40 aria-[invalid=true]:border-destructive disabled:bg-muted read-only:bg-muted'
export const labelClass = 'block text-sm font-medium text-foreground'
export const primaryButtonClass =
  'rounded-md bg-primary px-4 py-2 text-sm font-medium text-white transition-colors duration-150 ease-out hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50'
export const secondaryButtonClass =
  'rounded-md border border-border px-4 py-2 text-sm font-medium transition-colors duration-150 ease-out hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50'
export const dangerButtonClass =
  'rounded-md border border-destructive/30 px-4 py-2 text-sm font-medium text-destructive transition-colors duration-150 ease-out hover:bg-destructive/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-destructive disabled:opacity-50'

/** Attributs d'accessibilité d'un contrôle : son aide, son erreur. */
export function describedBy(name: string, error?: string, hint?: ReactNode) {
  const ids = [error ? `${name}-error` : null, hint ? `${name}-hint` : null].filter(Boolean)
  return {
    'aria-invalid': error ? (true as const) : undefined,
    'aria-describedby': ids.length > 0 ? ids.join(' ') : undefined,
  }
}

export function FieldLabel({
  name,
  children,
  optional = false,
}: {
  name: string
  children: ReactNode
  optional?: boolean
}) {
  return (
    <label className={labelClass} htmlFor={name}>
      {children}
      {optional && <span className="font-normal text-muted-foreground"> (facultatif)</span>}
    </label>
  )
}

export function FieldHint({ name, children }: { name: string; children?: ReactNode }) {
  if (!children) return null
  return (
    <p id={`${name}-hint`} className="mt-1 text-xs text-muted-foreground">
      {children}
    </p>
  )
}

export function FieldError({ name, error }: { name: string; error?: string }) {
  if (!error) return null
  return (
    <p id={`${name}-error`} role="alert" className="mt-1 text-xs text-destructive">
      {error}
    </p>
  )
}

/** Champ texte complet : libellé, contrôle, aide, erreur. */
export function TextField({
  label,
  name,
  hint,
  error,
  optional = false,
  suffix,
  ...props
}: {
  label: ReactNode
  name: string
  hint?: ReactNode
  error?: string
  optional?: boolean
  /** Unité affichée après le champ : « € », « % », « mois ». */
  suffix?: string
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'name' | 'id'>) {
  const input = (
    <input
      id={name}
      name={name}
      {...describedBy(name, error, hint)}
      className={`${fieldClass} ${suffix ? '' : 'mt-1'} ${props.inputMode === 'decimal' || props.inputMode === 'numeric' ? 'tabular' : ''}`}
      {...props}
    />
  )
  return (
    <div>
      <FieldLabel name={name} optional={optional}>
        {label}
      </FieldLabel>
      {suffix ? (
        <div className="mt-1 flex items-center gap-2">
          {input}
          <span className="text-sm text-muted-foreground">{suffix}</span>
        </div>
      ) : (
        input
      )}
      <FieldError name={name} error={error} />
      <FieldHint name={name}>{hint}</FieldHint>
    </div>
  )
}

/** Bandeau de confirmation après une écriture réussie. */
export function SuccessNotice({ children }: { children: ReactNode }) {
  return (
    <p
      role="status"
      className="flex flex-wrap items-center gap-2 rounded-md border border-primary/20 bg-primary/5 px-4 py-3 text-sm text-primary"
    >
      <CheckIcon size={20} />
      {children}
    </p>
  )
}

/** Annonce l'envoi en cours : le bouton désactivé ne se lit pas seul. */
export function PendingAnnouncement({ pending, label }: { pending: boolean; label: string }) {
  return (
    <span aria-live="polite" className="sr-only">
      {pending ? label : ''}
    </span>
  )
}
