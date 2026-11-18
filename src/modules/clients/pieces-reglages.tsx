'use client'

import { useActionState, useId } from 'react'

import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import {
  moveDocumentKindAction,
  saveDocumentKindAction,
  toggleDocumentKindAction,
  type KindFormState,
  type KindToggleState,
} from './pieces-actions.ts'
import { KIND_HELP_MAX, KIND_LABEL_MAX, situationLabels } from './pieces-regles.ts'
import type { ClientDocumentSituation } from './schema-pieces.ts'

const situations = Object.keys(situationLabels) as ClientDocumentSituation[]

const fieldClass =
  'mt-1 w-full rounded-md border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/40 aria-[invalid=true]:border-destructive'
const primary =
  'inline-flex min-h-9 items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors duration-150 ease-out hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60'
const secondary =
  'inline-flex min-h-8 items-center rounded-md border border-border bg-white px-3 py-1 text-xs font-medium text-foreground transition-colors duration-150 ease-out hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60'

const Required = () => (
  <span aria-hidden="true" className="text-destructive">
    *
  </span>
)

/**
 * Une pièce de la liste : ajout (`code` absent) ou modification. Nom, aide
 * montrée au client, sociétés à qui elle est demandée.
 */
export function DocumentKindForm({
  kind,
}: {
  kind?: { code: string; label: string; help: string | null; appliesTo: ClientDocumentSituation }
}) {
  const [state, formAction, pending] = useActionState<KindFormState, FormData>(saveDocumentKindAction, null)
  const id = useId()
  const ids = { label: `${id}-label`, help: `${id}-help`, appliesTo: `${id}-appliesTo` }
  const values = state?.values ?? { label: kind?.label ?? '', help: kind?.help ?? '', appliesTo: kind?.appliesTo ?? 'all' }
  const errors = state?.fieldErrors ?? {}

  return (
    <form
      key={JSON.stringify(values)}
      action={formAction}
      className="flex flex-col gap-3"
      aria-label={kind ? `Modifier : ${kind.label}` : 'Ajouter une pièce'}
    >
      <p className="text-xs text-muted-foreground">
        Les champs marqués <Required />
        <span className="sr-only">d’un astérisque</span> sont obligatoires.
      </p>
      <ErrorSummary
        errors={Object.fromEntries(Object.entries(errors).map(([field, error]) => [ids[field as keyof typeof ids], error]))}
        labels={{ [ids.label]: 'Nom de la pièce', [ids.help]: 'Aide', [ids.appliesTo]: 'Demandée à' }}
        message={state?.error}
      />
      <input type="hidden" name="code" value={kind?.code ?? ''} />
      <div>
        <label htmlFor={ids.label} className="text-sm font-medium">
          Nom de la pièce <Required />
        </label>
        <input
          id={ids.label}
          name="label"
          defaultValue={values.label}
          required
          aria-required="true"
          maxLength={KIND_LABEL_MAX}
          aria-invalid={errors.label ? true : undefined}
          aria-describedby={errors.label ? `${ids.label}-erreur` : undefined}
          className={fieldClass}
        />
        {errors.label && (
          <p id={`${ids.label}-erreur`} className="mt-1 text-xs text-destructive">
            {errors.label}
          </p>
        )}
      </div>
      <div>
        <label htmlFor={ids.help} className="text-sm font-medium">
          Aide montrée au client <span className="font-normal text-muted-foreground">(facultatif)</span>
        </label>
        <input
          id={ids.help}
          name="help"
          defaultValue={values.help}
          maxLength={KIND_HELP_MAX}
          aria-invalid={errors.help ? true : undefined}
          aria-describedby={`${ids.help}-aide${errors.help ? ` ${ids.help}-erreur` : ''}`}
          className={fieldClass}
        />
        <p id={`${ids.help}-aide`} className="mt-1 text-xs text-muted-foreground">
          Ce qui est accepté, l’ancienneté exigée : « De moins de trois mois. »
        </p>
        {errors.help && (
          <p id={`${ids.help}-erreur`} className="mt-1 text-xs text-destructive">
            {errors.help}
          </p>
        )}
      </div>
      <div>
        <label htmlFor={ids.appliesTo} className="text-sm font-medium">
          Demandée à <Required />
        </label>
        <select
          id={ids.appliesTo}
          name="appliesTo"
          defaultValue={values.appliesTo}
          required
          aria-required="true"
          aria-invalid={errors.appliesTo ? true : undefined}
          aria-describedby={errors.appliesTo ? `${ids.appliesTo}-erreur` : undefined}
          className={fieldClass}
        >
          {situations.map((situation) => (
            <option key={situation} value={situation}>
              {situationLabels[situation]}
            </option>
          ))}
        </select>
        {errors.appliesTo && (
          <p id={`${ids.appliesTo}-erreur`} className="mt-1 text-xs text-destructive">
            {errors.appliesTo}
          </p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={primary}>
          {pending ? 'Enregistrement…' : kind ? 'Enregistrer' : 'Ajouter à la liste'}
        </button>
        <p aria-live="polite" className="text-sm text-primary empty:hidden">
          {!pending && state?.ok}
        </p>
      </div>
    </form>
  )
}

/** Retirer une pièce de la liste, ou l'y remettre. */
export function DocumentKindToggle({ code, label, active }: { code: string; label: string; active: boolean }) {
  const [state, formAction, pending] = useActionState<KindToggleState, FormData>(toggleDocumentKindAction, null)
  return (
    <form action={formAction} className="flex flex-col items-start gap-1">
      <input type="hidden" name="code" value={code} />
      <input type="hidden" name="active" value={active ? 'false' : 'true'} />
      <button type="submit" disabled={pending} className={secondary} aria-label={`${active ? 'Retirer de la liste' : 'Remettre dans la liste'} : ${label}`}>
        {pending ? '…' : active ? 'Retirer' : 'Remettre'}
      </button>
      {!pending && state?.error && (
        <p role="alert" className="text-xs text-destructive">
          {state.error}
        </p>
      )}
    </form>
  )
}

/** Monter ou descendre une pièce : l'ordre où le client la voit. */
export function DocumentKindMove({
  code,
  label,
  direction,
  disabled,
}: {
  code: string
  label: string
  direction: 'up' | 'down'
  disabled: boolean
}) {
  const [, formAction, pending] = useActionState<KindToggleState, FormData>(moveDocumentKindAction, null)
  return (
    <form action={formAction}>
      <input type="hidden" name="code" value={code} />
      <input type="hidden" name="direction" value={direction} />
      <button
        type="submit"
        disabled={disabled || pending}
        className={secondary}
        aria-label={`${direction === 'up' ? 'Monter' : 'Descendre'} : ${label}`}
      >
        {direction === 'up' ? 'Monter' : 'Descendre'}
      </button>
    </form>
  )
}
