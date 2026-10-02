'use client'

import { useActionState } from 'react'

import { updateClientBookingModeAction, type ClientBookingModeState } from './actions.ts'
import { clientBookingModeDescriptions, clientBookingModeLabels } from './reservation-client.ts'
import { clientBookingModes, type ClientBookingMode } from './schema.ts'

/**
 * Réglage « réservation depuis l'espace client » sur la fiche d'une ressource
 * (R23, ADR 016 décision D4, ADR 036). Trois choix, chacun dit en toutes
 * lettres ; l'enregistrement rend son état (envoi, puis résultat annoncé).
 */
export function ClientBookingModeForm({
  resourceId,
  mode,
}: {
  resourceId: string
  mode: ClientBookingMode
}) {
  const [state, formAction, pending] = useActionState<ClientBookingModeState, FormData>(
    updateClientBookingModeAction,
    null,
  )

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="id" value={resourceId} />
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm text-muted-foreground">
          Quand un client réserve cette ressource depuis son espace :
        </legend>
        {clientBookingModes.map((candidate) => (
          <label
            key={candidate}
            className="flex cursor-pointer items-start gap-3 rounded-md border border-border px-3 py-2 has-[:checked]:border-primary has-[:checked]:bg-accent/5"
          >
            <input
              type="radio"
              name="clientBookingMode"
              value={candidate}
              defaultChecked={candidate === mode}
              className="mt-1 size-4 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            />
            <span className="text-sm">
              <span className="block font-medium">{clientBookingModeLabels[candidate]}</span>
              <span className="block text-muted-foreground">
                {clientBookingModeDescriptions[candidate]}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white transition-colors duration-150 ease-out hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
        >
          {pending ? 'Enregistrement…' : 'Enregistrer le réglage'}
        </button>
        {/* Région présente dès le premier rendu : le résultat est lu, pas seulement vu. */}
        <p aria-live="polite" className="text-sm empty:hidden">
          {pending && <span className="sr-only">Enregistrement en cours.</span>}
          {!pending && state?.ok && <span className="text-primary">{state.ok}</span>}
          {!pending && state?.error && <span className="text-destructive">{state.error}</span>}
        </p>
      </div>
    </form>
  )
}
