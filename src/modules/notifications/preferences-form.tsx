'use client'

import { useActionState, useId } from 'react'

import { notificationCategoryDescriptions, notificationCategoryLabels } from './catalogue.ts'
import { savePreferencesAction, type PreferencesFormState } from './preferences-actions.ts'
import type { NotificationCategory } from './schema.ts'

// Les catégories suivent les libellés : le composant client n'a pas à charger
// le schéma de la base pour les connaître.
const categories = Object.keys(notificationCategoryLabels) as NotificationCategory[]

/**
 * Préférences de messages d'une personne, pour une entreprise de son espace
 * (R26, ADR 038). Mobile d'abord : chaque case est une ligne entière, cible de
 * 44 px au moins, et le libellé est cliquable.
 */
export function PreferencesForm({
  clientId,
  clientName,
  showClientName,
  enabled,
}: {
  clientId: string
  clientName: string
  /** Plusieurs entreprises dans l'espace : la légende les distingue. */
  showClientName: boolean
  enabled: Record<NotificationCategory, boolean>
}) {
  const [state, formAction, pending] = useActionState<PreferencesFormState, FormData>(savePreferencesAction, null)
  const id = useId()

  return (
    <form action={formAction} className="rounded-lg border border-border bg-white px-4 py-4 sm:px-5">
      <input type="hidden" name="clientId" value={clientId} />
      {state?.error && (
        <p
          role="alert"
          className="mb-4 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
        >
          {state.error}
        </p>
      )}
      <fieldset>
        <legend className="text-base font-semibold tracking-tight">
          {showClientName ? `Messages pour ${clientName}` : 'Messages que je reçois'}
        </legend>
        <p className="mt-1 text-sm text-muted-foreground">Cochez ce que vous souhaitez recevoir par courriel.</p>
        <ul className="mt-3 flex flex-col gap-2">
          {categories.map((category) => {
            const inputId = `${id}-${category}`
            return (
              <li key={category}>
                <label
                  htmlFor={inputId}
                  className="flex min-h-11 cursor-pointer items-start gap-3 rounded-md px-2 py-2.5 hover:bg-muted"
                >
                  <input
                    id={inputId}
                    name={category}
                    type="checkbox"
                    defaultChecked={enabled[category]}
                    aria-describedby={`${inputId}-hint`}
                    className="mt-0.5 size-5 shrink-0 accent-primary"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{notificationCategoryLabels[category]}</span>
                    <span id={`${inputId}-hint`} className="block text-sm text-muted-foreground">
                      {notificationCategoryDescriptions[category]}
                    </span>
                  </span>
                </label>
              </li>
            )
          })}
        </ul>
      </fieldset>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex min-h-11 items-center rounded-md bg-primary px-5 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-60"
        >
          {pending ? 'Enregistrement…' : 'Enregistrer mes préférences'}
        </button>
        <p role="status" className="text-sm text-primary">
          {state?.saved && !pending ? 'Préférences enregistrées.' : ''}
        </p>
      </div>
    </form>
  )
}
