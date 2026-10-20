'use client'

import { useActionState, useId, useState } from 'react'

import Link from 'next/link'

import { ConfirmDialog } from '../../components/ui/confirm-dialog.tsx'
import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import {
  FieldError,
  FieldHint,
  PendingAnnouncement,
  describedBy,
  fieldClass,
  labelClass,
  primaryButtonClass,
  secondaryButtonClass,
} from './champs.tsx'
import { rateUnitLabels } from './labels.ts'
import {
  cancelProposalAction,
  saveProposalLineAction,
  saveProposalNoteAction,
  type LineFormState,
  type NoteFormState,
  type ProposalActionState,
} from './propositions-actions.ts'
import {
  MAX_CANCEL_REASON_LENGTH,
  MAX_LINE_DESCRIPTION_LENGTH,
  MAX_LINE_LABEL_LENGTH,
  MAX_NOTE_LENGTH,
  lineFieldLabels,
  parseManualLine,
  parseServiceLine,
  type CatalogueService,
  type LineFormErrors,
  type LineFormValues,
} from './propositions-ecran.ts'
import { lineAmountCents } from './propositions.ts'
import type { RateUnit } from './schema.ts'
import { formatBasisPoints, formatCents } from './tarifs.ts'

/**
 * Formulaires de la fiche d'un devis (ADR 043), au back-office.
 *
 * React 19 vide les champs non contrôlés après chaque envoi : les champs
 * sont donc contrôlés, et repartent de la saisie que l'action renvoie après
 * un refus (formulaire remonté par sa `key`).
 */

const rateUnitValues = Object.keys(rateUnitLabels) as RateUnit[]

// --- Ligne ------------------------------------------------------------------

export function ProposalLineForm({
  proposalId,
  services,
  currency,
  defaultVatRate,
  editing,
}: {
  proposalId: string
  services: readonly CatalogueService[]
  currency: string
  /** TVA du centre, au format de saisie (« 20 »), proposée pour une ligne saisie. */
  defaultVatRate: string
  /** Ligne modifiée ; absente pour un ajout. */
  editing?: { lineId: string; label: string; values: LineFormValues }
}) {
  const [state, formAction, pending] = useActionState<LineFormState, FormData>(saveProposalLineAction, null)
  const initial: LineFormValues = state?.values ??
    editing?.values ?? {
      mode: services.length > 0 ? 'service' : 'manual',
      serviceId: '',
      label: '',
      description: '',
      unit: 'unit',
      quantity: '1',
      unitPrice: '',
      vatRate: defaultVatRate,
      discountPercent: '',
      discountAmount: '',
    }

  return (
    <form action={formAction} noValidate className="flex flex-col gap-4">
      <input type="hidden" name="proposalId" value={proposalId} />
      {editing && <input type="hidden" name="lineId" value={editing.lineId} />}

      <ErrorSummary
        errors={state?.fieldErrors as Record<string, string> | undefined}
        labels={lineFieldLabels}
        message={state?.message}
      />

      <LineFields
        key={JSON.stringify(state?.values ?? '')}
        initial={initial}
        errors={state?.fieldErrors ?? {}}
        services={services}
        currency={currency}
        editing={Boolean(editing)}
      />

      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending} className={primaryButtonClass}>
          {pending ? 'Enregistrement…' : editing ? 'Enregistrer la ligne' : 'Ajouter la ligne'}
        </button>
        {editing && (
          <Link href={`/devis/${proposalId}#lignes`} className="text-sm text-muted-foreground underline-offset-2 hover:underline">
            Annuler la modification
          </Link>
        )}
        <PendingAnnouncement pending={pending} label="Enregistrement de la ligne en cours" />
      </div>
    </form>
  )
}

