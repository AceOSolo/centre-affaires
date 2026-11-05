'use client'

import { useActionState } from 'react'

import { resendStaffInvitationAction, type TeamRowState } from '../../../lib/auth/equipe-actions.ts'

/**
 * « Renvoyer l'invitation » d'un membre de l'équipe pas encore connecté
 * (ADR 068) : envoi en cours, puis ce qu'il est devenu, annoncé.
 */
export function ResendStaffInvitationForm({ memberId, email }: { memberId: string; email: string }) {
  const [state, formAction, pending] = useActionState<TeamRowState, FormData>(resendStaffInvitationAction, null)

  return (
    <form action={formAction} className="mt-1 flex flex-col items-start gap-1">
      <input type="hidden" name="id" value={memberId} />
      <button
        type="submit"
        disabled={pending}
        aria-label={`Renvoyer l’invitation à ${email}`}
        className="rounded-md border border-primary/30 px-3 py-1 text-xs font-medium text-primary transition-colors duration-150 ease-out hover:bg-primary/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60"
      >
        {pending ? 'Envoi…' : 'Renvoyer l’invitation'}
      </button>
      <p aria-live="polite" className="max-w-xs text-xs text-primary empty:hidden">
        {state?.ok}
      </p>
      {state?.error && (
        <p role="alert" className="max-w-xs text-xs text-destructive">
          {state.error}
        </p>
      )}
    </form>
  )
}
