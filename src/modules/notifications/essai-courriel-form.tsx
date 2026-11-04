'use client'

import { useActionState } from 'react'

import { CheckIcon, XIcon } from '../../components/ui/icons.tsx'
import { sendTestEmailAction, type TestEmailState } from './courriels-actions.ts'

/**
 * Bouton « Envoyer un e-mail d'essai » de l'encart « Courriels » (ADR 059) :
 * à l'adresse du membre connecté, avec l'issue dite à côté — envoi en cours,
 * parti, refusé et pourquoi.
 */
export function TestEmailForm({ address }: { address: string }) {
  const [state, formAction, pending] = useActionState<TestEmailState, FormData>(sendTestEmailAction, null)

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex min-h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors duration-150 ease-out hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60"
        >
          {pending ? 'Envoi en cours…' : 'Envoyer un e-mail d’essai'}
        </button>
        <span className="text-sm text-muted-foreground">
          À votre adresse : <span className="text-foreground">{address}</span>
        </span>
      </div>

      {/* Région présente avant son contenu : l'issue est annoncée. */}
      <div aria-live="polite" className="empty:hidden">
        {state?.status === 'sent' && (
          <p className="flex items-start gap-2 rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-sm text-foreground">
            <CheckIcon size={20} className="shrink-0 text-primary" />
            <span>
              Message parti vers {state.to}. Vérifiez sa réception, et qu’il n’est pas arrivé dans les
              indésirables.
            </span>
          </p>
        )}
        {state?.status === 'not_configured' && (
          <p className="flex items-start gap-2 rounded-md border border-border bg-muted px-3 py-2 text-sm text-foreground">
            <XIcon size={20} className="shrink-0 text-primary" />
            <span>Rien n’est parti : l’envoi n’est pas configuré sur le serveur (variables ci-dessus).</span>
          </p>
        )}
      </div>
      {state?.status === 'failed' && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-foreground"
        >
          <XIcon size={20} className="shrink-0 text-destructive" />
          <span>
            <span className="font-medium">Échec de l’envoi vers {state.to}.</span> {state.error}
          </span>
        </p>
      )}
    </form>
  )
}
