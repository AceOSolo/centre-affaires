'use client'

import { useActionState, useId } from 'react'

import { dismissOfferRequestAction } from './offres-demandes-actions.ts'

/**
 * « Écarter » une demande d'offre, dans la file de l'accueil (ADR 041) : le
 * motif, facultatif, est montré au client dans son historique. Replié par
 * défaut pour garder le tableau dense ; l'échec est annoncé près du champ. Au
 * succès, la ligne elle-même change d'état.
 */
export function DismissOfferRequestForm({
  requestId,
  subject,
  maxLength,
}: {
  requestId: string
  /** « Domiciliation Premium, Atelier Durand » : pour nommer l'action d'une ligne à l'autre. */
  subject: string
  maxLength: number
}) {
  const [state, action, pending] = useActionState(dismissOfferRequestAction, null)
  const reasonId = useId()
  return (
    <details className="mt-1">
      <summary
        aria-label={`Écarter la demande : ${subject}`}
        className="inline-block cursor-pointer rounded-sm text-sm text-muted-foreground underline-offset-2 hover:underline"
      >
        Écarter…
      </summary>
      <form action={action} className="mt-2 flex max-w-sm flex-col gap-2">
        <input type="hidden" name="id" value={requestId} />
        <label htmlFor={reasonId} className="text-xs font-medium text-foreground">
          Motif, montré au client (facultatif)
        </label>
        <textarea
          id={reasonId}
          name="reason"
          rows={2}
          maxLength={maxLength}
          aria-invalid={state?.error ? true : undefined}
          aria-describedby={state?.error ? `${reasonId}-erreur` : undefined}
          className="w-full rounded-sm border border-border bg-white px-3 py-2 text-sm"
        />
        {state?.error && (
          <p id={`${reasonId}-erreur`} role="alert" className="text-sm text-destructive">
            {state.error}
          </p>
        )}
        <button
          type="submit"
          disabled={pending}
          className="self-start rounded-md border border-border px-3 py-1 text-sm font-medium hover:bg-muted disabled:opacity-50"
        >
          {pending ? 'Enregistrement…' : 'Écarter la demande'}
        </button>
      </form>
    </details>
  )
}
