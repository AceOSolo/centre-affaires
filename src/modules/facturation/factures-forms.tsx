'use client'

import { useActionState, useRef } from 'react'

import Link from 'next/link'

import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import {
  addManualLineAction,
  issueSelectedAction,
  removeDraftLineAction,
  runInvoicingAction,
  updateDraftInvoiceAction,
  updateDraftLineAction,
  type BulkIssueState,
  type InvoiceFormState,
} from './factures-actions.ts'
import {
  draftInvoiceFieldLabels,
  lineEditFieldLabels,
  manualLineFieldLabels,
  vatRateChoices,
} from './factures-formulaire.ts'
import { formatBasisPoints, paymentMethodChoices, paymentMethodLabels } from './factures-labels.ts'

const fieldClass =
  'w-full rounded-sm border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/40 aria-[invalid=true]:border-destructive'
const labelClass = 'block text-sm font-medium text-foreground'
const primaryButton =
  'rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50'
const secondaryButton =
  'rounded-md border border-border bg-white px-4 py-2 text-sm font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50'

function FieldError({ name, error }: { name: string; error?: string }) {
  if (!error) return null
  return (
    <p id={`${name}-error`} role="alert" className="mt-1 text-xs text-destructive">
      {error}
    </p>
  )
}

/** Attributs d'accessibilité d'un champ : son aide, et son erreur s'il en a une. */
function described(errors: Record<string, string>, field: string, hasHint = false) {
  return {
    'aria-invalid': errors[field] ? true : undefined,
    'aria-describedby':
      [hasHint && `${field}-hint`, errors[field] && `${field}-error`].filter(Boolean).join(' ') || undefined,
  }
}

/* -------------------------------------------------------------------------- */
/* Lot de facturation                                                         */
/* -------------------------------------------------------------------------- */

/** Lancement du lot du mois affiché. Le bilan s'affiche sur la page où il mène. */
export function RunInvoicingForm({ month, label }: { month: string; label: string }) {
  const [state, formAction, pending] = useActionState<InvoiceFormState, FormData>(runInvoicingAction, null)
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="mois" value={month} />
      {(state?.error || state?.fieldErrors?.mois) && (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
        >
          {state?.error ?? state?.fieldErrors?.mois}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} aria-describedby="run-hint" className={primaryButton}>
          {pending ? 'Préparation des brouillons…' : `Préparer les brouillons de ${label}`}
        </button>
        <span id="run-hint" className="text-xs text-muted-foreground">
          Rien n’est émis : chaque brouillon se relit, puis s’émet. Relancer le lot ne crée pas de doublon.
        </span>
      </div>
    </form>
  )
}

/* -------------------------------------------------------------------------- */
/* Liste : émission groupée                                                   */
/* -------------------------------------------------------------------------- */

/**
 * La liste des factures, dans un formulaire : les brouillons cochés s'émettent
 * ensemble. Chaque émission est indépendante ; le bilan dit lesquelles ont été
 * refusées et pourquoi.
 */
