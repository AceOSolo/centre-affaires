'use client'

import { useActionState } from 'react'

import Link from 'next/link'

import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import { createRatePlanAction, updateRatePlanAction, type FormState } from './actions.ts'
import { ratePlanFieldLabels } from './grilles-formulaire.ts'
import type { RatePlan } from './schema.ts'

const fieldClass =
  'w-full rounded-sm border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/40 aria-[invalid=true]:border-destructive'
const labelClass = 'block text-sm font-medium text-foreground'

/**
 * Création d'une grille, ou modification de son nom, de ses dates de validité
 * et de son rôle de grille par défaut (R08). Les prix s'ajoutent ensuite, ligne
 * par ligne.
 */
export function RatePlanForm({
  plan,
}: {
  /** Grille à modifier ; absente : création. */
  plan?: Pick<RatePlan, 'id' | 'name' | 'validFrom' | 'validTo' | 'isDefault'>
}) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    plan ? updateRatePlanAction : createRatePlanAction,
    null,
  )
  const errors = state?.fieldErrors ?? {}
  const value = (key: 'name' | 'validFrom' | 'validTo') => state?.values?.[key] ?? plan?.[key] ?? ''
  const invalid = (key: string, hintId?: string) => ({
    'aria-invalid': errors[key] ? true : undefined,
    'aria-describedby':
      [hintId, errors[key] && `${key}-error`].filter(Boolean).join(' ') || undefined,
  })

  return (
    <form
      // Remonté après un échec pour reprendre la saisie, que React efface à la
      // fin de l'envoi.
      key={JSON.stringify(state?.values ?? {})}
      action={formAction}
      className="flex max-w-2xl flex-col gap-5"
    >
      {plan && <input type="hidden" name="id" value={plan.id} />}
      <ErrorSummary errors={state?.fieldErrors} labels={ratePlanFieldLabels} message={state?.error} />
      {state?.saved && (
        <p role="status" className="rounded-md border border-primary/20 bg-primary/5 px-4 py-3 text-sm">
          Grille enregistrée. Les prochains devis en tiennent compte ; une réservation déjà chiffrée
          garde son prix.
        </p>
      )}

      <div>
        <label className={labelClass} htmlFor="name">
          {ratePlanFieldLabels.name}
        </label>
        <input
          id="name"
          name="name"
          required
          maxLength={120}
          defaultValue={value('name')}
          {...invalid('name')}
          className={`${fieldClass} mt-1`}
        />
        <FieldError name="name" error={errors.name} />
      </div>

      <fieldset>
        <legend className="text-sm font-medium text-foreground">Validité</legend>
        <p id="validity-hint" className="mt-1 text-xs text-muted-foreground">
          Bornes comprises, jour du centre. Hors de ces dates, la grille ne chiffre aucune
          réservation : le devis passe à une autre grille, ou annonce que le créneau n’a pas de
          prix.
        </p>
        <div className="mt-3 grid gap-5 sm:grid-cols-2">
          <div>
            <label className={labelClass} htmlFor="validFrom">
              {ratePlanFieldLabels.validFrom}{' '}
              <span className="font-normal text-muted-foreground">(facultatif)</span>
            </label>
            <input
              id="validFrom"
              name="validFrom"
              type="date"
              defaultValue={value('validFrom')}
              {...invalid('validFrom', 'validity-hint')}
              className={`${fieldClass} mt-1`}
            />
            <FieldError name="validFrom" error={errors.validFrom} />
          </div>
          <div>
            <label className={labelClass} htmlFor="validTo">
              {ratePlanFieldLabels.validTo}{' '}
              <span className="font-normal text-muted-foreground">(facultatif)</span>
            </label>
            <input
              id="validTo"
              name="validTo"
              type="date"
              defaultValue={value('validTo')}
              {...invalid('validTo', 'validity-hint')}
              className={`${fieldClass} mt-1`}
            />
            <FieldError name="validTo" error={errors.validTo} />
          </div>
        </div>
      </fieldset>

      <div className="flex items-start gap-3 rounded-md border border-border px-4 py-3">
        <input
          id="isDefault"
          name="isDefault"
          type="checkbox"
          defaultChecked={plan?.isDefault ?? false}
          aria-describedby="isDefault-hint"
          className="mt-1"
        />
        <div>
          <label className="text-sm font-medium" htmlFor="isDefault">
            Grille par défaut du centre
          </label>
          <p id="isDefault-hint" className="text-xs text-muted-foreground">
            Appliquée aux réservations des clients dont le contrat ne désigne pas de grille, et à la
            page publique, pendant ses dates de validité. Plusieurs grilles par défaut peuvent se
            suivre — préparez celle de l’an prochain d’avance — mais pas se recouvrir.
          </p>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50"
        >
          {pending ? 'Enregistrement…' : plan ? 'Enregistrer la grille' : 'Créer la grille'}
        </button>
        {!plan && (
          <Link href="/tarifs" className="text-sm text-muted-foreground hover:underline">
            Annuler
          </Link>
        )}
      </div>
    </form>
  )
}

function FieldError({ name, error }: { name: string; error?: string }) {
  if (!error) return null
  return (
    <p id={`${name}-error`} role="alert" className="mt-1 text-xs text-destructive">
      {error}
    </p>
  )
}
