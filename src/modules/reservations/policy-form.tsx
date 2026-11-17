'use client'

import { useActionState } from 'react'
import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import { formatDays, MAX_REQUEST_DAYS_LIMIT } from './durees.ts'
import { saveRequestPolicyAction } from './policy-actions.ts'
import { clientRulesBounds, type RequestPolicy } from './request-policy.ts'

const field = 'mt-1 w-full rounded-sm border border-border bg-white px-3 py-2 text-sm aria-[invalid=true]:border-destructive'

/** Astérisque des champs obligatoires. À remplacer par le composant commun du lot 1 à la fusion. */
function Requis() {
  return (
    <span aria-hidden="true" className="ml-0.5 text-primary">
      *
    </span>
  )
}

/** Durée maximale d'un produit, telle que l'écran la règle (ADR 061). */
export type MaxDaysSetting = { key: string; label: string; value: number; defaultValue: number }

/** Formules des bureaux et délai de modification par le client (ADR 076). */
export type ClientRules = { bookingMaxWeeks: number; bookingMaxMonths: number; bookingChangeDays: number }

const ruleLabels: Record<keyof ClientRules, string> = {
  bookingMaxWeeks: 'Location à la semaine : semaines au plus',
  bookingMaxMonths: 'Location au mois : mois au plus',
  bookingChangeDays: 'Modification et annulation par le client : jours avant le début',
}

export function RequestPolicyForm({ policy, maxDays, rules }: { policy: RequestPolicy; maxDays: MaxDaysSetting[]; rules: ClientRules }) {
  const [state, action, pending] = useActionState(saveRequestPolicyAction, null)
  // Le résumé mène à chaque valeur refusée, par l'identifiant de son champ.
  const summaryErrors = Object.fromEntries(
    Object.entries(state?.fieldErrors ?? {}).map(([key, message]) => [key in ruleLabels ? key : `maxDays-${key}`, message]),
  )
  const summaryLabels = {
    ...Object.fromEntries(maxDays.map((item) => [`maxDays-${item.key}`, `Durée maximale — ${item.label}`])),
    ...ruleLabels,
  }
  const ruleError = (name: keyof ClientRules) => state?.fieldErrors?.[name]
  return (
    <form action={action} className="flex flex-col gap-4">
      <ErrorSummary errors={summaryErrors} labels={summaryLabels} message={state?.error} />
      <p className="text-sm text-muted-foreground">Ces délais s’appliquent aux demandes du site public et de l’espace client. L’équipe peut toujours réserver depuis le planning admin. Les champs marqués * sont obligatoires.</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="text-sm font-medium" htmlFor="bookingLeadHours">
          Préavis minimum (heures)<Requis />
          <input className={field} id="bookingLeadHours" name="bookingLeadHours" type="number" min={0} max={8759} step={1} required aria-required="true" defaultValue={policy.bookingLeadHours} />
          <span className="mt-1 block text-xs font-normal text-muted-foreground">0 : sans préavis. 48 : au moins deux jours avant.</span>
        </label>
        <label className="text-sm font-medium" htmlFor="bookingHorizonDays">
          Réservation à l’avance (jours maximum)<Requis />
          <input className={field} id="bookingHorizonDays" name="bookingHorizonDays" type="number" min={1} max={365} step={1} required aria-required="true" defaultValue={policy.bookingHorizonDays} />
        </label>
      </div>
      {maxDays.length > 0 && (
        <fieldset className="flex flex-col gap-3">
          <legend className="text-sm font-medium">Durée maximale d’une demande en ligne (jours d’affilée)</legend>
          <p className="text-xs text-muted-foreground">
            Comptée du jour du début au jour de la fin : 1, le jour même seulement ; 3, du lundi au mercredi. La
            ressource est réservée sur toute la période ; le client y accède aux heures d’ouverture. De 1 à{' '}
            {MAX_REQUEST_DAYS_LIMIT} jours.
          </p>
          <div className="grid gap-4 sm:grid-cols-3">
            {maxDays.map((item) => {
              const id = `maxDays-${item.key}`
              const error = state?.fieldErrors?.[item.key]
              return (
                <div key={item.key}>
                  <label className="text-sm font-medium" htmlFor={id}>{item.label}<Requis /></label>
                  <input
                    className={field}
                    id={id}
                    name={`maxDays.${item.key}`}
                    type="number"
                    min={1}
                    max={MAX_REQUEST_DAYS_LIMIT}
                    step={1}
                    required
                    aria-required="true"
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
      {/* Formules des bureaux et délai de modification par le client (ADR 076). */}
      <fieldset className="flex flex-col gap-3">
        <legend className="text-sm font-medium">Bureaux à la semaine ou au mois, et modifications par le client</legend>
        <p className="text-xs text-muted-foreground">
          Les formules de chaque bureau se cochent sur sa fiche. Une demande en ligne à la semaine ou au mois ne
          dépasse pas ces plafonds ; au-delà, le client passe par l’accueil. Le client modifie ou annule lui-même
          une demande ou une réservation jusqu’au nombre de jours indiqué avant son début (0 : jusqu’au début).
        </p>
        <div className="grid gap-4 sm:grid-cols-3">
          {(
            [
              ['bookingMaxWeeks', 'Par défaut : 4 semaines.'],
              ['bookingMaxMonths', 'Par défaut : 12 mois.'],
              ['bookingChangeDays', 'Par défaut : 7 jours.'],
            ] as const
          ).map(([name, hint]) => {
            const { min, max } = clientRulesBounds[name]
            const error = ruleError(name)
            return (
              <div key={name}>
                <label className="text-sm font-medium" htmlFor={name}>{ruleLabels[name]}<Requis /></label>
                <input
                  className={field}
                  id={name}
                  name={name}
                  type="number"
                  min={min}
                  max={max}
                  step={1}
                  required
                  aria-required="true"
                  defaultValue={rules[name]}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? `${name}-error` : `${name}-hint`}
                />
                {error ? (
                  <span id={`${name}-error`} className="mt-1 block text-xs text-destructive">{error}</span>
                ) : (
                  <span id={`${name}-hint`} className="mt-1 block text-xs text-muted-foreground">{hint}</span>
                )}
              </div>
            )
          })}
        </div>
      </fieldset>
      {state?.saved && <p role="status" className="text-sm text-primary">Délais et durées enregistrés.</p>}
      <p aria-live="polite" className="sr-only">{pending ? 'Enregistrement en cours.' : ''}</p>
      <button disabled={pending} className="self-start rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50">{pending ? 'Enregistrement…' : 'Enregistrer'}</button>
    </form>
  )
}