function LineFields({
  initial,
  errors,
  services,
  currency,
  editing,
}: {
  initial: LineFormValues
  errors: LineFormErrors
  services: readonly CatalogueService[]
  currency: string
  editing: boolean
}) {
  const [values, setValues] = useState<LineFormValues>(initial)
  const set = <K extends keyof LineFormValues>(key: K, value: LineFormValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }))
  const fromService = !editing && values.mode === 'service'
  const service = fromService ? services.find((candidate) => candidate.id === values.serviceId) : undefined

  // Aperçu : le même calcul que la base (règle d'arrondi de l'ADR 023).
  const preview = fromService ? parseServiceLine(values, service).line : parseManualLine(values).line

  return (
    <>
      {!editing && (
        <fieldset id="mode" tabIndex={-1}>
          <legend className={labelClass}>Type de ligne</legend>
          <div className="mt-2 flex flex-wrap gap-x-6 gap-y-2">
            {(
              [
                ['service', 'Service du catalogue'],
                ['manual', 'Saisie libre'],
              ] as const
            ).map(([mode, label]) => (
              <div key={mode} className="flex items-center gap-2">
                <input
                  id={`mode-${mode}`}
                  type="radio"
                  name="mode"
                  value={mode}
                  checked={values.mode === mode}
                  onChange={() => set('mode', mode)}
                  className="size-4 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                />
                <label htmlFor={`mode-${mode}`} className="text-sm">
                  {label}
                </label>
              </div>
            ))}
          </div>
        </fieldset>
      )}

      {fromService ? (
        <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
          <div>
            <label className={labelClass} htmlFor="serviceId">
              Service du catalogue
            </label>
            <select
              id="serviceId"
              name="serviceId"
              value={values.serviceId}
              onChange={(event) => set('serviceId', event.target.value)}
              {...describedBy('serviceId', errors.serviceId, true)}
              className={`${fieldClass} mt-1`}
            >
              <option value="">Choisir un service…</option>
              {services.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name} — {formatCents(candidate.unitPriceCents, currency)} HT ({rateUnitLabels[candidate.unit].toLowerCase()})
                </option>
              ))}
            </select>
            <FieldError name="serviceId" error={errors.serviceId} />
            <FieldHint name="serviceId">
              {services.length === 0
                ? 'Aucun service proposé au catalogue : saisissez la ligne librement.'
                : 'Désignation, prix et TVA sont copiés du service : le changer ensuite ne change pas ce devis.'}
            </FieldHint>
          </div>
          <QuantityField value={values.quantity} error={errors.quantity} onChange={(value) => set('quantity', value)} />
        </div>
      ) : (
        <>
          <div>
            <label className={labelClass} htmlFor="label">
              Désignation
            </label>
            <input
              id="label"
              name="label"
              autoComplete="off"
              maxLength={MAX_LINE_LABEL_LENGTH}
              value={values.label}
              onChange={(event) => set('label', event.target.value)}
              {...describedBy('label', errors.label, true)}
              className={`${fieldClass} mt-1`}
            />
            <FieldError name="label" error={errors.label} />
            <FieldHint name="label">Telle que Dolibarr la reprendra sur la proposition.</FieldHint>
          </div>
          <div>
            <label className={labelClass} htmlFor="description">
              Description <span className="font-normal text-muted-foreground">(facultatif)</span>
            </label>
            <textarea
              id="description"
              name="description"
              rows={2}
              maxLength={MAX_LINE_DESCRIPTION_LENGTH}
              value={values.description}
              onChange={(event) => set('description', event.target.value)}
              {...describedBy('description', errors.description)}
              className={`${fieldClass} mt-1`}
            />
            <FieldError name="description" error={errors.description} />
          </div>
          <div className="grid gap-4 sm:grid-cols-4">
            <div>
              <label className={labelClass} htmlFor="unit">
                Unité
              </label>
              <select
                id="unit"
                name="unit"
                value={values.unit}
                onChange={(event) => set('unit', event.target.value)}
                {...describedBy('unit', errors.unit)}
                className={`${fieldClass} mt-1`}
              >
                {rateUnitValues.map((unit) => (
                  <option key={unit} value={unit}>
                    {rateUnitLabels[unit]}
                  </option>
                ))}
              </select>
              <FieldError name="unit" error={errors.unit} />
            </div>
            <QuantityField value={values.quantity} error={errors.quantity} onChange={(value) => set('quantity', value)} />
            <AmountField
              name="unitPrice"
              label="Prix unitaire HT"
              suffix="€"
              value={values.unitPrice}
              error={errors.unitPrice}
              onChange={(value) => set('unitPrice', value)}
            />
            <AmountField
              name="vatRate"
              label="TVA"
              suffix="%"
              value={values.vatRate}
              error={errors.vatRate}
              onChange={(value) => set('vatRate', value)}
            />
          </div>
          <fieldset className="grid gap-4 sm:grid-cols-4">
            <legend className={`${labelClass} sm:col-span-4`}>
              Remise <span className="font-normal text-muted-foreground">(facultatif : en pourcentage ou en euros, pas les deux)</span>
            </legend>
            <AmountField
              name="discountPercent"
              label="En pourcentage"
              suffix="%"
              value={values.discountPercent}
              error={errors.discountPercent}
              onChange={(value) => set('discountPercent', value)}
            />
            <AmountField
              name="discountAmount"
              label="En euros, sur la ligne"
              suffix="€"
              value={values.discountAmount}
              error={errors.discountAmount}
              onChange={(value) => set('discountAmount', value)}
            />
          </fieldset>
        </>
      )}

      {/* Place réservée : l'aperçu ne fait pas sauter la page. */}
      <p role="status" aria-live="polite" className="min-h-10 rounded-md border border-border bg-muted/40 px-4 py-2 text-sm">
        {preview ? (
          <>
            Cette ligne :{' '}
            <strong className="tabular">{formatCents(lineAmountCents(preview), currency)} HT</strong>{' '}
            <span className="text-muted-foreground">(TVA {formatBasisPoints(preview.vatRateBp)})</span>
          </>
        ) : (
          <span className="text-muted-foreground">Complétez la ligne pour voir son montant.</span>
        )}
      </p>
    </>
  )
}

