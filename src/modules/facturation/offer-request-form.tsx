'use client'

import { useActionState } from 'react'

import { CheckIcon } from '../../components/ui/icons.tsx'
import { requestOfferAction, type OfferRequestState } from './offres-portail-actions.ts'

const focusClass = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary'

/**
 * « Demander cette offre » dans l'espace client (R23, ADR 036) : une action,
 * avec son état — envoi, puis demande transmise ou refus — annoncé. Un compte
 * qui représente plusieurs entreprises dit pour laquelle.
 */
export function OfferRequestForm({
  offerId,
  headingId,
  accounts,
}: {
  offerId: string
  /** Titre de l'offre, qui précise le bouton pour un lecteur d'écran. */
  headingId: string
  accounts: { clientId: string; clientName: string }[]
}) {
  const [state, formAction, pending] = useActionState<OfferRequestState, FormData>(
    requestOfferAction,
    { status: 'idle' },
  )
  const fieldId = `client-${offerId}`

  if (state.status === 'sent') {
    return (
      <p role="status" className="flex items-start gap-2 rounded-md bg-accent/10 p-3 text-sm text-primary">
        <CheckIcon size={20} className="shrink-0" />
        <span>{state.message}</span>
      </p>
    )
  }

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="offerId" value={offerId} />
      {accounts.length > 1 ? (
        <div>
          <label htmlFor={fieldId} className="block text-sm font-medium">
            Pour l’entreprise
          </label>
          <select
            id={fieldId}
            name="clientId"
            required
            defaultValue=""
            aria-invalid={state.status === 'error' && state.field === 'clientId' ? true : undefined}
            aria-describedby={state.status === 'error' ? `${fieldId}-error` : undefined}
            className="mt-1 w-full min-h-11 rounded-sm border border-border bg-white px-3 py-2 text-base outline-none focus:border-primary focus:ring-2 focus:ring-accent/40"
          >
            <option value="">Choisir l’entreprise</option>
            {accounts.map((account) => (
              <option key={account.clientId} value={account.clientId}>
                {account.clientName}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <input type="hidden" name="clientId" value={accounts[0]?.clientId ?? ''} />
      )}
      <button
        type="submit"
        disabled={pending}
        aria-describedby={headingId}
        className={`inline-flex min-h-11 items-center justify-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-60 ${focusClass}`}
      >
        {pending ? 'Envoi de la demande…' : 'Demander cette offre'}
      </button>
      <p id={`${fieldId}-error`} aria-live="polite" className="text-sm text-destructive empty:hidden">
        {state.status === 'error' ? state.message : ''}
      </p>
    </form>
  )
}
