'use client'

import { useActionState } from 'react'

import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import { recordLastContactAction, type LastContactFormState } from './actions.ts'

const LABEL = 'Date du contact'

/**
 * Noter un contact avec l'entreprise — appel, rendez-vous, visite (R29) :
 * la durée de conservation repart de ce jour. Aujourd'hui par défaut.
 */
export function LastContactForm({ clientId, today }: { clientId: string; today: string }) {
  const [state, formAction, pending] = useActionState<LastContactFormState, FormData>(
    recordLastContactAction,
    null,
  )
  const error = state?.error

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="clientId" value={clientId} />
      <ErrorSummary
        errors={error ? { lastContactOn: error } : undefined}
        labels={{ lastContactOn: LABEL }}
      />
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="lastContactOn" className="block text-sm font-medium text-foreground">
            {LABEL}
          </label>
          <input
            // Remonté après un échec pour reprendre la saisie.
            key={state?.value ?? today}
            id="lastContactOn"
            name="lastContactOn"
            type="date"
            max={today}
            defaultValue={state?.value ?? today}
            aria-invalid={error ? true : undefined}
            aria-describedby={`lastContactOn-hint${error ? ' lastContactOn-error' : ''}`}
            className="mt-1 rounded-sm border border-border bg-white px-3 py-2 text-sm tabular outline-none focus:border-accent focus:ring-2 focus:ring-accent/40 aria-[invalid=true]:border-destructive"
          />
        </div>
        <button
          type="submit"
          disabled={pending}
          className="rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
        >
          {pending ? 'Enregistrement…' : 'Noter le contact'}
        </button>
        <p role="status" className="text-sm text-primary">
          {state?.saved && !pending ? 'Contact noté.' : ''}
        </p>
      </div>
      <p id="lastContactOn-hint" className="text-xs text-muted-foreground">
        Un appel, un rendez-vous, une visite. La durée de conservation repart de ce jour.
      </p>
      {error && (
        <p id="lastContactOn-error" role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </form>
  )
}
