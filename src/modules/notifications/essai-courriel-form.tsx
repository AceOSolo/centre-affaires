'use client'

import { useActionState, useId } from 'react'

import { CheckIcon, XIcon } from '../../components/ui/icons.tsx'
import { sendTestEmailAction, type TestEmailState } from './courriels-actions.ts'

export type TestEmailChoice = { value: string; label: string }

/**
 * Bouton « Envoyer un e-mail d'essai » (ADR 059), à l'adresse du membre
 * connecté, avec l'issue dite à côté — envoi en cours, parti, refusé et
 * pourquoi. Le message d'essai porte la mise en page des courriels (ADR 080) ;
 * `choices` propose aussi chaque modèle, rempli de valeurs d'exemple, et
 * `event` en impose un (l'aperçu de Configuration).
 */
export function TestEmailForm({
  address,
  choices,
  event,
  eventLabel,
}: {
  address: string
  /** Modèles proposés en plus du message d'essai. */
  choices?: readonly TestEmailChoice[]
  /** Modèle imposé, choisi ailleurs sur l'écran. */
  event?: string
  eventLabel?: string
}) {
  const [state, formAction, pending] = useActionState<TestEmailState, FormData>(sendTestEmailAction, null)
  const selectId = useId()

  return (
    <form action={formAction} className="flex flex-col gap-3">
      {event !== undefined && <input type="hidden" name="modele" value={event} />}
      {event === undefined && choices && choices.length > 0 && (
        <div className="flex max-w-md flex-col gap-1">
          <label htmlFor={selectId} className="text-sm font-medium text-foreground">
            Message à recevoir
          </label>
          <select
            id={selectId}
            name="modele"
            defaultValue=""
            className="min-h-10 rounded-sm border border-border bg-white px-3 text-sm focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <option value="">Message d’essai simple</option>
            <optgroup label="Modèles, remplis d’exemples">
              {choices.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </optgroup>
          </select>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex min-h-10 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors duration-150 ease-out hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60"
        >
          {pending ? 'Envoi en cours…' : eventLabel ? `M’envoyer « ${eventLabel} »` : 'Envoyer un e-mail d’essai'}
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
            <span>Rien n’est parti : l’envoi n’est pas configuré sur le serveur (encart « Courriels » de Réglages).</span>
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
