'use client'

import { useActionState } from 'react'

import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import { FlashNotice } from '../../components/ui/flash-notice.tsx'
import { createMandateAction, type MandateFormState } from './mandats-actions.ts'
import { mandateFieldLabels } from './reglements-labels.ts'

const fieldClass =
  'w-full rounded-sm border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/40 aria-[invalid=true]:border-destructive'
const labelClass = 'block text-sm font-medium text-foreground'

/**
 * Enregistrement d'un mandat de prélèvement SEPA signé (R16, ADR 027).
 *
 * L'IBAN n'est jamais prérempli ni renvoyé par le serveur : après un refus,
 * il se ressaisit ; après l'enregistrement, l'écran n'en montre plus que les
 * quatre derniers caractères.
 */
export function MandateForm({
  clientId,
  defaultDebtorName,
  today,
}: {
  clientId: string
  defaultDebtorName: string
  today: string
}) {
  const [state, formAction, pending] = useActionState<MandateFormState, FormData>(createMandateAction, null)
  const values = state?.values ?? { debtorName: defaultDebtorName, bic: '', signedOn: '', sequenceType: 'recurrent' }
  const errors = state?.fieldErrors ?? {}

  return (
    <div className="flex flex-col gap-4">
      {state?.created && (
        <FlashNotice key={state.created}>
          Mandat enregistré sous la référence <span className="font-medium tabular">{state.created}</span>.
          Reportez-la sur le mandat signé et communiquez-la au client : elle figurera sur ses relevés.
        </FlashNotice>
      )}
      <form
        key={JSON.stringify(state ?? '')}
        action={formAction}
        noValidate
        autoComplete="off"
        className="flex flex-col gap-4"
      >
        <input type="hidden" name="clientId" value={clientId} />
        <ErrorSummary errors={state?.fieldErrors} labels={mandateFieldLabels} message={state?.message} />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Titulaire du compte" name="debtorName" error={errors.debtorName} hint="Tel qu’il figure sur le mandat signé.">
            <input
              id="debtorName"
              name="debtorName"
              maxLength={70}
              defaultValue={values.debtorName}
              aria-invalid={errors.debtorName ? true : undefined}
              aria-describedby={errors.debtorName ? 'debtorName-error debtorName-hint' : 'debtorName-hint'}
              className={`${fieldClass} mt-1`}
            />
          </Field>
          <Field
            label="IBAN"
            name="iban"
            error={errors.iban}
            hint="Chiffré dès l’enregistrement : seuls ses quatre derniers caractères restent affichés."
          >
            <input
              id="iban"
              name="iban"
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="characters"
              aria-invalid={errors.iban ? true : undefined}
              aria-describedby={errors.iban ? 'iban-error iban-hint' : 'iban-hint'}
              className={`${fieldClass} mt-1 tabular uppercase`}
            />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="BIC" optional name="bic" error={errors.bic} hint="Facultatif pour un compte de la zone SEPA.">
            <input
              id="bic"
              name="bic"
              maxLength={11}
              spellCheck={false}
              autoCapitalize="characters"
              defaultValue={values.bic}
              aria-invalid={errors.bic ? true : undefined}
              aria-describedby={errors.bic ? 'bic-error bic-hint' : 'bic-hint'}
              className={`${fieldClass} mt-1 uppercase`}
            />
          </Field>
          <Field label="Date de signature" name="signedOn" error={errors.signedOn}>
            <input
              id="signedOn"
              name="signedOn"
              type="date"
              max={today}
              defaultValue={values.signedOn}
              aria-invalid={errors.signedOn ? true : undefined}
              aria-describedby={errors.signedOn ? 'signedOn-error' : undefined}
              className={`${fieldClass} mt-1`}
            />
          </Field>
          <fieldset>
            <legend className={labelClass}>Type de mandat</legend>
            <div id="sequenceType" className="mt-2 flex flex-col gap-1">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="sequenceType"
                  value="recurrent"
                  defaultChecked={values.sequenceType !== 'one_off'}
                  className="size-4 accent-primary"
                />
                Récurrent
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="sequenceType"
                  value="one_off"
                  defaultChecked={values.sequenceType === 'one_off'}
                  className="size-4 accent-primary"
                />
                Ponctuel (un seul prélèvement)
              </label>
            </div>
            {errors.sequenceType && (
              <p role="alert" className="mt-1 text-xs text-destructive">
                {errors.sequenceType}
              </p>
            )}
          </fieldset>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={pending}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white transition-colors duration-150 ease-out hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
          >
            {pending ? 'Enregistrement…' : 'Enregistrer le mandat'}
          </button>
          <span aria-live="polite" className="sr-only">
            {pending ? 'Enregistrement en cours' : ''}
          </span>
        </div>
      </form>
    </div>
  )
}

function Field({
  label,
  name,
  hint,
  error,
  optional = false,
  children,
}: {
  label: string
  name: string
  hint?: string
  error?: string
  optional?: boolean
  children: React.ReactNode
}) {
  return (
    <div>
      <label className={labelClass} htmlFor={name}>
        {label}
        {optional && <span className="font-normal text-muted-foreground"> (facultatif)</span>}
      </label>
      {children}
      {error && (
        <p id={`${name}-error`} className="mt-1 text-xs text-destructive">
          {error}
        </p>
      )}
      {hint && (
        <p id={`${name}-hint`} className="mt-1 text-xs text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  )
}