export function BulkIssueForm({ children, draftCount }: { children: React.ReactNode; draftCount: number }) {
  const [state, formAction, pending] = useActionState<BulkIssueState, FormData>(issueSelectedAction, null)
  const formRef = useRef<HTMLFormElement>(null)

  function toggleAll(checked: boolean) {
    formRef.current
      ?.querySelectorAll<HTMLInputElement>('input[name="ids"]')
      .forEach((input) => {
        input.checked = checked
      })
  }

  return (
    <form ref={formRef} action={formAction} className="flex flex-col gap-3">
      {state?.error && (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
        >
          {state.error}
        </p>
      )}
      {state && !state.error && (
        <div role="status" className="rounded-md border border-primary/20 bg-primary/5 px-4 py-3 text-sm">
          <p>
            {state.issued?.length
              ? `${state.issued.length} facture${state.issued.length > 1 ? 's émises' : ' émise'} : ${state.issued
                  .map((issued) => issued.number)
                  .join(', ')}.`
              : 'Aucune facture émise.'}
          </p>
          {state.refused && state.refused.length > 0 && (
            <>
              <p className="mt-2 font-medium">
                {state.refused.length} refus, à compléter avant d’émettre :
              </p>
              <ul className="mt-1 list-disc pl-5">
                {state.refused.map((refused) => (
                  <li key={refused.id}>
                    <Link href={`/factures/${refused.id}`} className="underline underline-offset-2">
                      {refused.clientName}
                    </Link>{' '}
                    — {refused.message}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      {draftCount > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              onChange={(event) => toggleAll(event.currentTarget.checked)}
              className="size-4 accent-primary"
            />
            Cocher les {draftCount} brouillon{draftCount > 1 ? 's' : ''}
          </label>
          <button type="submit" disabled={pending} className={primaryButton}>
            {pending ? 'Émission…' : 'Émettre les brouillons cochés'}
          </button>
          <span className="text-xs text-muted-foreground">
            Une facture émise reçoit son numéro et ne se modifie plus.
          </span>
        </div>
      )}
      {children}
    </form>
  )
}

/* -------------------------------------------------------------------------- */
/* Brouillon : conditions                                                     */
/* -------------------------------------------------------------------------- */

export type DraftConditionsDefaults = {
  id: string
  periodStart: string
  periodEnd: string
  paymentTermsDays: string
  expectedPaymentMethod: string
  buyerReference: string
  notes: string
}

/** Période, délai, mode de paiement et mentions d'un brouillon. */
export function DraftConditionsForm({
  invoice,
  isCreditNote,
  defaultTermsDays,
  mandateLabel,
}: {
  invoice: DraftConditionsDefaults
  isCreditNote: boolean
  /** Délai du centre, appliqué quand le champ reste vide. */
  defaultTermsDays: number
  /** « RUM … · IBAN •••• 0189 » quand le client a un mandat actif. */
  mandateLabel: string | null
}) {
  const [state, formAction, pending] = useActionState<InvoiceFormState, FormData>(
    updateDraftInvoiceAction,
    null,
  )
  const errors = state?.fieldErrors ?? {}
  const value = (field: keyof DraftConditionsDefaults) => state?.values?.[field] ?? invoice[field]

  return (
    <form
      key={JSON.stringify(state?.values ?? {})}
      action={formAction}
      className="flex flex-col gap-4 rounded-lg border border-border bg-white px-5 py-4"
    >
      <input type="hidden" name="id" value={invoice.id} />
      {isCreditNote && <input type="hidden" name="expectedPaymentMethod" value="transfer" />}
      <ErrorSummary errors={state?.fieldErrors} labels={draftInvoiceFieldLabels} message={state?.error} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label className={labelClass} htmlFor="periodStart">
            {draftInvoiceFieldLabels.periodStart}
          </label>
          <input
            id="periodStart"
            name="periodStart"
            type="date"
            required
            defaultValue={value('periodStart')}
            {...described(errors, 'periodStart')}
            className={`${fieldClass} mt-1`}
          />
          <FieldError name="periodStart" error={errors.periodStart} />
        </div>
        <div>
          <label className={labelClass} htmlFor="periodEnd">
            {draftInvoiceFieldLabels.periodEnd}
          </label>
          <input
            id="periodEnd"
            name="periodEnd"
            type="date"
            required
            defaultValue={value('periodEnd')}
            {...described(errors, 'periodEnd')}
            className={`${fieldClass} mt-1`}
          />
          <FieldError name="periodEnd" error={errors.periodEnd} />
        </div>
        {!isCreditNote && (
          <>
            <div>
              <label className={labelClass} htmlFor="paymentTermsDays">
                {draftInvoiceFieldLabels.paymentTermsDays}{' '}
                <span className="font-normal text-muted-foreground">(jours)</span>
              </label>
              <input
                id="paymentTermsDays"
                name="paymentTermsDays"
                inputMode="numeric"
                defaultValue={value('paymentTermsDays')}
                {...described(errors, 'paymentTermsDays', true)}
                className={`${fieldClass} mt-1 tabular`}
              />
              <p id="paymentTermsDays-hint" className="mt-1 text-xs text-muted-foreground">
                Vide : délai du centre, {defaultTermsDays} jours.
              </p>
              <FieldError name="paymentTermsDays" error={errors.paymentTermsDays} />
            </div>
            <div>
              <label className={labelClass} htmlFor="expectedPaymentMethod">
                {draftInvoiceFieldLabels.expectedPaymentMethod}
              </label>
              <select
                id="expectedPaymentMethod"
                name="expectedPaymentMethod"
                defaultValue={value('expectedPaymentMethod')}
                {...described(errors, 'expectedPaymentMethod', true)}
                className={`${fieldClass} mt-1`}
              >
                {paymentMethodChoices.map((method) => (
                  <option key={method} value={method}>
                    {paymentMethodLabels[method]}
                  </option>
                ))}
              </select>
              <p id="expectedPaymentMethod-hint" className="mt-1 text-xs text-muted-foreground">
                {mandateLabel ? `Mandat actif : ${mandateLabel}.` : 'Aucun mandat de prélèvement actif.'}
              </p>
              <FieldError name="expectedPaymentMethod" error={errors.expectedPaymentMethod} />
            </div>
          </>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className={labelClass} htmlFor="buyerReference">
            {draftInvoiceFieldLabels.buyerReference}{' '}
            <span className="font-normal text-muted-foreground">(facultatif)</span>
          </label>
          <input
            id="buyerReference"
            name="buyerReference"
            defaultValue={value('buyerReference')}
            {...described(errors, 'buyerReference', true)}
            className={`${fieldClass} mt-1`}
          />
          <p id="buyerReference-hint" className="mt-1 text-xs text-muted-foreground">
            Bon de commande ou service du client, repris sur la facture.
          </p>
          <FieldError name="buyerReference" error={errors.buyerReference} />
        </div>
        <div>
          <label className={labelClass} htmlFor="notes">
            {isCreditNote ? 'Motif de l’avoir' : draftInvoiceFieldLabels.notes}{' '}
            {!isCreditNote && <span className="font-normal text-muted-foreground">(facultatif)</span>}
          </label>
          <textarea
            id="notes"
            name="notes"
            rows={2}
            defaultValue={value('notes')}
            {...described(errors, 'notes')}
            className={`${fieldClass} mt-1`}
          />
          <FieldError name="notes" error={errors.notes} />
        </div>
      </div>

      <button type="submit" disabled={pending} className={`${secondaryButton} self-start`}>
        {pending ? 'Enregistrement…' : 'Enregistrer les conditions'}
      </button>
    </form>
  )
}

/* -------------------------------------------------------------------------- */
/* Brouillon : lignes                                                         */
/* -------------------------------------------------------------------------- */

/** Ligne libre ou remise (geste commercial) ajoutée en fin de brouillon. */
export function ManualLineForm({ invoiceId, defaultVatRateBp }: { invoiceId: string; defaultVatRateBp: number }) {
  const [state, formAction, pending] = useActionState<InvoiceFormState, FormData>(addManualLineAction, null)
  const errors = state?.fieldErrors ?? {}
  const value = (field: string, fallback = '') => state?.values?.[field] ?? fallback
  const defaultRate = (vatRateChoices as readonly number[]).includes(defaultVatRateBp)
    ? String(defaultVatRateBp)
    : '2000'

  return (
    <form
      key={JSON.stringify(state?.values ?? {})}
      action={formAction}
      className="flex flex-col gap-4 rounded-lg border border-border bg-white px-5 py-4"
    >
      <input type="hidden" name="id" value={invoiceId} />
      <h3 className="text-sm font-semibold">Ajouter une ligne</h3>
      <ErrorSummary errors={state?.fieldErrors} labels={manualLineFieldLabels} message={state?.error} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
        <div className="lg:col-span-1">
          <label className={labelClass} htmlFor="kind">
            {manualLineFieldLabels.kind}
          </label>
          <select
            id="kind"
            name="kind"
            defaultValue={value('kind', 'other')}
            {...described(errors, 'kind')}
            className={`${fieldClass} mt-1`}
          >
            <option value="other">Prestation</option>
            <option value="discount">Remise</option>
          </select>
          <FieldError name="kind" error={errors.kind} />
        </div>
        <div className="sm:col-span-2 lg:col-span-3">
          <label className={labelClass} htmlFor="description">
            {manualLineFieldLabels.description}
          </label>
          <input
            id="description"
            name="description"
            required
            defaultValue={value('description')}
            {...described(errors, 'description')}
            className={`${fieldClass} mt-1`}
          />
          <FieldError name="description" error={errors.description} />
        </div>
        <div>
          <label className={labelClass} htmlFor="quantity">
            {manualLineFieldLabels.quantity}
          </label>
          <input
            id="quantity"
            name="quantity"
            inputMode="numeric"
            required
            defaultValue={value('quantity', '1')}
            {...described(errors, 'quantity')}
            className={`${fieldClass} mt-1 tabular`}
          />
          <FieldError name="quantity" error={errors.quantity} />
        </div>
        <div>
          <label className={labelClass} htmlFor="unitPrice">
            {manualLineFieldLabels.unitPrice} <span className="font-normal text-muted-foreground">(€)</span>
          </label>
          <input
            id="unitPrice"
            name="unitPrice"
            inputMode="decimal"
            required
            defaultValue={value('unitPrice')}
            {...described(errors, 'unitPrice', true)}
            className={`${fieldClass} mt-1 tabular`}
          />
          <p id="unitPrice-hint" className="mt-1 text-xs text-muted-foreground">
            Une remise se saisit en positif, elle est déduite.
          </p>
          <FieldError name="unitPrice" error={errors.unitPrice} />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
        <div>
          <label className={labelClass} htmlFor="vatRate">
            {manualLineFieldLabels.vatRate}
          </label>
          <select
            id="vatRate"
            name="vatRate"
            defaultValue={value('vatRate', defaultRate)}
            {...described(errors, 'vatRate')}
            className={`${fieldClass} mt-1`}
          >
            {vatRateChoices.map((rate) => (
              <option key={rate} value={rate}>
                {rate === 0 ? 'Exonéré (0 %)' : formatBasisPoints(rate)}
              </option>
            ))}
          </select>
          <FieldError name="vatRate" error={errors.vatRate} />
        </div>
        <div className="sm:col-span-1 lg:col-span-3">
          <label className={labelClass} htmlFor="vatExemptionReason">
            {manualLineFieldLabels.vatExemptionReason}{' '}
            <span className="font-normal text-muted-foreground">(si exonéré)</span>
          </label>
          <input
            id="vatExemptionReason"
            name="vatExemptionReason"
            defaultValue={value('vatExemptionReason')}
            {...described(errors, 'vatExemptionReason')}
            className={`${fieldClass} mt-1`}
          />
          <FieldError name="vatExemptionReason" error={errors.vatExemptionReason} />
        </div>
        <div>
          <label className={labelClass} htmlFor="linePeriodStart">
            {manualLineFieldLabels.linePeriodStart}{' '}
            <span className="font-normal text-muted-foreground">(facultatif)</span>
          </label>
          <input
            id="linePeriodStart"
            name="linePeriodStart"
            type="date"
            defaultValue={value('linePeriodStart')}
            {...described(errors, 'linePeriodStart')}
            className={`${fieldClass} mt-1`}
          />
          <FieldError name="linePeriodStart" error={errors.linePeriodStart} />
        </div>
        <div>
          <label className={labelClass} htmlFor="linePeriodEnd">
            {manualLineFieldLabels.linePeriodEnd}{' '}
            <span className="font-normal text-muted-foreground">(facultatif)</span>
          </label>
          <input
            id="linePeriodEnd"
            name="linePeriodEnd"
            type="date"
            defaultValue={value('linePeriodEnd')}
            {...described(errors, 'linePeriodEnd')}
            className={`${fieldClass} mt-1`}
          />
          <FieldError name="linePeriodEnd" error={errors.linePeriodEnd} />
        </div>
      </div>

      <button type="submit" disabled={pending} className={`${secondaryButton} self-start`}>
        {pending ? 'Ajout…' : 'Ajouter la ligne'}
      </button>
    </form>
  )
}

export type LineEditDefaults = {
  id: string
  lineId: string
  description: string
  quantity: string
  unitPrice: string
  vatExemptionReason: string
}

/** Modification d'une ligne de brouillon. */
export function LineEditForm({
  line,
  priceEditable,
  exemptionEditable,
}: {
  line: LineEditDefaults
  priceEditable: boolean
  exemptionEditable: boolean
}) {
  const [state, formAction, pending] = useActionState<InvoiceFormState, FormData>(updateDraftLineAction, null)
  const errors = state?.fieldErrors ?? {}
  const value = (field: keyof LineEditDefaults) => state?.values?.[field] ?? line[field]

  return (
    <form
      key={JSON.stringify(state?.values ?? {})}
      action={formAction}
      className="flex max-w-3xl flex-col gap-4 rounded-lg border border-border bg-white px-5 py-4"
    >
      <input type="hidden" name="id" value={line.id} />
      <input type="hidden" name="lineId" value={line.lineId} />
      <ErrorSummary errors={state?.fieldErrors} labels={lineEditFieldLabels} message={state?.error} />

      <div>
        <label className={labelClass} htmlFor="description">
          {lineEditFieldLabels.description}
        </label>
        <input
          id="description"
          name="description"
          required
          defaultValue={value('description')}
          {...described(errors, 'description')}
          className={`${fieldClass} mt-1`}
        />
        <FieldError name="description" error={errors.description} />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <label className={labelClass} htmlFor="quantity">
            {lineEditFieldLabels.quantity}
          </label>
          <input
            id="quantity"
            name="quantity"
            inputMode="numeric"
            required
            defaultValue={value('quantity')}
            {...described(errors, 'quantity')}
            className={`${fieldClass} mt-1 tabular`}
          />
          <FieldError name="quantity" error={errors.quantity} />
        </div>
        {priceEditable && (
          <div>
            <label className={labelClass} htmlFor="unitPrice">
              {lineEditFieldLabels.unitPrice} <span className="font-normal text-muted-foreground">(€)</span>
            </label>
            <input
              id="unitPrice"
              name="unitPrice"
              inputMode="decimal"
              required
              defaultValue={value('unitPrice')}
              {...described(errors, 'unitPrice')}
              className={`${fieldClass} mt-1 tabular`}
            />
            <FieldError name="unitPrice" error={errors.unitPrice} />
          </div>
        )}
      </div>

      {exemptionEditable && (
        <div>
          <label className={labelClass} htmlFor="vatExemptionReason">
            {lineEditFieldLabels.vatExemptionReason}
          </label>
          <input
            id="vatExemptionReason"
            name="vatExemptionReason"
            defaultValue={value('vatExemptionReason')}
            {...described(errors, 'vatExemptionReason')}
            className={`${fieldClass} mt-1`}
          />
          <FieldError name="vatExemptionReason" error={errors.vatExemptionReason} />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={primaryButton}>
          {pending ? 'Enregistrement…' : 'Enregistrer la ligne'}
        </button>
        <Link href={`/factures/${line.id}#lignes`} className={secondaryButton}>
          Annuler
        </Link>
      </div>
    </form>
  )
}

/** Retrait d'une ligne de brouillon ; sa source redevient facturable. */
export function RemoveLineButton({
  invoiceId,
  lineId,
  description,
}: {
  invoiceId: string
  lineId: string
  description: string
}) {
  const [state, formAction, pending] = useActionState<InvoiceFormState, FormData>(removeDraftLineAction, null)
  return (
    <form action={formAction} className="inline">
      <input type="hidden" name="id" value={invoiceId} />
      <input type="hidden" name="lineId" value={lineId} />
      <button
        type="submit"
        disabled={pending}
        aria-label={`Retirer la ligne « ${description} »`}
        className="rounded-md px-2 py-1 text-xs font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
      >
        {pending ? 'Retrait…' : 'Retirer'}
      </button>
      {state?.error && (
        <span role="alert" className="block text-xs text-destructive">
          {state.error}
        </span>
      )}
    </form>
  )
}
