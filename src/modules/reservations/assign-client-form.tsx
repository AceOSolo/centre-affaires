'use client'

import { useActionState } from 'react'

import { assignBookingClientAction } from './actions.ts'

/**
 * Rattachement d'une réservation à un client (ADR 015), sur sa fiche. Toute
 * soumission rend un état : chargement, puis « Client enregistré » ou la
 * raison du refus, annoncée près du champ (ADR 041).
 */
export function AssignClientForm({
  bookingId,
  clientId,
  clients,
  contractReference,
}: {
  bookingId: string
  clientId: string | null
  clients: readonly { id: string; name: string }[]
  /** Contrat de la réservation : changer de client l'en détache. */
  contractReference: string | null
}) {
  const [state, action, pending] = useActionState(assignBookingClientAction, null)
  return (
    <form
      action={action}
      className="flex flex-col gap-3 rounded-lg border border-border bg-white px-5 py-4 sm:flex-row sm:items-start"
    >
      <input type="hidden" name="id" value={bookingId} />
      <div className="flex-1">
        <label className="block text-sm font-medium text-foreground" htmlFor="clientId">
          Client rattaché
        </label>
        <select
          id="clientId"
          name="clientId"
          defaultValue={clientId ?? ''}
          aria-describedby="clientId-hint clientId-status"
          aria-invalid={state?.error ? true : undefined}
          className="mt-1 w-full rounded-sm border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/40"
        >
          <option value="">Aucun</option>
          {clients.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
        </select>
        <p id="clientId-hint" className="mt-1 text-xs text-muted-foreground">
          La réservation apparaît dans l’espace de ce client.
          {contractReference && ` Changer de client la détache du contrat ${contractReference}.`}
        </p>
        <div id="clientId-status" className="mt-1 min-h-5 text-sm">
          {state?.error && (
            <p role="alert" className="text-destructive">
              Client non modifié : {state.error}
            </p>
          )}
          {state?.saved && !pending && (
            <p role="status" className="text-primary">
              Client enregistré.
            </p>
          )}
        </div>
      </div>
      <button
        type="submit"
        disabled={pending}
        className="self-start rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50 sm:mt-6"
      >
        {pending ? 'Enregistrement…' : 'Enregistrer'}
      </button>
    </form>
  )
}
