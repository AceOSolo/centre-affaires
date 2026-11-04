'use client'

import { useActionState } from 'react'
import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import { formatDays, MAX_REQUEST_DAYS_LIMIT } from './durees.ts'
import { saveRequestPolicyAction } from './policy-actions.ts'
import type { RequestPolicy } from './request-policy.ts'

const field = 'mt-1 w-full rounded-sm border border-border bg-white px-3 py-2 text-sm aria-[invalid=true]:border-destructive'

/** Durée maximale d'un produit, telle que l'écran la règle (ADR 061). */
export type MaxDaysSetting = { key: string; label: string; value: number; defaultValue: number }

export function RequestPolicyForm({ policy, maxDays }: { policy: RequestPolicy; maxDays: MaxDaysSetting[] }) {
  const [state, action, pending] = useActionState(saveRequestPolicyAction, null)
  // Le résumé mène à chaque durée refusée, par l'identifiant de son champ.
  const summaryErrors = Object.fromEntries(
    Object.entries(state?.fieldErrors ?? {}).map(([key, message]) => [`maxDays-${key}`, message]),
  )
  const summaryLabels = Object.fromEntries(maxDays.map((item) => [`maxDays-${item.key}`, `Durée maximale — ${item.label}`]))
  return (
    <form action={action} className="flex flex-col gap-4">
      <ErrorSummary errors={summaryErrors} labels={summaryLabels} message={state?.error} />
      <p className="text-sm text-muted-foreground">Ces délais s’appliquent aux demandes du site public et de l’espace client. L’équipe peut toujours réserver depuis le planning admin.</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="text-sm font-medium" htmlFor="bookingLeadHours">
          Préavis minimum (heures)
          <input className={field} id="bookingLeadHours" name="bookingLeadHours" type="number" min={0} max={8759} step={1} required defaultValue={policy.bookingLeadHours} />
          <span className="mt-1 block text-xs font-normal text-muted-foreground">0 : sans préavis. 48 : au moins deux jours avant.</span>
        </label>
        <label className="text-sm font-medium" htmlFor="bookingHorizonDays">
          Réservation à l’avance (jours maximum)
          <input className={field} id="bookingHorizonDays" name="bookingHorizonDays" type="number" min={1} max={365} step={1} required defaultValue={policy.bookingHorizonDays} />
        </label>
      </div>
      {maxDays.length > 0 && (
        <fieldset className="flex flex-col gap-3">
          <legend className="text-sm font-medium">Durée maximale d’une demande en ligne (jours d’affilée)</legend>
          <p className="text-xs text-muted-foreground">
            Comptée du jour du début au jour de la fin : 1, le jour même seulement ; 3, du lundi au mercredi. Sur
            plusieurs jours, la ressource est tenue nuits comprises. De 1 à {MAX_REQUEST_DAYS_LIMIT} jours.
          </p>
          <div className="grid gap-4 sm:grid-cols-3">
            {maxDays.map((item) => {
              const id = `maxDays-${item.key}`
              const error = state?.fieldErrors?.[item.key]
              return (
                <div key={item.key}>
                  <label className="text-sm font-medium" htmlFor={id}>{item.label}</label>
                  <input
                    className={field}
                    id={id}
                    name={`maxDays.${item.key}`}
                    type="number"
                    min={1}
                    max={MAX_REQUEST_DAYS_LIMIT}
                    step={1}
                    required
                    defaultValue={item.value}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? `${id}-error` : `${id}-hint`}
                  />
                  {error ? (
                    <span id={`${id}-error`} className="mt-1 block text-xs text-destructive">{error}</span>
                  ) : (
                    <span id={`${id}-hint`} className="mt-1 block text-xs text-muted-foreground">Par défaut : {formatDays(item.defaultValue)}.</span>
                  )}
                </div>
              )
            })}
          </div>
        </fieldset>
      )}
      {state?.saved && <p role="status" className="text-sm text-primary">Délais et durées enregistrés.</p>}
      <button disabled={pending} className="self-start rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50">{pending ? 'Enregistrement…' : 'Enregistrer'}</button>
    </form>
  )
}
