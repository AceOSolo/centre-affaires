'use client'

import { useActionState } from 'react'

import { resendInvitationAction, type ResendInvitationState } from './comptes-actions.ts'

/**
 * « Renvoyer l'invitation » d'un accès pas encore connecté (ADR 059), sur la
 * fiche du client : envoi en cours, puis ce qu'il est devenu, annoncé.
 */
export function ResendInvitationForm({ clientId, memberId, email }: { clientId: string; memberId: string; email: string }) {
  const [state, formAction, pending] = useActionState<ResendInvitationState, FormData>(resendInvitationAction, null)

  return (
    <form action={formAction} className="flex flex-col items-end gap-1">
      <input type="hidden" name="id" value={memberId} />
      <input type="hidden" name="clientId" value={clientId} />
      <button
        type="submit"
        disabled={pending}
        aria-label={`Renvoyer l’invitation à ${email}`}
        className="rounded-md border border-primary/30 px-3 py-1 text-xs font-medium text-primary transition-colors duration-150 ease-out hover:bg-primary/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60"
      >
        {pending ? 'Envoi…' : 'Renvoyer l’invitation'}
      </button>
      <p aria-live="polite" className="max-w-xs text-right text-xs text-primary empty:hidden">
        {state?.ok}
      </p>
      {state?.error && (
        <p role="alert" className="max-w-xs text-right text-xs text-destructive">
          {state.error}
        </p>
      )}
    </form>
  )
}
