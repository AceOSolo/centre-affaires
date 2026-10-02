'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'

import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import {
  cancelMailRequestForClientAction,
  completeForwardRequestAction,
  completeScanRequestAction,
  refuseMailRequestAction,
  startMailRequestAction,
  updateForwardShippingAction,
  type RequestActionState,
} from './demandes-actions.ts'
import { FileField } from './mail-form.tsx'

/**
 * Traitement d'une demande par l'accueil (R21, ADR 037) : prendre en charge,
 * faire — numérisation déposée, réexpédition notée —, refuser avec un motif,
 * annuler à la demande du client. Chaque action rend un état : en cours, puis
 * retour au pli avec une confirmation, ou l'erreur ici même.
 *
 * Les identifiants de champ portent celui de la demande : plusieurs demandes
 * se traitent sur la même page.
 */
const fieldClass =
  'mt-1 w-full rounded-sm border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/40 aria-[invalid=true]:border-destructive'
const labelClass = 'block text-sm font-medium text-foreground'
const primaryClass =
  'rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50'
const secondaryClass =
  'rounded-md border border-border bg-white px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50'

/** Bouton d'un formulaire d'action groupée : il dit que l'envoi est en cours. */
export function PendingSubmit({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus()
  return (
    <button type="submit" disabled={pending} className={secondaryClass}>
      {pending ? pendingLabel : label}
    </button>
  )
}

/** Coche ou décoche toutes les demandes de la file affichée. */
export function SelectAllRequests({ label }: { label: string }) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      className="size-4 accent-[var(--primary)]"
      onChange={(event) => {
        const checked = event.currentTarget.checked
        event.currentTarget.form
          ?.querySelectorAll<HTMLInputElement>('input[name="ids"]')
          .forEach((box) => {
            box.checked = checked
          })
      }}
    />
  )
}

function Status({ state }: { state: RequestActionState }) {
  return (
    <p aria-live="polite" className="text-sm empty:hidden">
      {state?.error && <span className="text-destructive">{state.error}</span>}
    </p>
  )
}

function FieldError({ id, error }: { id: string; error?: string }) {
  if (!error) return null
  return (
    <p id={`${id}-error`} className="mt-1 text-xs text-destructive">
      {error}
    </p>
  )
}

/** Un bouton, une transition : prise en charge, annulation à la demande du client. */
function OneClick({
  requestId,
  action,
  label,
  pendingLabel,
  ariaLabel,
  primary = false,
}: {
  requestId: string
  action: (previous: RequestActionState, formData: FormData) => Promise<RequestActionState>
  label: string
  pendingLabel: string
  ariaLabel: string
  primary?: boolean
}) {
  const [state, formAction, pending] = useActionState<RequestActionState, FormData>(action, null)
  return (
    <form action={formAction} className="flex flex-col gap-1">
      <input type="hidden" name="id" value={requestId} />
      <button type="submit" disabled={pending} aria-label={ariaLabel} className={primary ? primaryClass : secondaryClass}>
        {pending ? pendingLabel : label}
      </button>
      <Status state={state} />
    </form>
  )
}

export function StartRequestButton({ requestId, subject }: { requestId: string; subject: string }) {
  return (
    <OneClick
      requestId={requestId}
      action={startMailRequestAction}
      label="Prendre en charge"
      pendingLabel="Enregistrement…"
      ariaLabel={`Prendre en charge la demande de ${subject}`}
    />
  )
}

export function CancelForClientButton({ requestId, subject }: { requestId: string; subject: string }) {
  return (
    <OneClick
      requestId={requestId}
      action={cancelMailRequestForClientAction}
      label="Annuler à la demande du client"
      pendingLabel="Annulation…"
      ariaLabel={`Annuler à la demande du client — demande de ${subject}`}
    />
  )
}

/** Refus : le motif est obligatoire et montré au client dans son espace. */
export function RefuseRequestForm({ requestId, subject }: { requestId: string; subject: string }) {
  const [state, formAction, pending] = useActionState<RequestActionState, FormData>(
    refuseMailRequestAction,
    null,
  )
  const id = `refusalReason-${requestId}`
  const error = state?.fieldErrors?.refusalReason
  return (
    <details className="rounded-md border border-border bg-white px-3 py-2" open={Boolean(state?.fieldErrors || state?.error)}>
      <summary className="cursor-pointer text-sm font-medium">Refuser la demande de {subject}</summary>
      <form action={formAction} className="mt-3 flex flex-col gap-3">
        <input type="hidden" name="id" value={requestId} />
        <ErrorSummary
          errors={error ? { [id]: error } : undefined}
          labels={{ [id]: 'Motif du refus' }}
          message={state?.error}
        />
        <div>
          <label htmlFor={id} className={labelClass}>
            Motif du refus
          </label>
          <textarea
            id={id}
            name="refusalReason"
            rows={2}
            maxLength={500}
            required
            defaultValue={state?.values?.refusalReason ?? ''}
            aria-invalid={error ? true : undefined}
            aria-describedby={`${id}-hint${error ? ` ${id}-error` : ''}`}
            className={fieldClass}
          />
          <p id={`${id}-hint`} className="mt-1 text-xs text-muted-foreground">
            Le client le lit dans son espace. Il est prévenu par courriel, sans le motif.
          </p>
          <FieldError id={id} error={error} />
        </div>
        <div>
          <button type="submit" disabled={pending} className={secondaryClass}>
            {pending ? 'Refus en cours…' : 'Refuser'}
          </button>
        </div>
      </form>
    </details>
  )
}

