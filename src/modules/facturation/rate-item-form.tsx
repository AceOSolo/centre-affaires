'use client'

import { useActionState, useState } from 'react'

import { resourceTypeLabels } from '../ressources/labels.ts'
import { resourceTypes, type Resource, type ResourceType } from '../ressources/schema.ts'
import { addRatePlanItemAction, type FormState } from './actions.ts'
import { rateUnitLabels } from './labels.ts'
import { rateUnits } from './schema.ts'

const fieldClass =
  'w-full rounded-sm border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/40'
const labelClass = 'block text-sm font-medium text-foreground'

/**
 * Ajout d'une ligne de grille.
 *
 * Le choix « toutes les ressources de ce type » est le défaut : c'est le cas
 * courant, et une ligne nominative n'a de sens qu'en exception — elle l'emporte
 * alors sur celle du type.
 */
export function RateItemForm({
  ratePlanId,
  resources,
}: {
  ratePlanId: string
  resources: Resource[]
}) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    addRatePlanItemAction,
    null,
  )
  const [resourceType, setResourceType] = useState<ResourceType>('salle')

  const duType = resources.filter((resource) => resource.resourceType === resourceType)

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="ratePlanId" value={ratePlanId} />

      {state?.error && (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
        >
          {state.error}
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-4">
        <div>
          <label className={labelClass} htmlFor="resourceType">
            Type
          </label>
          <select
            id="resourceType"
            name="resourceType"
            value={resourceType}
            onChange={(event) => setResourceType(event.target.value as ResourceType)}
            className={`${fieldClass} mt-1`}
          >
            {resourceTypes.map((type) => (
              <option key={type} value={type}>
                {resourceTypeLabels[type]}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className={labelClass} htmlFor="resourceId">
            Ressource
          </label>
          <select id="resourceId" name="resourceId" defaultValue="" className={`${fieldClass} mt-1`}>
            <option value="">Toutes de ce type</option>
            {duType.map((resource) => (
              <option key={resource.id} value={resource.id}>
                {resource.code} — {resource.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className={labelClass} htmlFor="unit">
            Unité
          </label>
          <select
            id="unit"
            name="unit"
            defaultValue="hour"
            aria-describedby="unit-hint"
            className={`${fieldClass} mt-1`}
          >
            {rateUnits.map((unit) => (
              <option key={unit} value={unit}>
                {rateUnitLabels[unit]}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className={labelClass} htmlFor="amount">
            Prix HT
          </label>
          <div className="mt-1 flex items-center gap-2">
            <input
              id="amount"
              name="amount"
              required
              inputMode="decimal"
              placeholder="25,00"
              className={`${fieldClass} tabular-nums`}
            />
            <span className="text-sm text-muted-foreground">€</span>
          </div>
        </div>
      </div>

      {/* Le devis d'une réservation choisit lui-même l'unité (R11) : le dire
          évite de croire qu'une ligne « journée » s'applique à une heure. */}
      <p id="unit-hint" className="text-xs text-muted-foreground">
        L’heure, la demi-journée, la journée et la semaine chiffrent les réservations : le devis
        retient, pour chaque créneau, l’unité la moins chère que la grille propose (unité entamée
        due). Le mois et le forfait servent aux contrats et aux prestations.
      </p>

      <button
        type="submit"
        disabled={pending}
        className="self-start rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
      >
        {pending ? 'Ajout…' : 'Ajouter la ligne'}
      </button>
    </form>
  )
}
