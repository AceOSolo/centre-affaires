'use client'

import { useActionState } from 'react'

import { ConfirmDialog } from '../../components/ui/confirm-dialog.tsx'
import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import {
  FieldError,
  FieldHint,
  PendingAnnouncement,
  dangerButtonClass,
  describedBy,
  fieldClass,
  labelClass,
  secondaryButtonClass,
} from './champs.tsx'
import {
  cancelSubscriptionAction,
  endSubscriptionAction,
  type SubscriptionEndState,
} from './souscriptions-actions.ts'

/**
 * Fin d'une souscription : son dernier jour, compris (R18). Jamais de
 * suppression : la souscription reste dans l'historique du client. Vider la
 * date la prolonge sans terme.
 */
export function SubscriptionEndForm({
  id,
  endsOn,
  hint,
}: {
  id: string
  endsOn: string | null
  /** Ce qui borne la date : premier jour, dernier jour facturé. */
  hint: string
}) {
  const [state, formAction, pending] = useActionState<SubscriptionEndState, FormData>(
    endSubscriptionAction,
    null,
  )
  const error = state?.message

  return (
    <form action={formAction} noValidate className="flex flex-col gap-4">
      <input type="hidden" name="id" value={id} />
      <ErrorSummary errors={error ? { endsOn: error } : undefined} labels={{ endsOn: 'Dernier jour' }} />
      <div className="max-w-xs">
        <label className={labelClass} htmlFor="endsOn">
          Dernier jour <span className="font-normal text-muted-foreground">(compris)</span>
        </label>
        <input
          key={state?.endsOn ?? endsOn ?? ''}
          id="endsOn"
          name="endsOn"
          type="date"
          defaultValue={state?.endsOn ?? endsOn ?? ''}
          {...describedBy('endsOn', error, hint)}
          className={`${fieldClass} mt-1`}
        />
        <FieldError name="endsOn" error={error} />
        <FieldHint name="endsOn">{hint}</FieldHint>
      </div>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className={secondaryButtonClass}>
          {pending ? 'Enregistrement…' : 'Enregistrer la fin'}
        </button>
        <PendingAnnouncement pending={pending} label="Enregistrement en cours" />
      </div>
    </form>
  )
}

/** Annulation d'une souscription saisie par erreur, jamais facturée. */
export function SubscriptionCancelButton({ id, label }: { id: string; label: string }) {
  return (
    <ConfirmDialog
      triggerLabel="Annuler la souscription"
      triggerClassName={dangerButtonClass}
      title="Annuler cette souscription ?"
      confirmLabel="Annuler la souscription"
      pendingLabel="Annulation…"
      cancelLabel="Garder"
      action={cancelSubscriptionAction}
      fields={{ id }}
    >
      <p>
        {label} sort des souscriptions en cours et reste dans l’historique du client, marquée
        « Annulée ». Rien n’a été facturé à son titre.
      </p>
    </ConfirmDialog>
  )
}