/** Numérisation demandée : le contenu déposé est rattaché à la demande. */
export function CompleteScanForm({ requestId }: { requestId: string }) {
  const [state, formAction, pending] = useActionState<RequestActionState, FormData>(
    completeScanRequestAction,
    null,
  )
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="id" value={requestId} />
      <ErrorSummary
        errors={state?.fieldErrors}
        labels={{ requestContent: 'Numérisation' }}
        message={state?.error}
      />
      <FileField
        name="requestContent"
        label="Numérisation"
        hint="PDF de toutes les pages demandées, ou photo lisible. Le client y a accès dès l’enregistrement, et en est prévenu."
        error={state?.fieldErrors?.requestContent}
        required
      />
      <div>
        <button type="submit" disabled={pending} className={primaryClass}>
          {pending ? 'Dépôt en cours…' : 'Déposer et marquer faite'}
        </button>
      </div>
    </form>
  )
}

const shippingLabels = { trackingNumber: 'Numéro de suivi', postage: 'Frais d’affranchissement' }

/** Champs d'envoi d'une réexpédition : suivi et frais réels, facultatifs. */
function ShippingFields({
  requestId,
  state,
  defaults,
}: {
  requestId: string
  state: RequestActionState
  defaults: { trackingNumber: string; postage: string }
}) {
  const errors = state?.fieldErrors ?? {}
  const field = (name: 'trackingNumber' | 'postage', hint: string, inputMode?: 'decimal') => {
    const id = `${name}-${requestId}`
    return (
      <div>
        <label htmlFor={id} className={labelClass}>
          {shippingLabels[name]} <span className="font-normal text-muted-foreground">(facultatif)</span>
        </label>
        <input
          id={id}
          name={name}
          inputMode={inputMode}
          defaultValue={state?.values?.[name] ?? defaults[name]}
          aria-invalid={errors[name] ? true : undefined}
          aria-describedby={`${id}-hint${errors[name] ? ` ${id}-error` : ''}`}
          className={`${fieldClass} ${name === 'postage' ? 'tabular' : ''}`}
        />
        <p id={`${id}-hint`} className="mt-1 text-xs text-muted-foreground">
          {hint}
        </p>
        <FieldError id={id} error={errors[name]} />
      </div>
    )
  }
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {field('trackingNumber', 'Lettre suivie, recommandé ou colis : le client le voit dans son espace.')}
      {field(
        'postage',
        'En euros, par exemple 4,35 ; 0 s’il n’y en a pas. Refacturés tels quels ; tant qu’ils ne sont pas notés, la réexpédition attend pour être facturée.',
        'decimal',
      )}
    </div>
  )
}

/** Les erreurs d'envoi, renommées vers les champs de cette demande pour les liens du résumé. */
const shippingErrors = (requestId: string, state: RequestActionState) =>
  state?.fieldErrors
    ? Object.fromEntries(Object.entries(state.fieldErrors).map(([name, error]) => [`${name}-${requestId}`, error]))
    : undefined
const shippingErrorLabels = (requestId: string) => ({
  [`trackingNumber-${requestId}`]: shippingLabels.trackingNumber,
  [`postage-${requestId}`]: shippingLabels.postage,
})

/** Réexpédition faite : la date est posée par la base, suivi et frais peuvent attendre. */
export function CompleteForwardForm({ requestId }: { requestId: string }) {
  const [state, formAction, pending] = useActionState<RequestActionState, FormData>(
    completeForwardRequestAction,
    null,
  )
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="id" value={requestId} />
      <ErrorSummary errors={shippingErrors(requestId, state)} labels={shippingErrorLabels(requestId)} message={state?.error} />
      <ShippingFields requestId={requestId} state={state} defaults={{ trackingNumber: '', postage: '' }} />
      <div>
        <button type="submit" disabled={pending} className={primaryClass}>
          {pending ? 'Enregistrement…' : 'Marquer réexpédiée'}
        </button>
      </div>
    </form>
  )
}

/** Suivi et frais notés après l'envoi, tant qu'aucune facture ne tient la demande. */
export function ShippingForm({
  requestId,
  trackingNumber,
  postage,
}: {
  requestId: string
  trackingNumber: string
  postage: string
}) {
  const [state, formAction, pending] = useActionState<RequestActionState, FormData>(
    updateForwardShippingAction,
    null,
  )
  return (
    <details className="rounded-md border border-border bg-white px-3 py-2" open={Boolean(state?.fieldErrors || state?.error)}>
      <summary className="cursor-pointer text-sm font-medium">Noter le suivi et les frais</summary>
      <form action={formAction} className="mt-3 flex flex-col gap-3">
        <input type="hidden" name="id" value={requestId} />
        <ErrorSummary errors={shippingErrors(requestId, state)} labels={shippingErrorLabels(requestId)} message={state?.error} />
        <ShippingFields requestId={requestId} state={state} defaults={{ trackingNumber, postage }} />
        <div>
          <button type="submit" disabled={pending} className={secondaryClass}>
            {pending ? 'Enregistrement…' : 'Enregistrer'}
          </button>
        </div>
      </form>
    </details>
  )
}
