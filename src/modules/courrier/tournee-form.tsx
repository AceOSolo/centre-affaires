'use client'

import { useActionState } from 'react'

import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import { closeMailBatchAction, type MailFormState } from './actions.ts'
import { NO_BATCH } from './tournees-regles.ts'

/**
 * Fin de la tournée (ADR 044) : un seul bouton, après le récapitulatif de ce
 * qui va partir. `batchId` nul : aucune tournée ouverte, l'accueil signale
 * qu'il n'y a pas de courrier — dit explicitement (`NO_BATCH`) : si un
 * collègue vient d'en ouvrir une, rien n'est terminé.
 */
export function CloseBatchForm({ batchId, label }: { batchId: string | null; label: string }) {
  const [state, formAction, pending] = useActionState<MailFormState, FormData>(closeMailBatchAction, null)
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="batchId" value={batchId ?? NO_BATCH} />
      <ErrorSummary errors={state?.fieldErrors} labels={{}} message={state?.error} />
      <div>
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50"
        >
          {pending ? 'Envoi en cours…' : label}
        </button>
      </div>
    </form>
  )
}
