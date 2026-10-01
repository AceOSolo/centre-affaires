'use client'

import { useActionState } from 'react'

import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import { generateExportAction, type ExportFormState } from './comptabilite-actions.ts'

const fieldClass =
  'w-full rounded-sm border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/40 aria-[invalid=true]:border-destructive'

const labels = { periodStart: 'Du', periodEnd: 'Au' }

/** Génération de l'export comptable d'une période (R16, ADR 027, ADR 028). */
export function FecExportForm({ defaultStart, defaultEnd }: { defaultStart: string; defaultEnd: string }) {
  const [state, formAction, pending] = useActionState<ExportFormState, FormData>(generateExportAction, null)
  const values = state?.values ?? { periodStart: defaultStart, periodEnd: defaultEnd }
  const errors = state?.fieldErrors ?? {}

  return (
    <form key={JSON.stringify(state?.values ?? '')} action={formAction} noValidate className="flex flex-col gap-4">
      <ErrorSummary errors={state?.fieldErrors} labels={labels} message={state?.problems ? undefined : state?.message} />
      {state?.problems && (
        <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          <p>{state.message}</p>
          <ul className="mt-1 list-disc pl-5">
            {state.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex flex-wrap items-end gap-4">
        {(['periodStart', 'periodEnd'] as const).map((name) => (
          <div key={name}>
            <label htmlFor={name} className="block text-sm font-medium text-foreground">
              {labels[name]} <span className="font-normal text-muted-foreground">(inclus)</span>
            </label>
            <input
              id={name}
              name={name}
              type="date"
              defaultValue={values[name]}
              aria-invalid={errors[name] ? true : undefined}
              aria-describedby={errors[name] ? `${name}-error` : undefined}
              className={`${fieldClass} mt-1`}
            />
            {errors[name] && (
              <p id={`${name}-error`} className="mt-1 text-xs text-destructive">
                {errors[name]}
              </p>
            )}
          </div>
        ))}
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white transition-colors duration-150 ease-out hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
        >
          {pending ? 'Génération…' : 'Générer l’export'}
        </button>
        <span aria-live="polite" className="sr-only">
          {pending ? 'Génération en cours' : ''}
        </span>
      </div>
    </form>
  )
}
