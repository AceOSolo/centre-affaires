'use client'

import { useActionState } from 'react'

import { FlashNotice } from '../../components/ui/flash-notice.tsx'
import { recordPostalReminderAction, type PostalReminderState } from './reglements-actions.ts'

/**
 * Note qu'une relance est partie par courrier (ADR 034) : la lettre imprimée,
 * ou envoyée en recommandé. Elle rejoint le journal des relances de la facture.
 */
export function PostalReminderButton({ invoiceId }: { invoiceId: string }) {
  const [state, formAction, pending] = useActionState<PostalReminderState, FormData>(
    recordPostalReminderAction,
    null,
  )
  return (
    <form action={formAction} className="flex flex-col gap-3 print:hidden">
      <input type="hidden" name="invoiceId" value={invoiceId} />
      {state?.error && (
        <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {state.error}
        </p>
      )}
      {state?.recordedAt && (
        <FlashNotice key={state.recordedAt}>Relance notée comme envoyée par courrier.</FlashNotice>
      )}
      <div>
        <button
          type="submit"
          disabled={pending}
          className="rounded-md border border-border bg-white px-4 py-2 text-sm font-medium transition-colors duration-150 ease-out hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
        >
          {pending ? 'Enregistrement…' : 'Noter l’envoi par courrier'}
        </button>
        <span aria-live="polite" className="sr-only">
          {pending ? 'Enregistrement en cours' : ''}
        </span>
      </div>
    </form>
  )
}
