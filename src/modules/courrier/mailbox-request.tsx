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
 * `announcement` : le prix annoncé (`openingAnnouncementText`), le même sur la
 * boîte aux lettres et sur la fiche du pli, lu avec le bouton.
 */
export function MailboxRequest({
  mailItemId,
  mode,
  announcement,
}: {
  mailItemId: string
  mode: 'request' | 'cancel'
  announcement: string
}) {
  const [state, formAction, pending] = useActionState<RequestState, FormData>(
    mode === 'request' ? requestOpeningAction : cancelOpeningRequestAction,
    null,
  )
  const announcementId = `prix-ouverture-${mailItemId}`

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="id" value={mailItemId} />
      {mode === 'request' ? (
        <>
          <button
            type="submit"
            disabled={pending}
            aria-describedby={announcementId}
            className="press inline-flex min-h-11 items-center justify-center rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-60"
          >
            {pending ? 'Envoi de la demande…' : 'Demander l’ouverture et la numérisation'}
          </button>
          <p id={announcementId} className="max-w-prose text-xs text-muted-foreground">
            {announcement}
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
