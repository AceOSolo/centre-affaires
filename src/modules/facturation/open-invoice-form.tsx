'use client'

import { useActionState } from 'react'

import { openInvoiceByNumberAction } from './reglements-actions.ts'

/** Ouvre la fiche de règlement d'une facture par son numéro : un virement reçu porte souvent le numéro. */
export function OpenInvoiceForm() {
  const [state, formAction, pending] = useActionState(openInvoiceByNumberAction, null)
  return (
    <form action={formAction} className="flex flex-wrap items-end gap-3">
      <div>
        <label htmlFor="number" className="block text-sm font-medium text-foreground">
          Numéro de facture
        </label>
        <input
          id="number"
          name="number"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={state?.error ? true : undefined}
          aria-describedby={state?.error ? 'number-error number-hint' : 'number-hint'}
          className="mt-1 w-48 rounded-sm border border-border bg-white px-3 py-2 text-sm uppercase outline-none focus:border-accent focus:ring-2 focus:ring-accent/40 aria-[invalid=true]:border-destructive"
        />
      </div>
      <button
        type="submit"
        disabled={pending}
        className="rounded-md border border-border bg-white px-4 py-2 text-sm font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
      >
        {pending ? 'Recherche…' : 'Ouvrir'}
      </button>
      <p id="number-hint" className="w-full text-xs text-muted-foreground">
        Le numéro porté par le virement, par exemple FA-2026-0001.
      </p>
      {state?.error && (
        <p id="number-error" role="alert" className="w-full text-xs text-destructive">
          {state.error}
        </p>
      )}
    </form>
  )
}