function QuantityField({ value, error, onChange }: { value: string; error?: string; onChange: (value: string) => void }) {
  return (
    <div>
      <label className={labelClass} htmlFor="quantity">
        Quantité
      </label>
      <input
        id="quantity"
        name="quantity"
        type="number"
        min={1}
        step={1}
        inputMode="numeric"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        {...describedBy('quantity', error)}
        className={`${fieldClass} mt-1 tabular`}
      />
      <FieldError name="quantity" error={error} />
    </div>
  )
}

function AmountField({
  name,
  label,
  suffix,
  value,
  error,
  onChange,
}: {
  name: string
  label: string
  suffix: string
  value: string
  error?: string
  onChange: (value: string) => void
}) {
  return (
    <div>
      <label className={labelClass} htmlFor={name}>
        {label}
      </label>
      <div className="mt-1 flex items-center gap-2">
        <input
          id={name}
          name={name}
          inputMode="decimal"
          autoComplete="off"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          {...describedBy(name, error)}
          className={`${fieldClass} tabular`}
        />
        <span className="text-sm text-muted-foreground">{suffix}</span>
      </div>
      <FieldError name={name} error={error} />
    </div>
  )
}

// --- Note de l'accueil ------------------------------------------------------

export function ProposalNoteForm({ proposalId, staffNote }: { proposalId: string; staffNote: string }) {
  const [state, formAction, pending] = useActionState<NoteFormState, FormData>(saveProposalNoteAction, null)
  const [value, setValue] = useState(staffNote)
  return (
    <form action={formAction} noValidate className="flex flex-col gap-2">
      <input type="hidden" name="proposalId" value={proposalId} />
      <label className={labelClass} htmlFor="staffNote">
        Note de l’accueil <span className="font-normal text-muted-foreground">(facultatif, transmise à Dolibarr)</span>
      </label>
      <textarea
        id="staffNote"
        name="staffNote"
        rows={3}
        maxLength={MAX_NOTE_LENGTH}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        {...describedBy('staffNote', state?.error)}
        className={fieldClass}
      />
      <FieldError name="staffNote" error={state?.error} />
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className={secondaryButtonClass}>
          {pending ? 'Enregistrement…' : 'Enregistrer la note'}
        </button>
        <PendingAnnouncement pending={pending} label="Enregistrement de la note en cours" />
      </div>
    </form>
  )
}

// --- Actions d'un clic --------------------------------------------------------

/**
 * Un bouton qui lance une action du devis (valider, remettre en brouillon,
 * retirer une ligne) : état d'envoi, puis l'échec affiché à côté et annoncé.
 * Le succès redirige vers la fiche, qui l'annonce.
 */
export function ProposalActionButton({
  action,
  fields,
  label,
  ariaLabel,
  pendingLabel,
  className,
  hint,
}: {
  action: (previous: ProposalActionState, formData: FormData) => Promise<ProposalActionState>
  fields: Record<string, string>
  label: string
  ariaLabel?: string
  pendingLabel: string
  className: string
  /** Ce que l'action va faire, sous le bouton. */
  hint?: string
}) {
  const [state, formAction, pending] = useActionState(action, null)
  const id = useId()
  return (
    <form action={formAction} className="flex flex-col items-start gap-1">
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <button
        type="submit"
        disabled={pending}
        aria-label={ariaLabel}
        aria-describedby={[hint ? `${id}-hint` : null, state?.error ? `${id}-error` : null].filter(Boolean).join(' ') || undefined}
        className={className}
      >
        {pending ? pendingLabel : label}
      </button>
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {state?.error && (
        <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
    </form>
  )
}

/** Annulation, dans un dialogue de confirmation : le motif est obligatoire. */
export function CancelProposalDialog({ proposalId, number, sent }: { proposalId: string; number: string; sent: boolean }) {
  const [reason, setReason] = useState('')
  const id = useId()
  return (
    <ConfirmDialog
      triggerLabel="Annuler le devis"
      triggerClassName="rounded-md border border-destructive/30 px-4 py-2 text-sm font-medium text-destructive transition-colors duration-150 ease-out hover:bg-destructive/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-destructive"
      title={`Annuler le devis ${number} ?`}
      confirmLabel="Annuler le devis"
      pendingLabel="Annulation…"
      cancelLabel="Garder le devis"
      action={cancelProposalAction}
      fields={{ proposalId }}
    >
      <p>
        Le devis reste consultable mais ne change plus.{' '}
        {sent
          ? 'Dolibarr l’a déjà repris : l’annulation lui sera signalée, pensez à clore la proposition de son côté.'
          : 'Dolibarr ne le reprendra pas.'}
      </p>
      <label htmlFor={`${id}-reason`} className="font-medium">
        Motif de l’annulation
      </label>
      <textarea
        id={`${id}-reason`}
        name="reason"
        rows={2}
        aria-required="true"
        maxLength={MAX_CANCEL_REASON_LENGTH}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        className={fieldClass}
      />
    </ConfirmDialog>
  )
}
