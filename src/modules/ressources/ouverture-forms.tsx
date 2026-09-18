'use client'

import { useActionState } from 'react'

import {
  addClosureAction,
  addOpeningHourAction,
  setWeekdayHoursAction,
  type FormState,
} from './ouverture-actions.ts'
import { resourceTypeLabels, weekdayLabels, weekdays } from './labels.ts'
import type { Resource } from './schema.ts'

const fieldClass =
  'w-full rounded-md border border-border bg-white px-3 py-2 text-sm outline-none focus:border-primary'
const labelClass = 'block text-sm font-medium text-foreground'
const errorClass =
  'rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive'
const buttonClass =
  'rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50'

/** Sélecteur de ressource commun aux trois formulaires. */
function ResourceSelect({
  resources,
  id,
  centreLabel,
}: {
  resources: Resource[]
  id: string
  centreLabel: string
}) {
  return (
    <div>
      <label className={labelClass} htmlFor={id}>
        S’applique à
      </label>
      <select id={id} name="resourceId" defaultValue="" className={`${fieldClass} mt-1`}>
        <option value="">{centreLabel}</option>
        {resources.map((resource) => (
          <option key={resource.id} value={resource.id}>
            {resource.code} — {resource.name} ({resourceTypeLabels[resource.resourceType]})
          </option>
        ))}
      </select>
    </div>
  )
}

/**
 * Semaine type : mêmes horaires sur les jours cochés.
 *
 * Remplace les plages existantes de la cible au lieu de s'y ajouter — c'est ce
 * qu'on attend en corrigeant des horaires, et cela évite d'accumuler des
 * plages mortes qu'il faudrait ensuite retrouver une par une.
 */
export function WeekScheduleForm({ resources }: { resources: Resource[] }) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    setWeekdayHoursAction,
    null,
  )

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {state?.error && (
        <p role="alert" className={errorClass}>
          {state.error}
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <ResourceSelect resources={resources} id="week-resource" centreLabel="Tout le centre" />
        <div>
          <label className={labelClass} htmlFor="week-opensAt">
            Ouverture
          </label>
          <input
            id="week-opensAt"
            name="opensAt"
            type="time"
            required
            step={900}
            defaultValue="09:00"
            className={`${fieldClass} mt-1 tabular-nums`}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="week-closesAt">
            Fermeture
          </label>
          <input
            id="week-closesAt"
            name="closesAt"
            type="time"
            required
            step={900}
            defaultValue="18:00"
            className={`${fieldClass} mt-1 tabular-nums`}
          />
        </div>
      </div>

      <fieldset>
        <legend className={labelClass}>Jours ouvrés</legend>
        <div className="mt-2 flex flex-wrap gap-3">
          {[1, 2, 3, 4, 5].map((jour) => (
            <label key={jour} className="flex items-center gap-2 text-sm">
              <input type="checkbox" name={`jour-${jour}`} defaultChecked />
              {weekdayLabels[jour]}
            </label>
          ))}
        </div>
      </fieldset>

      <p className="text-xs text-muted-foreground">
        Remplace les horaires existants de la cible. Pour une pause déjeuner ou un
        samedi, ajouter ensuite une plage ci-dessous.
      </p>

      <button type="submit" disabled={pending} className={`${buttonClass} self-start`}>
        {pending ? 'Enregistrement…' : 'Appliquer la semaine type'}
      </button>
    </form>
  )
}

/** Ajout d'une plage isolée : un samedi, une coupure de midi, une nocturne. */
export function OpeningHourForm({ resources }: { resources: Resource[] }) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    addOpeningHourAction,
    null,
  )

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {state?.error && (
        <p role="alert" className={errorClass}>
          {state.error}
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-4">
        <ResourceSelect resources={resources} id="plage-resource" centreLabel="Tout le centre" />
        <div>
          <label className={labelClass} htmlFor="plage-weekday">
            Jour
          </label>
          <select id="plage-weekday" name="weekday" defaultValue="6" className={`${fieldClass} mt-1`}>
            {weekdays.map((jour) => (
              <option key={jour} value={jour}>
                {weekdayLabels[jour]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass} htmlFor="plage-opensAt">
            De
          </label>
          <input
            id="plage-opensAt"
            name="opensAt"
            type="time"
            required
            step={900}
            defaultValue="10:00"
            className={`${fieldClass} mt-1 tabular-nums`}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="plage-closesAt">
            À
          </label>
          <input
            id="plage-closesAt"
            name="closesAt"
            type="time"
            required
            step={900}
            defaultValue="16:00"
            aria-describedby="plage-hint"
            className={`${fieldClass} mt-1 tabular-nums`}
          />
          <p id="plage-hint" className="mt-1 text-xs text-muted-foreground">
            24:00 pour aller jusqu’à minuit.
          </p>
        </div>
      </div>

      <button type="submit" disabled={pending} className={`${buttonClass} self-start`}>
        {pending ? 'Ajout…' : 'Ajouter la plage'}
      </button>
    </form>
  )
}

/** Fermeture exceptionnelle : jours fériés, congés, travaux. */
export function ClosureForm({ resources }: { resources: Resource[] }) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(addClosureAction, null)

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {state?.error && (
        <p role="alert" className={errorClass}>
          {state.error}
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-4">
        <ResourceSelect resources={resources} id="fermeture-resource" centreLabel="Tout le centre" />
        <div>
          <label className={labelClass} htmlFor="fermeture-startsOn">
            Du
          </label>
          <input
            id="fermeture-startsOn"
            name="startsOn"
            type="date"
            required
            className={`${fieldClass} mt-1`}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="fermeture-endsOn">
            Au <span className="font-normal text-muted-foreground">(inclus)</span>
          </label>
          <input
            id="fermeture-endsOn"
            name="endsOn"
            type="date"
            aria-describedby="fermeture-hint"
            className={`${fieldClass} mt-1`}
          />
          <p id="fermeture-hint" className="mt-1 text-xs text-muted-foreground">
            Vide pour une seule journée.
          </p>
        </div>
        <div>
          <label className={labelClass} htmlFor="fermeture-reason">
            Motif
          </label>
          <input
            id="fermeture-reason"
            name="reason"
            placeholder="Jour férié"
            className={`${fieldClass} mt-1`}
          />
        </div>
      </div>

      <button type="submit" disabled={pending} className={`${buttonClass} self-start`}>
        {pending ? 'Ajout…' : 'Ajouter la fermeture'}
      </button>
    </form>
  )
}
