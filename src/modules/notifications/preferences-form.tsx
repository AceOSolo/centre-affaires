'use client'

import { useActionState, useId } from 'react'

import { notificationCategoryDescriptions, notificationCategoryLabels } from './catalogue.ts'
import { savePreferencesAction, type PreferencesFormState } from './preferences-actions.ts'
import type { PreferenceGroup } from './preferences-groupes.ts'
import type { NotificationCategory } from './schema.ts'

/**
 * Préférences de messages d'une personne, pour une entreprise de son espace
 * (R26, ADR 038), rangées par service utilisé (ADR 077) : un groupe titré par
 * service — Courrier, Réservations… —, et seulement ceux que l'entreprise
 * utilise (`visiblePreferenceGroups`, calculé par la page).
 *
 * Chaque case montrée est déclarée dans un champ caché (`categorie`) : l'action
 * n'enregistre qu'elles, les groupes cachés gardent leur réglage.
 *
 * Mobile d'abord : chaque case est une ligne entière, cible de 44 px au moins,
 * et le libellé est cliquable. Le composant ne charge pas le schéma de la
 * base : les groupes lui arrivent de la page.
 */
export function PreferencesForm({
  clientId,
  clientName,
  showClientName,
  groups,
  enabled,
}: {
  clientId: string
  clientName: string
  /** Plusieurs entreprises dans l'espace : le titre les distingue. */
  showClientName: boolean
  groups: readonly PreferenceGroup[]
  enabled: Record<NotificationCategory, boolean>
}) {
  const [state, formAction, pending] = useActionState<PreferencesFormState, FormData>(savePreferencesAction, null)
  const id = useId()

  return (
    <form action={formAction} className="rounded-2xl border border-border bg-white px-4 py-4 sm:px-6 sm:py-5">
      <input type="hidden" name="clientId" value={clientId} />
      {showClientName && <h2 className="text-lg font-semibold tracking-tight text-primary">{clientName}</h2>}
      {state?.error && (
        <p
          role="alert"
          className="mb-4 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
        >
          {state.error}
        </p>
      )}
      <div className="flex flex-col gap-5">
        {groups.map((group) => (
          <fieldset key={group.key} className="border-t border-border pt-4 first:border-t-0 first:pt-0">
            <legend className="float-left w-full text-base font-semibold tracking-tight text-foreground">
              {group.title}
            </legend>
            <p className="clear-both pt-1 text-sm text-muted-foreground">{group.description}</p>
            <ul className="mt-2 flex flex-col gap-1">
              {group.categories.map((category) => {
                const inputId = `${id}-${category}`
                return (
                  <li key={category}>
                    <input type="hidden" name="categorie" value={category} />
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
        ))}
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex min-h-11 items-center rounded-xl bg-primary px-5 text-sm font-medium text-white transition-colors hover:bg-primary-hover disabled:opacity-60"
        >
          {pending ? 'Enregistrement…' : 'Enregistrer mes choix'}
        </button>
        <p role="status" className="text-sm text-primary">
          {state?.saved && !pending ? 'Préférences enregistrées.' : ''}
        </p>
      </div>
    </form>
  )
}
