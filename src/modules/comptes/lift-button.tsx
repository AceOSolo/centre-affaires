'use client'

import { useActionState } from 'react'

import { liftBansAction, type SimpleState } from './actions.ts'

/**
 * Levée du bannissement d'un ou plusieurs comptes (ADR 045). Sans
 * confirmation : rouvrir la connexion se défait en bannissant de nouveau.
 */
export function LiftButton({ ids, label }: { ids: string[]; label: string }) {
  const [state, formAction, pending] = useActionState<SimpleState, FormData>(liftBansAction, null)

  return (
    <form action={formAction} className="flex flex-col items-start gap-1">
      {ids.map((id) => (
        <input key={id} type="hidden" name="ids" value={id} />
      ))}
      <button
        type="submit"
        disabled={pending || ids.length === 0}
        className="rounded-md border border-border bg-white px-4 py-2 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {pending ? 'Réactivation…' : label}
      </button>
      <p aria-live="polite" className="text-sm empty:hidden">
        {!pending && state?.ok && <span className="text-primary">{state.ok}</span>}
        {!pending && state?.error && <span className="text-destructive">{state.error}</span>}
      </p>
    </form>
  )
}
