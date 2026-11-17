'use client'

import { useActionState } from 'react'

import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import {
  CLIENT_BELL_DEFAULT_DAYS,
  CLIENT_BELL_MAX_DAYS,
  clientBellDescriptions,
  clientBellEvents,
  clientBellLabels,
  type ClientBellSettings,
} from './cloche-client.ts'
import { saveClientBellSettingsAction, type ClientBellSettingsFormState } from './cloche-client-reglages-actions.ts'

const field =
  'mt-1 w-28 rounded-lg border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/40 aria-[invalid=true]:border-destructive'

/**
 * Réglage de la cloche de l'espace client (ADR 077) : une case par nouveauté,
 * cochée quand la cloche l'annonce, et la durée pendant laquelle elle la
 * garde. Sans rien enregistrer, tout est coché et la durée est de
 * {@link CLIENT_BELL_DEFAULT_DAYS} jours.
 */
export function ClientBellSettingsForm({ settings }: { settings: ClientBellSettings }) {
  const [state, action, pending] = useActionState<ClientBellSettingsFormState, FormData>(
    saveClientBellSettingsAction,
    null,
  )
  const error = state?.errors?.windowDays

  return (
    <form action={action} className="flex flex-col gap-5" noValidate>
      <p className="text-sm text-muted-foreground">
        Les champs marqués <span aria-hidden="true">*</span>
        <span className="sr-only">d’un astérisque</span> sont obligatoires.
      </p>
      <ErrorSummary errors={error ? { windowDays: error } : undefined} labels={{ windowDays: 'Durée d’affichage' }} />

      <fieldset className="flex flex-col gap-1">
        <legend className="text-sm font-semibold">Nouveautés annoncées</legend>
        <p className="mb-2 text-xs text-muted-foreground">
          La cloche les lit dans le journal des messages envoyés aux clients, que le courriel soit parti ou non.
        </p>
        <ul className="grid gap-1 lg:grid-cols-2">
          {clientBellEvents.map((event) => (
            <li key={event}>
              <label className="flex min-h-6 cursor-pointer items-start gap-3 rounded-md px-2 py-1.5 hover:bg-muted">
                <input
                  type="checkbox"
                  name="evenement"
                  value={event}
                  defaultChecked={!settings.hiddenEvents.includes(event)}
                  className="mt-0.5 size-4 shrink-0 accent-primary"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{clientBellLabels[event]}</span>
                  <span className="block text-xs text-muted-foreground">{clientBellDescriptions[event]}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>

      <div>
        <label htmlFor="windowDays" className="text-sm font-semibold">
          Durée d’affichage, en jours{' '}
          <span aria-hidden="true" className="text-primary">
            *
          </span>
        </label>
        <div>
          <input
            id="windowDays"
            name="windowDays"
            type="number"
            min={1}
            max={CLIENT_BELL_MAX_DAYS}
            step={1}
            required
            aria-required="true"
            defaultValue={settings.windowDays}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'windowDays-error windowDays-hint' : 'windowDays-hint'}
            className={field}
          />
        </div>
        <p id="windowDays-hint" className="mt-1 text-xs text-muted-foreground">
          Une nouveauté plus ancienne sort de la cloche, lue ou non. De 1 à {CLIENT_BELL_MAX_DAYS} jours ; par défaut{' '}
          {CLIENT_BELL_DEFAULT_DAYS}.
        </p>
        {error && (
          <p id="windowDays-error" role="alert" className="mt-1 text-sm text-destructive">
            {error}
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-hover disabled:opacity-60"
        >
          {pending ? 'Enregistrement…' : 'Enregistrer'}
        </button>
        <p role="status" className="text-sm text-primary">
          {state?.saved && !pending ? 'Réglage de la cloche enregistré.' : ''}
        </p>
      </div>
    </form>
  )
}
