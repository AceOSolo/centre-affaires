'use client'

import { useActionState, useState } from 'react'

import { terminateContractAction, type FormState } from './actions.ts'
import { formatCalendarDate } from './occupation.ts'

const fieldClass =
  'w-full rounded-sm border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/40'

/**
 * Résiliation d'un contrat.
 *
 * La date proposée est celle du préavis, ou la fin de l'engagement si elle
 * est plus tardive (R10, ADR 023), calculée côté serveur. Elle reste
 * modifiable : une résiliation d'un commun accord s'affranchit du préavis et
 * de l'engagement, et c'est au staff de trancher, pas au formulaire — qui
 * signale seulement une date antérieure à la fin de l'engagement.
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
  /** Dernier jour de l'engagement ; nul sans engagement. */
  commitmentEndsOn?: string | null
}) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    terminateContractAction,
    null,
  )
  const [terminatedOn, setTerminatedOn] = useState(defaultTerminatedOn)
  const early = Boolean(commitmentEndsOn && terminatedOn && terminatedOn < commitmentEndsOn)

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
            value={terminatedOn}
            onChange={(event) => setTerminatedOn(event.target.value)}
            aria-describedby="terminatedOn-hint terminatedOn-warning"
            className={`${fieldClass} mt-1`}
          />
          <p id="terminatedOn-hint" className="mt-1 text-xs text-muted-foreground">
            Préavis de {noticeDays} jours à compter d’aujourd’hui
            {commitmentEndsOn
              ? `, engagement jusqu’au ${formatCalendarDate(commitmentEndsOn)}.`
              : '.'}
          </p>
          <p id="terminatedOn-warning" aria-live="polite" className="mt-1 text-xs text-foreground empty:hidden">
            {early && commitmentEndsOn
              ? `Attention : avant la fin de l’engagement (${formatCalendarDate(commitmentEndsOn)}). Une résiliation anticipée est un accord avec le client.`
              : ''}
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
