'use client'

import { useActionState, useState } from 'react'

import Link from 'next/link'

import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import { createInspectionAction, type InspectionFormState } from './actions.ts'
import { errorClass, fieldClass, hintClass, labelClass, primaryButton } from './styles.ts'

export type CandidateOption = {
  key: string
  label: string
  detail: string
  /** Entrées closes sans sortie, pour la même ressource et le même client. */
  openEntries: { id: string; label: string }[]
}

const labels: Record<string, string> = {
  candidate: 'Occupation',
  kind: 'Nature',
  entry: 'État des lieux d’entrée',
  performedAt: 'Date et heure',
}

/**
 * Ouverture d'un état des lieux d'entrée ou de sortie, depuis une
 * réservation, un contrat ou une ressource. L'occupation se choisit parmi
 * celles que le serveur propose ; il les retrouve à l'envoi, sans croire le
 * formulaire.
 */
export function NewInspectionForm({
  contextKind,
  contextId,
  candidates,
  defaultKind,
  defaultPerformedAt,
  cancelHref,
}: {
  contextKind: string
  contextId: string
  candidates: CandidateOption[]
  defaultKind: 'entry' | 'exit'
  defaultPerformedAt: string
  cancelHref: string
}) {
  const [state, formAction, pending] = useActionState<InspectionFormState, FormData>(
    createInspectionAction,
    null,
  )
  const [candidateKey, setCandidateKey] = useState(
    state?.values?.candidate ?? (candidates.length === 1 ? candidates[0].key : ''),
  )
  const [kind, setKind] = useState(state?.values?.kind ?? defaultKind)
  const errors = state?.fieldErrors ?? {}
  const candidate = candidates.find((option) => option.key === candidateKey)
  const entries = candidate?.openEntries ?? []

  return (
    <form action={formAction} className="flex max-w-2xl flex-col gap-6">
      <input type="hidden" name="contextKind" value={contextKind} />
      <input type="hidden" name="contextId" value={contextId} />
      <ErrorSummary errors={state?.fieldErrors} labels={labels} message={state?.error} />

      <fieldset>
        <legend className={labelClass}>Nature</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {(
            [
              ['entry', 'Entrée — remise des lieux au client'],
              ['exit', 'Sortie — restitution au centre'],
            ] as const
          ).map(([value, label], index) => (
            <label
              key={value}
              className="inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-md border border-border bg-white px-3 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5 has-[:checked]:font-medium has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent"
            >
              <input
                id={index === 0 ? 'kind' : `kind-${index}`}
                type="radio"
                name="kind"
                value={value}
                checked={kind === value}
                onChange={() => setKind(value)}
                className="size-4 accent-primary"
              />
              {label}
            </label>
          ))}
        </div>
        {errors.kind && <p className={errorClass}>{errors.kind}</p>}
      </fieldset>

      <fieldset aria-describedby={errors.candidate ? 'candidate-error' : undefined}>
        <legend className={labelClass}>Occupation</legend>
        <ul className="mt-2 flex flex-col gap-2">
          {candidates.map((option, index) => (
            <li key={option.key}>
              <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border bg-white px-4 py-3 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent">
                <input
                  id={index === 0 ? 'candidate' : `candidate-${index}`}
                  type="radio"
                  name="candidate"
                  value={option.key}
                  checked={candidateKey === option.key}
                  onChange={() => setCandidateKey(option.key)}
                  className="mt-0.5 size-4 accent-primary"
                />
                <span>
                  <span className="font-medium">{option.label}</span>
                  <span className="block text-muted-foreground">{option.detail}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
        {errors.candidate && (
          <p id="candidate-error" className={errorClass}>
            {errors.candidate}
          </p>
        )}
      </fieldset>

      {kind === 'exit' && (
        <div className="max-w-xl">
          <label className={labelClass} htmlFor="entry">
            État des lieux d’entrée
          </label>
          <select
            id="entry"
            name="entry"
            defaultValue={state?.values?.entry ?? entries[0]?.id ?? ''}
            key={candidateKey}
            aria-describedby="entry-hint"
            className={`${fieldClass} mt-1`}
          >
            {entries.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
            <option value="">Aucun — l’entrée n’a pas été faite dans l’application</option>
          </select>
          <p id="entry-hint" className={hintClass}>
            {entries.length > 0
              ? 'La sortie se compare à l’entrée qu’elle clôt, champ par champ.'
              : candidate
                ? 'Aucune entrée close sans sortie pour ce client et cette ressource : la sortie ne pourra pas être comparée.'
                : 'Choisissez d’abord l’occupation.'}
          </p>
          {errors.entry && <p className={errorClass}>{errors.entry}</p>}
        </div>
      )}

      <div className="max-w-xs">
        <label className={labelClass} htmlFor="performedAt">
          Date et heure
        </label>
        <input
          id="performedAt"
          name="performedAt"
          type="datetime-local"
          required
          defaultValue={state?.values?.performedAt ?? defaultPerformedAt}
          aria-invalid={errors.performedAt ? true : undefined}
          aria-describedby={errors.performedAt ? 'performedAt-error' : undefined}
          className={`${fieldClass} mt-1 tabular`}
        />
        {errors.performedAt && (
          <p id="performedAt-error" className={errorClass}>
            {errors.performedAt}
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <button type="submit" disabled={pending || candidates.length === 0} className={primaryButton}>
          {pending ? 'Ouverture…' : 'Commencer la saisie'}
        </button>
        <Link href={cancelHref} className="text-sm text-muted-foreground hover:underline">
          Annuler
        </Link>
      </div>
    </form>
  )
}
