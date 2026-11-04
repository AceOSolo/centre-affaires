'use client'

import { useActionState } from 'react'

import { addOptionsAction } from './options-actions.ts'

/** Un appareil libre, déjà mis en mots par la page : nom, détail, prix sur la période. */
export type EquipmentChoiceView = { id: string; label: string; detail: string; price: string }

/**
 * « Ajouter du matériel » sur la fiche d'une réservation de salle (ADR 062) :
 * des cases à cocher parmi les appareils libres sur la même période, puis un
 * envoi qui rend un état — chargement, puis ce qui a été ajouté ou la raison
 * du refus, annoncés aux lecteurs d'écran.
 */
export function AddOptionsForm({ bookingId, choices }: { bookingId: string; choices: readonly EquipmentChoiceView[] }) {
  const [state, action, pending] = useActionState(addOptionsAction, null)
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="bookingId" value={bookingId} />
      <fieldset className="flex flex-col gap-2" aria-describedby="options-status">
        <legend className="text-sm font-medium text-foreground">Ajouter du matériel</legend>
        <p className="text-xs text-muted-foreground">
          Appareils libres sur la même période. Chacun est réservé avec la salle : même créneau, même
          client, annulé avec elle.
        </p>
        <ul className="mt-1 flex flex-col gap-1">
          {choices.map((choice) => (
            <li key={choice.id}>
              <label className="flex min-h-6 cursor-pointer items-start gap-3 rounded-sm px-1 py-1.5 hover:bg-muted">
                <input
                  type="checkbox"
                  name="equipmentIds"
                  value={choice.id}
                  className="mt-0.5 size-4 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                />
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{choice.label}</span>
                  {choice.detail && <span className="block text-xs text-muted-foreground">{choice.detail}</span>}
                </span>
                <span className="shrink-0 text-sm tabular text-muted-foreground">{choice.price}</span>
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
      <div id="options-status" className="min-h-5 text-sm">
        {state?.error && (
          <p role="alert" className="text-destructive">
            {state.error}
          </p>
        )}
        {state?.done && !pending && (
          <p role="status" className="text-primary">
            {state.done}
          </p>
        )}
      </div>
      <button
        type="submit"
        disabled={pending}
        className="self-start rounded-md border border-primary px-4 py-2 text-sm font-medium text-primary transition-colors duration-150 ease-out hover:bg-muted disabled:opacity-50"
      >
        {pending ? 'Ajout en cours…' : 'Ajouter le matériel'}
      </button>
    </form>
  )
}
