'use client'

import { useActionState } from 'react'

import { cancelClientRequestAction, type ClientCancelState } from './compte-actions.ts'

/** Annulation d'une demande par le client, avec son état : envoi, puis résultat. */
export function ClientCancel({ bookingId }: { bookingId: string }) {
  const [state, formAction, pending] = useActionState<ClientCancelState, FormData>(
    cancelClientRequestAction,
    null,
  )

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="id" value={bookingId} />
      {!state?.ok && (
        <button
          type="submit"
          disabled={pending}
          className="inline-flex min-h-11 items-center justify-center rounded-md border border-border px-5 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-60"
        >
          {pending ? 'Annulation…' : 'Annuler la demande'}
        </button>
      )}
      <p aria-live="polite" className="text-sm empty:hidden">
        {state?.ok && <span className="text-primary">{state.ok}</span>}
        {state?.error && <span className="text-destructive">{state.error}</span>}
      </p>
    </form>
  )
}
