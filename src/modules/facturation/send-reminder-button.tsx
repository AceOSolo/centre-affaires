'use client'

import { useActionState } from 'react'

import { FlashNotice } from '../../components/ui/flash-notice.tsx'
import { sendRemindersAction, type ReminderState } from './reglements-actions.ts'

/** Envoi par courriel de la relance d'une facture, depuis sa lettre. */
export function SendReminderButton({ invoiceId, recipients }: { invoiceId: string; recipients: string[] }) {
  const [state, formAction, pending] = useActionState<ReminderState, FormData>(sendRemindersAction, null)
  return (
    <form action={formAction} className="flex flex-col gap-3 print:hidden">
      <input type="hidden" name="invoiceIds" value={invoiceId} />
      {state?.error && (
        <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {state.error}
        </p>
      )}
      {state?.sent !== undefined && (
        <FlashNotice key={`${state.sent}-${(state.skipped ?? []).join('|')}`}>
          {state.sent > 0 ? `Relance envoyée à ${recipients.join(', ')}.` : (state.skipped ?? []).join(' ')}
        </FlashNotice>
      )}
      <div>
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white transition-colors duration-150 ease-out hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
        >
          {pending ? 'Envoi…' : 'Envoyer par courriel'}
        </button>
        <span aria-live="polite" className="sr-only">
          {pending ? 'Envoi en cours' : ''}
        </span>
      </div>
    </form>
  )
}
