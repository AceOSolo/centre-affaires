'use client'

import { useActionState } from 'react'

import { correctScanPagesAction, type MailFormState } from './actions.ts'

const fieldClass =
  'w-24 rounded-sm border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/40 aria-[invalid=true]:border-destructive'

/**
 * Correction du nombre de pages d'un contenu (ADR 044) : un compte faux se
 * reprend tant que la facture qui le tient n'est pas faite. Repliée : c'est
 * l'exception, pas le geste courant.
 */
export function CorrectPagesForm({
  mailItemId,
  scanId,
  pages,
  label,
}: {
  mailItemId: string
  scanId: string
  pages: number
  label: string
}) {
  const [state, formAction, pending] = useActionState<MailFormState, FormData>(correctScanPagesAction, null)
  const fieldId = `pages-${scanId}`
  const error = state?.fieldErrors?.pages

  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-muted-foreground hover:underline">
        Corriger le nombre de pages — {label}
      </summary>
      <form action={formAction} className="mt-2 flex flex-wrap items-end gap-3">
        <input type="hidden" name="mailItemId" value={mailItemId} />
        <input type="hidden" name="scanId" value={scanId} />
        <div>
          <label htmlFor={fieldId} className="block text-sm font-medium">
            Nombre de pages
          </label>
          <input
            id={fieldId}
            name="pages"
            inputMode="numeric"
            defaultValue={pages}
            required
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${fieldId}-error` : undefined}
            className={`${fieldClass} mt-1 tabular`}
          />
        </div>
        <button
          type="submit"
          disabled={pending}
          className="rounded-md border border-border bg-white px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
        >
          {pending ? 'Enregistrement…' : 'Enregistrer'}
        </button>
        {error && (
          <p id={`${fieldId}-error`} role="alert" className="basis-full text-xs text-destructive">
            {error}
          </p>
        )}
        {state?.error && (
          <p role="alert" className="basis-full text-xs text-destructive">
            {state.error}
          </p>
        )}
      </form>
    </details>
  )
}
