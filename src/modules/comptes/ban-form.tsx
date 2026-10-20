'use client'

import { useActionState, useState } from 'react'

import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import { banAccountsAction, type BanFormState } from './actions.ts'
import { REASON_MAX } from './regles.ts'

const fieldClass =
  'w-full rounded-sm border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/40 aria-[invalid=true]:border-destructive disabled:opacity-60'
const labelClass = 'block text-sm font-medium text-foreground'

/**
 * Bannissement d'un ou plusieurs comptes (ADR 045) : un motif, gardé dans
 * l'historique, et une durée — jusqu'à levée, ou jusqu'à un jour inclus.
 *
 * Les comptes visés arrivent en `targets` (identifiant et libellé) : cochés
 * dans la liste, ou le compte de la fiche. Le serveur revérifie chacun.
 */
export function BanForm({
  targets,
  today,
  submitLabel,
}: {
  targets: { id: string; label: string }[]
  /** Aujourd'hui pour le centre : le plus tôt des derniers jours possibles. */
  today: string
  submitLabel: string
}) {
  const [state, formAction, pending] = useActionState<BanFormState, FormData>(banAccountsAction, null)
  const [duration, setDuration] = useState(state?.values?.duration ?? 'definitif')
  const reasonError = state?.fieldErrors?.reason
  const untilError = state?.fieldErrors?.until

  return (
    <div className="flex flex-col gap-3">
      <form
        key={JSON.stringify(state?.values ?? state?.ok ?? '')}
        action={formAction}
        className="flex flex-col gap-3"
      >
        <ErrorSummary
          errors={state?.fieldErrors}
          labels={{ reason: 'Motif', until: 'Durée' }}
          message={state?.error}
        />
        {targets.map((target) => (
          <span key={target.id} hidden>
            <input type="hidden" name="ids" value={target.id} />
            <input type="hidden" name="labels" value={`${target.id}|${target.label}`} />
          </span>
        ))}

        <div>
          <label className={labelClass} htmlFor="reason">
            Motif
          </label>
          <textarea
            id="reason"
            name="reason"
            rows={2}
            required
            maxLength={REASON_MAX}
            defaultValue={state?.values?.reason ?? ''}
            aria-invalid={reasonError ? true : undefined}
            aria-describedby={reasonError ? 'reason-error reason-hint' : 'reason-hint'}
            className={`${fieldClass} mt-1`}
          />
          <p id="reason-hint" className="mt-1 text-xs text-muted-foreground">
            Lu par l’équipe seulement : la personne voit « compte suspendu », sans le motif.
          </p>
          {reasonError && (
            <p id="reason-error" role="alert" className="mt-1 text-xs text-destructive">
              {reasonError}
            </p>
          )}
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className={labelClass}>Durée</legend>
          <label className="flex min-h-6 items-center gap-2 text-sm">
            <input
              type="radio"
              name="duration"
              value="definitif"
              checked={duration === 'definitif'}
              onChange={() => setDuration('definitif')}
            />
            Jusqu’à ce qu’un membre de l’équipe le lève
          </label>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <label className="flex min-h-6 items-center gap-2">
              <input
                type="radio"
                name="duration"
                value="temporaire"
                checked={duration === 'temporaire'}
                onChange={() => setDuration('temporaire')}
              />
              Jusqu’au (inclus)
            </label>
            <label className="sr-only" htmlFor="until">
              Dernier jour du bannissement
            </label>
            <input
              id="until"
              name="until"
              type="date"
              min={today}
              disabled={duration !== 'temporaire'}
              required={duration === 'temporaire'}
              defaultValue={state?.values?.until ?? ''}
              aria-invalid={untilError ? true : undefined}
              aria-describedby={untilError ? 'until-error' : undefined}
              className={`${fieldClass} w-auto`}
            />
          </div>
          {untilError && (
            <p id="until-error" role="alert" className="text-xs text-destructive">
              {untilError}
            </p>
          )}
        </fieldset>

        <button
          type="submit"
          disabled={pending || targets.length === 0}
          className="self-start rounded-md bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-hover disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {pending ? 'Bannissement…' : submitLabel}
        </button>
      </form>

      {/* Hors du formulaire remonté : la région annoncée existe avant son contenu. */}
      <div aria-live="polite" className="flex flex-col gap-1 text-sm empty:hidden">
        {state?.ok && <p className="text-primary">{state.ok}</p>}
        {state?.refused && state.refused.length > 0 && (
          <ul className="list-disc pl-5 text-destructive">
            {state.refused.map((entry, index) => (
              <li key={index}>
                {entry.label} : {entry.message}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
