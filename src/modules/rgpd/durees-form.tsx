'use client'

import { useActionState } from 'react'

import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import { saveRetentionDurationsAction, type RetentionFormState } from './actions.ts'
import {
  formatRetentionMonths,
  RETENTION_MAX_MONTHS,
  RETENTION_MIN_MONTHS,
  retentionDurations,
  retentionGroupLabels,
  retentionLabels,
  type RetentionGroup,
  type RetentionKey,
} from './durees.ts'

const fieldClass =
  'w-24 rounded-sm border border-border bg-white px-3 py-2 text-sm tabular outline-none focus:border-accent focus:ring-2 focus:ring-accent/40 aria-[invalid=true]:border-destructive'

const groups = [...new Set(retentionDurations.map((duration) => duration.group))] as RetentionGroup[]

/**
 * Durées de conservation du centre (R29) : une durée par type de donnée, en
 * mois, chacune avec son départ, son effet au terme et son statut. Un seul
 * formulaire : les durées se relisent ensemble.
 *
 * Raccourcir une durée efface dès la nuit suivante ce qui la dépasse : le
 * formulaire le fait confirmer, case à cocher à l'appui, avant d'écrire.
 */
export function RetentionDurationsForm({ values }: { values: Record<RetentionKey, string> }) {
  const [state, formAction, pending] = useActionState<RetentionFormState, FormData>(
    saveRetentionDurationsAction,
    null,
  )
  const value = (key: RetentionKey) => state?.values?.[key] ?? values[key]
  const confirm = state?.confirmShortening ?? []
  const saved = state?.saved && !pending ? state.saved : undefined

  return (
    <form
      // Remonté après chaque réponse pour reprendre la saisie, que React
      // efface à la fin de l'envoi.
      key={JSON.stringify(state?.values ?? values)}
      action={formAction}
      className="mt-4 flex flex-col gap-5"
    >
      <ErrorSummary errors={state?.fieldErrors} labels={retentionLabels} message={state?.error} />

      {groups.map((group) => (
        <fieldset key={group} className="flex flex-col gap-3">
          <legend className="text-sm font-semibold tracking-tight">{retentionGroupLabels[group]}</legend>
          {retentionDurations
            .filter((duration) => duration.group === group)
            .map((duration) => {
              const error = state?.fieldErrors?.[duration.key]
              const current = Number(values[duration.key])
              return (
                <div
                  key={duration.key}
                  className="grid gap-x-4 gap-y-1 border-t border-border pt-3 sm:grid-cols-[16rem_1fr]"
                >
                  <div>
                    <label htmlFor={duration.key} className="block text-sm font-medium text-foreground">
                      {duration.label}
                    </label>
                    <div className="mt-1 flex items-center gap-2">
                      <input
                        id={duration.key}
                        name={duration.key}
                        inputMode="numeric"
                        autoComplete="off"
                        defaultValue={value(duration.key)}
                        aria-invalid={error ? true : undefined}
                        aria-describedby={`${duration.key}-hint${error ? ` ${duration.key}-error` : ''}`}
                        className={fieldClass}
                      />
                      <span className="text-sm text-muted-foreground">mois</span>
                    </div>
                    {error && (
                      <p id={`${duration.key}-error`} role="alert" className="mt-1 text-xs text-destructive">
                        {error}
                      </p>
                    )}
                  </div>
                  <div id={`${duration.key}-hint`} className="text-xs text-muted-foreground">
                    <p>
                      <span className="font-medium text-foreground">Départ.</span> {duration.start}
                    </p>
                    <p className="mt-1">
                      <span className="font-medium text-foreground">Au terme.</span> {duration.effect}
                    </p>
                    <p className="mt-1">
                      Enregistrée : {Number.isFinite(current) ? formatRetentionMonths(current) : '—'}. Par
                      défaut : {formatRetentionMonths(duration.defaultMonths)}. De {RETENTION_MIN_MONTHS} à{' '}
                      {RETENTION_MAX_MONTHS} mois. Durée {duration.status}.
                    </p>
                  </div>
                </div>
              )
            })}
        </fieldset>
      ))}

      {confirm.length > 0 && (
        <div
          role="alert"
          className="rounded-md border border-statut-conflit/40 bg-white px-4 py-3 text-sm"
        >
          <p className="font-medium">Ces durées raccourcissent :</p>
          <ul className="mt-1 list-disc pl-5">
            {confirm.map((key) => (
              <li key={key}>
                {retentionLabels[key]} : {formatRetentionMonths(Number(values[key]))} →{' '}
                {formatRetentionMonths(Number(state?.values?.[key]))}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-muted-foreground">
            Dès la tâche de nuit suivante, ce qui dépasse la nouvelle durée est effacé ou anonymisé,
            données déjà présentes comprises. Rien ne se rétablit ensuite, hors restauration d’une
            sauvegarde.
          </p>
          <div className="mt-3 flex items-start gap-2">
            <input id="confirmShortening" name="confirmShortening" type="checkbox" className="mt-1" />
            <label htmlFor="confirmShortening" className="font-medium">
              Je confirme ces durées plus courtes.
            </label>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50"
        >
          {pending ? 'Enregistrement…' : 'Enregistrer les durées'}
        </button>
        <p role="status" className="text-sm text-primary">
          {saved
            ? saved.shortened.length > 0
              ? `Enregistré. Les durées raccourcies s’appliquent dès la nuit prochaine : ${saved.shortened
                  .map((key) => retentionLabels[key])
                  .join(', ')}.`
              : 'Enregistré.'
            : ''}
        </p>
      </div>
    </form>
  )
}
