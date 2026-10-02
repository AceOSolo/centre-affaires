'use client'

import { useActionState } from 'react'

import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import type { PaymentMethod } from '../../db/tenants.ts'
import { centsToInput, paymentFieldLabels, type PaymentFormValues } from './paiements-regles.ts'
import { recordPaymentAction, type PaymentFormState } from './reglements-actions.ts'
import { paymentMethodLabels } from './reglements-labels.ts'

const fieldClass =
  'w-full rounded-sm border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/40 aria-[invalid=true]:border-destructive'
const labelClass = 'block text-sm font-medium text-foreground'

/**
 * Pointage d'un paiement reçu sur une facture émise (R16, ADR 027) : montant,
 * date de valeur, mode, référence bancaire. Un remboursement se pointe ici
 * aussi, en choisissant sa nature : jamais de signe moins à saisir.
 */
export function PaymentForm({
  invoiceId,
  defaultMethod,
  amountDueCents,
  today,
}: {
  invoiceId: string
  defaultMethod: PaymentMethod
  amountDueCents: number
  /** Jour du centre : date par défaut et date au plus tard. */
  today: string
}) {
  const [state, formAction, pending] = useActionState<PaymentFormState, FormData>(recordPaymentAction, null)
  const values: PaymentFormValues = state?.values ?? {
    direction: 'payment',
    amount: amountDueCents > 0 ? centsToInput(amountDueCents) : '',
    paidOn: today,
    method: defaultMethod,
    reference: '',
    notes: '',
    overpaymentConfirmed: false,
  }
  const errors = state?.fieldErrors ?? {}

  return (
    <form
      // Remonté après chaque refus : React réinitialise un formulaire à la fin
      // de l'envoi, la clé le recrée avec les valeurs saisies.
      key={JSON.stringify(state?.values ?? '')}
      action={formAction}
      noValidate
      className="flex flex-col gap-4"
    >
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <ErrorSummary errors={state?.fieldErrors} labels={paymentFieldLabels} message={state?.message} />

      <fieldset className="flex flex-col gap-2">
        <legend className={labelClass}>Nature</legend>
        <div id="direction" className="flex flex-wrap gap-x-6 gap-y-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="direction"
              value="payment"
              defaultChecked={values.direction !== 'refund'}
              className="size-4 accent-primary"
            />
            Paiement reçu
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="direction"
              value="refund"
              defaultChecked={values.direction === 'refund'}
              className="size-4 accent-primary"
            />
            Remboursement au client
          </label>
        </div>
        {errors.direction && (
          <p role="alert" className="text-xs text-destructive">
            {errors.direction}
          </p>
        )}
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Montant (€)" name="amount" error={errors.amount} hint="Exemple : 120,00">
          <input
            id="amount"
            name="amount"
            inputMode="decimal"
            autoComplete="off"
            defaultValue={values.amount}
            aria-invalid={errors.amount ? true : undefined}
            aria-describedby={errors.amount ? 'amount-error amount-hint' : 'amount-hint'}
            className={`${fieldClass} mt-1 tabular`}
          />
        </Field>
        <Field label="Date de valeur" name="paidOn" error={errors.paidOn} hint="Le jour où l’argent est arrivé.">
          <input
            id="paidOn"
            name="paidOn"
            type="date"
            max={today}
            defaultValue={values.paidOn}
            aria-invalid={errors.paidOn ? true : undefined}
            aria-describedby={errors.paidOn ? 'paidOn-error paidOn-hint' : 'paidOn-hint'}
            className={`${fieldClass} mt-1`}
          />
        </Field>
        <Field label="Mode" name="method" error={errors.method}>
          <select
            id="method"
            name="method"
            defaultValue={values.method}
            aria-invalid={errors.method ? true : undefined}
            aria-describedby={errors.method ? 'method-error' : undefined}
            className={`${fieldClass} mt-1`}
          >
            {(Object.keys(paymentMethodLabels) as PaymentMethod[]).map((method) => (
              <option key={method} value={method}>
                {paymentMethodLabels[method]}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Field
        label="Référence"
        optional
        name="reference"
        error={errors.reference}
        hint="Libellé du virement, numéro de chèque ou de remise : ce qui permet de le retrouver sur le relevé."
      >
        <input
          id="reference"
          name="reference"
          autoComplete="off"
          maxLength={140}
          defaultValue={values.reference}
          aria-invalid={errors.reference ? true : undefined}
          aria-describedby={errors.reference ? 'reference-error reference-hint' : 'reference-hint'}
          className={`${fieldClass} mt-1`}
        />
      </Field>

      <Field label="Notes" optional name="notes" error={errors.notes}>
        <textarea
          id="notes"
          name="notes"
          rows={2}
          maxLength={2000}
          defaultValue={values.notes}
          aria-invalid={errors.notes ? true : undefined}
          aria-describedby={errors.notes ? 'notes-error' : undefined}
          className={`${fieldClass} mt-1`}
        />
      </Field>

      <div className="flex items-start gap-3">
        <input
          id="overpaymentConfirmed"
          name="overpaymentConfirmed"
          type="checkbox"
          defaultChecked={values.overpaymentConfirmed}
          aria-describedby="overpaymentConfirmed-hint"
          className="mt-0.5 size-5 shrink-0 accent-primary"
        />
        <div>
          <label htmlFor="overpaymentConfirmed" className="text-sm font-medium text-foreground">
            Trop-perçu
          </label>
          <p id="overpaymentConfirmed-hint" className="text-xs text-muted-foreground">
            À cocher seulement si le client a versé plus que le reste dû : le surplus sera à lui rembourser.
          </p>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white transition-colors duration-150 ease-out hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
        >
          {pending ? 'Enregistrement…' : 'Pointer le paiement'}
        </button>
        <span aria-live="polite" className="sr-only">
          {pending ? 'Enregistrement en cours' : ''}
        </span>
      </div>
    </form>
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
      {/* L'`id` du champ est son nom : c'est la cible du lien du résumé d'erreurs. */}
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
