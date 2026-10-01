'use client'

import { useActionState } from 'react'

import Link from 'next/link'

import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import { billingPeriodLabels } from '../contrats/labels.ts'
import {
  FieldError,
  FieldHint,
  PendingAnnouncement,
  TextField,
  describedBy,
  fieldClass,
  labelClass,
  primaryButtonClass,
} from './champs.tsx'
import { saveOfferAction, type OfferFormState } from './offres-actions.ts'
import {
  MAX_COMMITMENT_MONTHS,
  offerHeaderLabels,
  type OfferHeaderValues,
} from './offres-regles.ts'
import { billingPeriods } from './schema.ts'

/**
 * En-tête d'une offre groupée (R09) : nom, description, période de
 * facturation et engagement proposés au contrat qui en sera tiré. Les lignes
 * s'ajoutent ensuite, sur la page de l'offre.
 */
export function OfferForm({ id, defaults }: { id?: string; defaults: OfferHeaderValues }) {
  const [state, formAction, pending] = useActionState<OfferFormState, FormData>(
    saveOfferAction,
    null,
  )
  const values = state?.values ?? defaults
  const errors = state?.fieldErrors ?? {}

  return (
    <form
      key={JSON.stringify(state?.values ?? '')}
      action={formAction}
      noValidate
      className="flex max-w-3xl flex-col gap-5"
    >
      {id && <input type="hidden" name="id" value={id} />}

      <ErrorSummary
        errors={state?.fieldErrors as Record<string, string> | undefined}
        labels={offerHeaderLabels}
        message={state?.message}
      />

      <TextField
        label="Nom de l’offre"
        name="name"
        required
        autoComplete="off"
        maxLength={120}
        defaultValue={values.name}
        error={errors.name}
        hint="Tel qu’il sera présenté au client : « Domiciliation Premium »."
      />

      <div>
        <label className={labelClass} htmlFor="description">
          Description <span className="font-normal text-muted-foreground">(facultatif)</span>
        </label>
        <textarea
          id="description"
          name="description"
          rows={2}
          defaultValue={values.description}
          className={`${fieldClass} mt-1`}
        />
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label className={labelClass} htmlFor="billingPeriod">
            Période de facturation
          </label>
          <select
            id="billingPeriod"
            name="billingPeriod"
            defaultValue={values.billingPeriod}
            {...describedBy('billingPeriod', errors.billingPeriod, true)}
            className={`${fieldClass} mt-1`}
          >
            {billingPeriods.map((period) => (
              <option key={period} value={period}>
                {billingPeriodLabels[period]}
              </option>
            ))}
          </select>
          <FieldError name="billingPeriod" error={errors.billingPeriod} />
          <FieldHint name="billingPeriod">
            Le prix de l’offre est celui d’une période : ses quantités sont dues à chaque période.
          </FieldHint>
        </div>

        <TextField
          label="Engagement proposé"
          name="commitmentMonths"
          optional
          type="number"
          min={1}
          max={MAX_COMMITMENT_MONTHS}
          step={1}
          inputMode="numeric"
          suffix="mois"
          defaultValue={values.commitmentMonths}
          error={errors.commitmentMonths}
          hint="Vide : sans engagement. Repris par le contrat tiré de l’offre."
        />
      </div>

      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className={primaryButtonClass}>
          {pending ? 'Enregistrement…' : id ? 'Enregistrer' : 'Créer l’offre'}
        </button>
        <Link
          href={id ? `/offres/${id}` : '/offres'}
          className="text-sm text-muted-foreground hover:underline"
        >
          Annuler
        </Link>
        <PendingAnnouncement pending={pending} label="Enregistrement en cours" />
      </div>
    </form>
  )
}
