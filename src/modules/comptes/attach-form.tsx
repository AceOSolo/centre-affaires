'use client'

import { useActionState } from 'react'

import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import { attachAccountAction, type AttachFormState } from './actions.ts'

const fieldClass =
  'w-full rounded-sm border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/40 aria-[invalid=true]:border-destructive'

/**
 * Rattachement d'un compte à une entreprise existante (ADR 045) : la personne
 * en voit l'espace dès sa prochaine page. La fiche créée à l'inscription
 * reste ; elle s'archive depuis la fiche client.
 */
export function AttachForm({
  accountId,
  clients,
}: {
  accountId: string
  clients: { id: string; name: string }[]
}) {
  const [state, formAction, pending] = useActionState<AttachFormState, FormData>(
    attachAccountAction,
    null,
  )
  const error = state?.fieldErrors?.clientId

  return (
    <div className="flex flex-col gap-3">
      <form action={formAction} className="flex flex-col gap-3">
        <ErrorSummary errors={state?.fieldErrors} labels={{ clientId: 'Entreprise' }} />
        <input type="hidden" name="id" value={accountId} />
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-64 flex-1">
            <label className="block text-sm font-medium text-foreground" htmlFor="clientId">
              Entreprise
            </label>
            <select
              id="clientId"
              name="clientId"
              required
              defaultValue=""
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'clientId-error' : undefined}
              className={`${fieldClass} mt-1`}
            >
              <option value="" disabled>
                Choisir une entreprise…
              </option>
              {clients.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </select>
          </div>
          <button
            type="submit"
            disabled={pending}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-hover disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {pending ? 'Rattachement…' : 'Rattacher'}
          </button>
        </div>
        {error && (
          <p id="clientId-error" role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </form>
      <p aria-live="polite" className="text-sm text-primary empty:hidden">
        {state?.ok}
      </p>
    </div>
  )
}
