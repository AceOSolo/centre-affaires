'use client'

import { useActionState, useId } from 'react'

import { acceptClientDocumentsAction, reviewClientDocumentAction, type ReviewState } from './pieces-actions.ts'
import { REFUSAL_REASON_MAX } from './pieces-regles.ts'
import type { ClientDocumentStatus } from './schema-pieces.ts'

const secondary =
  'inline-flex min-h-8 items-center rounded-md border border-border bg-white px-3 py-1 text-xs font-medium text-foreground transition-colors duration-150 ease-out hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60'
const primary =
  'inline-flex min-h-8 items-center rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground transition-colors duration-150 ease-out hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60'

/**
 * Vérification d'une pièce par l'accueil (ADR 075) : « Valider » une pièce
 * reçue, « Refuser… » une pièce reçue ou validée, avec le motif que le client
 * lira (il s'ouvre sous le bouton, rien ne part sans lui).
 *
 * Rendu pour chaque pièce quel que soit son état : le composant reste en place
 * quand l'état change, et la région annoncée garde le résultat.
 */
export function DocumentReviewActions({
  documentId,
  label,
  status,
}: {
  documentId: string
  label: string
  status: ClientDocumentStatus
}) {
  const [state, formAction, pending] = useActionState<ReviewState, FormData>(reviewClientDocumentAction, null)
  const id = useId()
  const reasonId = `${id}-motif`

  return (
    <div className="flex flex-col items-start gap-1">
      {status !== 'refused' && (
        <div className="flex flex-wrap items-start gap-2">
          {status === 'received' && (
            <form action={formAction}>
              <input type="hidden" name="documentId" value={documentId} />
              <input type="hidden" name="decision" value="accept" />
              <button type="submit" disabled={pending} aria-label={`Valider : ${label}`} className={primary}>
                {pending ? '…' : 'Valider'}
              </button>
            </form>
          )}
          <details>
            <summary className={`${secondary} cursor-pointer list-none`}>
              Refuser…<span className="sr-only"> : {label}</span>
            </summary>
            <form action={formAction} className="mt-2 flex w-72 max-w-full flex-col gap-2">
              <input type="hidden" name="documentId" value={documentId} />
              <input type="hidden" name="decision" value="refuse" />
              <label htmlFor={reasonId} className="text-xs font-medium text-foreground">
                Motif, lu par le client{' '}
                <span aria-hidden="true" className="text-destructive">
                  *
                </span>
              </label>
              <textarea
                id={reasonId}
                name="reason"
                rows={3}
                required
                aria-required="true"
                maxLength={REFUSAL_REASON_MAX}
                aria-invalid={state?.fieldError ? true : undefined}
                aria-describedby={state?.fieldError ? `${reasonId}-erreur` : undefined}
                className="rounded-md border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/40 aria-[invalid=true]:border-destructive"
              />
              {state?.fieldError && (
                <p id={`${reasonId}-erreur`} role="alert" className="text-xs text-destructive">
                  {state.fieldError}
                </p>
              )}
              <button type="submit" disabled={pending} className={secondary}>
                {pending ? 'Refus…' : 'Refuser la pièce et prévenir le client'}
              </button>
            </form>
          </details>
        </div>
      )}
      <p aria-live="polite" className="text-xs text-primary empty:hidden">
        {!pending && state?.ok}
      </p>
      {!pending && state?.error && (
        <p role="alert" className="text-xs text-destructive">
          {state.error}
        </p>
      )}
    </div>
  )
}

/**
 * Validation groupée : les pièces cochées dans le tableau (cases reliées à ce
 * formulaire par leur attribut `form`), validées d'un coup. Le bouton ne
 * paraît que s'il reste au moins deux pièces à vérifier ; le formulaire, lui,
 * reste en place pour annoncer le résultat.
 */
export function AcceptSelectionForm({ formId, count }: { formId: string; count: number }) {
  const [state, formAction, pending] = useActionState<ReviewState, FormData>(acceptClientDocumentsAction, null)
  return (
    <form id={formId} action={formAction} className="flex flex-wrap items-center gap-3">
      {count > 1 && (
        <button type="submit" disabled={pending} className={secondary}>
          {pending ? 'Validation…' : 'Valider la sélection'}
        </button>
      )}
      <p aria-live="polite" className="text-xs text-primary empty:hidden">
        {!pending && state?.ok}
      </p>
      {!pending && state?.error && (
        <p role="alert" className="text-xs text-destructive">
          {state.error}
        </p>
      )}
    </form>
  )
}
