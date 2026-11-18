'use client'

import { useActionState, useEffect, useRef, useState } from 'react'

import { cancelClientRequestAction, type ClientCancelState } from './compte-actions.ts'

const buttonClass =
  'inline-flex min-h-11 items-center justify-center rounded-md border px-5 py-2.5 text-sm font-medium transition-colors duration-150 ease-out focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-60'

/**
 * Annulation par le client d'une demande ou d'une réservation (ADR 076), en
 * deux temps : le premier bouton demande confirmation, le second annule.
 * L'état est rendu : envoi, puis résultat, annoncé au lecteur d'écran.
 */
export function ClientCancel({ bookingId, confirmed }: { bookingId: string; confirmed: boolean }) {
  const [state, formAction, pending] = useActionState<ClientCancelState, FormData>(cancelClientRequestAction, null)
  const [asking, setAsking] = useState(false)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const what = confirmed ? 'la réservation' : 'la demande'

  useEffect(() => {
    if (asking) confirmRef.current?.focus()
  }, [asking])

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="id" value={bookingId} />
      {!state?.ok &&
        (asking ? (
          <div role="group" aria-label={`Confirmer l’annulation de ${what}`} className="flex flex-col gap-2 sm:flex-row">
            <button
              ref={confirmRef}
              type="submit"
              disabled={pending}
              className={`${buttonClass} border-primary bg-primary text-primary-foreground hover:bg-primary-hover`}
            >
              {pending ? 'Annulation…' : `Oui, annuler ${what}`}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => setAsking(false)}
              className={`${buttonClass} border-border bg-white text-foreground hover:bg-muted`}
            >
              Non, la garder
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setAsking(true)}
            className={`${buttonClass} border-border bg-white text-foreground hover:bg-muted`}
          >
            {confirmed ? 'Annuler la réservation' : 'Annuler la demande'}
          </button>
        ))}
      <p aria-live="polite" className="text-sm empty:hidden">
        {state?.ok && <span className="text-primary">{state.ok}</span>}
        {state?.error && <span className="text-destructive">{state.error}</span>}
      </p>
    </form>
  )
}
