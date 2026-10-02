'use client'

import { useActionState } from 'react'

import {
  cancelOpeningRequestAction,
  requestOpeningAction,
  type RequestState,
} from './compte-actions.ts'

/**
 * Demande d'ouverture depuis la boîte aux lettres, et son annulation.
 *
 * Le bouton dit ce qui va se passer et ce que ça coûte avant le clic : c'est
 * une prestation facturée, le client ne doit pas le découvrir sur la facture.
 */
export function MailboxRequest({
  mailItemId,
  mode,
}: {
  mailItemId: string
  mode: 'request' | 'cancel'
}) {
  const [state, formAction, pending] = useActionState<RequestState, FormData>(
    mode === 'request' ? requestOpeningAction : cancelOpeningRequestAction,
    null,
  )

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="id" value={mailItemId} />
      {mode === 'request' ? (
        <>
          <button
            type="submit"
            disabled={pending}
            className="press inline-flex min-h-11 items-center justify-center rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-60"
          >
            {pending ? 'Envoi de la demande…' : 'Demander l’ouverture et la numérisation'}
          </button>
          <p className="text-xs text-muted-foreground">
            Prestation facturée selon votre contrat de domiciliation.
          </p>
        </>
      ) : (
        <button
          type="submit"
          disabled={pending}
          className="inline-flex min-h-11 items-center justify-center rounded-md border border-border px-5 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-60"
        >
          {pending ? 'Annulation…' : 'Annuler la demande'}
        </button>
      )}

      {/* Toujours présent, pour que le lecteur d'écran annonce le résultat. */}
      <p aria-live="polite" className="text-sm empty:hidden">
        {state?.ok && <span className="text-primary">{state.ok}</span>}
        {state?.error && <span className="text-destructive">{state.error}</span>}
      </p>
    </form>
  )
}
