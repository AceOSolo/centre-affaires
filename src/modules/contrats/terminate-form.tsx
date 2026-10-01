'use client'

import { useActionState } from 'react'

import { terminateContractAction, type FormState } from './actions.ts'

const fieldClass =
  'w-full rounded-sm border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/40'

/**
 * Résiliation d'un contrat.
 *
 * La date proposée est celle du préavis, calculée côté serveur. Elle reste
 * modifiable : une résiliation d'un commun accord s'affranchit du préavis, et
 * c'est au staff de trancher, pas au formulaire.
 */
export function TerminateForm({
  contractId,
  defaultTerminatedOn,
  noticeDays,
  commitmentEndsOn = null,
}: {
  contractId: string
  defaultTerminatedOn: string
  noticeDays: number
  /**
   * Dernier jour d'engagement (ADR 023), au format « 09/03/2027 ». Une fin
   * plus tôt reste possible d'un commun accord : le formulaire le signale, la
   * base ne la refuse pas.
   */
  commitmentEndsOn?: string | null
}) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    terminateContractAction,
    null,
  )

  return (
    <form
      action={formAction}
      className="flex flex-col gap-3 rounded-lg border border-border bg-white px-5 py-4"
    >
      <input type="hidden" name="id" value={contractId} />

      <p className="text-sm font-medium text-foreground">Résilier le contrat</p>
      {/* Pas de suppression : le contrat reste consultable (décision 6). */}
      <p className="text-xs text-muted-foreground">
        Le contrat reste consultable. L’échéancier s’arrête à la date retenue.
      </p>

      {state?.error && (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
        >
          {state.error}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label
            className="block text-sm font-medium text-foreground"
            htmlFor="terminatedOn"
          >
            Dernier jour
          </label>
          <input
            id="terminatedOn"
            name="terminatedOn"
            type="date"
            defaultValue={defaultTerminatedOn}
            aria-describedby="terminatedOn-hint"
            className={`${fieldClass} mt-1`}
          />
          <p id="terminatedOn-hint" className="mt-1 text-xs text-muted-foreground">
            Préavis de {noticeDays} jours à compter d’aujourd’hui.
            {commitmentEndsOn &&
              ` Engagement jusqu’au ${commitmentEndsOn} : une fin plus tôt est une résiliation anticipée, d’un commun accord avec le client.`}
          </p>
        </div>
        <div>
          <label
            className="block text-sm font-medium text-foreground"
            htmlFor="reason"
          >
            Motif <span className="font-normal text-muted-foreground">(facultatif)</span>
          </label>
          <input id="reason" name="reason" className={`${fieldClass} mt-1`} />
        </div>
      </div>

      <button
        type="submit"
        disabled={pending}
        className="self-start rounded-md border border-destructive/30 px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/5 disabled:opacity-50"
      >
        {pending ? 'Résiliation…' : 'Résilier'}
      </button>
    </form>
  )
}
