'use client'

import { useActionState } from 'react'

import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import { signInspectionAction, type SignState } from './compte-actions.ts'

/**
 * Validation d'un état des lieux par le client, depuis son espace (ADR 039).
 * Mobile d'abord : champ et bouton en pleine largeur, 44 px de haut.
 */
export function SignForm({ inspectionId, memberName }: { inspectionId: string; memberName: string }) {
  const [state, formAction, pending] = useActionState<SignState, FormData>(signInspectionAction, null)
  const error = state?.fieldErrors?.remarks

  return (
    <form action={formAction} className="flex flex-col gap-4 rounded-lg border border-primary bg-white p-4 sm:p-5">
      <input type="hidden" name="id" value={inspectionId} />
      <div>
        <h2 className="text-base font-semibold">Valider cet état des lieux</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Vous confirmez l’avoir lu. La validation est enregistrée à votre nom ({memberName}), avec la
          date du jour, et ne se modifie plus. Si un point vous paraît inexact, indiquez-le ci-dessous :
          vos réserves sont jointes à l’état des lieux.
        </p>
      </div>

      <ErrorSummary
        errors={state?.fieldErrors}
        labels={{ remarks: 'Vos réserves' }}
        message={state?.error}
      />

      <div>
        <label htmlFor="remarks" className="block text-sm font-medium">
          Vos réserves <span className="font-normal text-muted-foreground">(facultatif)</span>
        </label>
        <textarea
          id="remarks"
          name="remarks"
          rows={4}
          maxLength={2000}
          defaultValue={state?.remarks ?? ''}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'remarks-error' : undefined}
          className="mt-1 w-full rounded-sm border border-border bg-white px-3 py-2 text-base outline-none focus:border-accent focus:ring-2 focus:ring-accent/40 aria-[invalid=true]:border-destructive sm:text-sm"
        />
        {error && (
          <p id="remarks-error" className="mt-1 text-sm text-destructive">
            {error}
          </p>
        )}
      </div>

      <button
        type="submit"
        disabled={pending}
        className="inline-flex min-h-11 w-full items-center justify-center rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors duration-150 ease-out hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60 sm:w-auto sm:self-start"
      >
        {pending ? 'Validation…' : 'Valider l’état des lieux'}
      </button>
    </form>
  )
}
