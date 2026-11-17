'use client'

import { useActionState } from 'react'

import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import { CheckIcon } from '../../components/ui/icons.tsx'
import { saveExpenseSettingsAction, type ExpenseSettingsFormState } from './depenses-actions.ts'
import {
  DEFAULT_EXPENSE_NOTE,
  EXPENSE_NOTE_MAX_LENGTH,
  expenseHistoryChoices,
  expenseSettingsLabels,
  type ExpenseSettings,
} from './depenses-reglages.ts'

const focus = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
const fieldClass =
  'w-full rounded-sm border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/40 aria-[invalid=true]:border-destructive'
const labelClass = 'block text-sm font-medium text-foreground'
const helpClass = 'mt-1 text-xs text-muted-foreground'
const primaryButton = `rounded-md bg-primary px-4 py-2 text-sm font-medium text-white transition-colors duration-150 ease-out hover:bg-primary-hover disabled:opacity-50 ${focus}`

/**
 * Réglages de « Mes dépenses » dans l'espace client (ADR 081) : les montrer
 * ou non, estimer ou non les actes du courrier, combien de mois passés, et la
 * phrase sous le total. Aucun champ obligatoire : une case se coche ou non,
 * la durée se choisit dans une liste, la phrase vide revient à celle par
 * défaut.
 */
export function ExpenseSettingsForm({ settings }: { settings: ExpenseSettings }) {
  const [state, formAction, pending] = useActionState<ExpenseSettingsFormState, FormData>(
    saveExpenseSettingsAction,
    null,
  )
  const values = state?.values
  const checked = (name: 'showExpenses' | 'estimateMailActs') => (values ? values[name] === 'on' : settings[name])
  const monthsError = state?.fieldErrors?.historyMonths
  const noteError = state?.fieldErrors?.note

  return (
    <div className="flex flex-col gap-3">
      <form
        // Remonté après chaque réponse pour reprendre la saisie, que React efface à la fin de l'envoi.
        key={JSON.stringify(values ?? settings)}
        action={formAction}
        className="flex flex-col gap-5"
        noValidate
      >
        <ErrorSummary
          errors={state?.fieldErrors as Record<string, string> | undefined}
          labels={expenseSettingsLabels}
          message={state?.error}
        />

        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">Ce que l’espace client montre</legend>
          {(
            [
              {
                name: 'showExpenses',
                label: 'Montrer aux clients leurs dépenses du mois',
                help: 'Frais fixes de leurs contrats et prestations du mois, avec un total estimé. Décoché, la page ne montre que les factures reçues du CRM.',
              },
              {
                name: 'estimateMailActs',
                label: 'Estimer les actes du courrier',
                help: 'Ouvertures, numérisations, réexpéditions et pages en plus, au prix du forfait du client, sinon au tarif du centre reçu du CRM : le prix déjà annoncé avant chaque demande. Décoché, ils sont comptés sans montant, « chiffrés sur la facture ».',
              },
            ] as const
          ).map((option) => (
            <div key={option.name} className="flex gap-3 rounded-lg border border-border bg-white px-4 py-3">
              {/* Le label agrandit la cible au-delà des 24 px demandés. */}
              <label htmlFor={option.name} className="inline-flex size-8 shrink-0 cursor-pointer items-center justify-center">
                <input
                  id={option.name}
                  name={option.name}
                  type="checkbox"
                  defaultChecked={checked(option.name)}
                  aria-describedby={`${option.name}-aide`}
                  className={`size-4 accent-primary ${focus}`}
                />
              </label>
              <div className="min-w-0">
                <label htmlFor={option.name} className="text-sm font-medium">
                  {option.label}
                </label>
                <p id={`${option.name}-aide`} className="mt-0.5 text-sm text-muted-foreground">
                  {option.help}
                </p>
              </div>
            </div>
          ))}
        </fieldset>

        <div className="max-w-xs">
          <label htmlFor="historyMonths" className={labelClass}>
            {expenseSettingsLabels.historyMonths}
          </label>
          <select
            id="historyMonths"
            name="historyMonths"
            defaultValue={values?.historyMonths ?? String(settings.historyMonths)}
            aria-invalid={monthsError ? true : undefined}
            aria-describedby={['historyMonths-aide', monthsError ? 'historyMonths-erreur' : ''].filter(Boolean).join(' ')}
            className={`${fieldClass} mt-1`}
          >
            {expenseHistoryChoices.map((months) => (
              <option key={months} value={months}>
                {months} mois
              </option>
            ))}
          </select>
          <p id="historyMonths-aide" className={helpClass}>
            En plus du mois en cours. Les factures, elles, restent toutes visibles.
          </p>
          {monthsError && (
            <p id="historyMonths-erreur" role="alert" className="mt-1 text-xs text-destructive">
              {monthsError}
            </p>
          )}
        </div>

        <div className="max-w-xl">
          <label htmlFor="note" className={labelClass}>
            {expenseSettingsLabels.note}
          </label>
          <input
            id="note"
            name="note"
            type="text"
            maxLength={EXPENSE_NOTE_MAX_LENGTH}
            defaultValue={values?.note ?? (settings.customNote ? settings.note : '')}
            placeholder={DEFAULT_EXPENSE_NOTE}
            aria-invalid={noteError ? true : undefined}
            aria-describedby={['note-aide', noteError ? 'note-erreur' : ''].filter(Boolean).join(' ')}
            className={`${fieldClass} mt-1`}
          />
          <p id="note-aide" className={helpClass}>
            Ce que le client lit sous le total estimé : quand le centre facture, et comment. Vide : « {DEFAULT_EXPENSE_NOTE} »
          </p>
          {noteError && (
            <p id="note-erreur" role="alert" className="mt-1 text-xs text-destructive">
              {noteError}
            </p>
          )}
        </div>

        <div>
          <button type="submit" disabled={pending} className={primaryButton}>
            {pending ? 'Enregistrement…' : 'Enregistrer'}
          </button>
        </div>
      </form>
      <p aria-live="polite" className="text-sm empty:hidden">
        {state?.ok && !pending && (
          <span className="inline-flex items-start gap-1.5 text-primary">
            <CheckIcon size={20} className="shrink-0" />
            {state.ok}
          </span>
        )}
      </p>
    </div>
  )
}
