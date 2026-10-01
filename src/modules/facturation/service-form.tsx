'use client'

import { useActionState, useState } from 'react'

import Link from 'next/link'

import { ErrorSummary } from '../../components/ui/error-summary.tsx'
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
import { rateUnitLabels, rateUnitSuffixes } from './labels.ts'
import { rateUnits, serviceNatures, type RateUnit, type ServiceNature } from './schema.ts'
import { saveServiceAction, type ServiceFormState } from './services-actions.ts'
import { serviceNatureHints, serviceNatureLabels } from './services-labels.ts'
import { serviceFieldLabels, type ServiceValues } from './services-regles.ts'

/**
 * Saisie d'un service du catalogue (R18), en création comme en modification.
 *
 * Les montants sont saisis en euros et en pourcentage ; l'action serveur les
 * convertit en centimes et en points de base (décision 5) : un formulaire
 * envoyé sans JavaScript donne le même résultat.
 */
export function ServiceForm({
  id,
  defaults,
  lockedCode = false,
  lockedNature = false,
}: {
  /** Service modifié ; absent en création. */
  id?: string
  defaults: ServiceValues
  /** Code déjà posé, ou imposé par un service attendu : il ne change pas. */
  lockedCode?: boolean
  /** En modification, la nature ne change pas. */
  lockedNature?: boolean
}) {
  const [state, formAction, pending] = useActionState<ServiceFormState, FormData>(
    saveServiceAction,
    null,
  )
  const values = state?.values ?? defaults
  const errors = state?.fieldErrors ?? {}
  const [nature, setNature] = useState<string>(values.nature)
  const [unit, setUnit] = useState<string>(values.unit)
  const isAct = nature === 'act'
  const shownUnit = (isAct ? 'unit' : unit) as RateUnit

  return (
    // Remonté après un refus pour reprendre les valeurs saisies : React
    // réinitialise le formulaire à la fin de chaque envoi.
    <form
      key={JSON.stringify(state?.values ?? '')}
      action={formAction}
      noValidate
      className="flex max-w-3xl flex-col gap-5"
    >
      {id && <input type="hidden" name="id" value={id} />}

      <ErrorSummary
        errors={state?.fieldErrors as Record<string, string> | undefined}
        labels={serviceFieldLabels}
        message={state?.message}
      />

      <div className="grid gap-5 sm:grid-cols-2">
        <TextField
          label="Nom"
          name="name"
          required
          autoComplete="off"
          maxLength={120}
          defaultValue={values.name}
          error={errors.name}
          hint="Tel qu’il figurera sur la facture et sur la fiche client."
        />
        <TextField
          label="Code"
          name="code"
          optional={!lockedCode}
          autoComplete="off"
          maxLength={64}
          readOnly={lockedCode}
          defaultValue={values.code}
          error={errors.code}
          hint={
            lockedCode
              ? 'Code stable, que la facturation recherche : il ne change plus.'
              : 'Seulement pour un service que l’application doit retrouver, comme courrier.ouverture. Ne change plus une fois posé.'
          }
        />
      </div>

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

      {/* `id` du nom du champ, focalisable : cible du lien du résumé d'erreurs. */}
      <fieldset
        id="nature"
        tabIndex={-1}
        aria-describedby={errors.nature ? 'nature-error' : undefined}
      >
        <legend className={labelClass}>Nature</legend>
        {lockedNature && <input type="hidden" name="nature" value={nature} />}
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          {serviceNatures.map((option) => (
            <div
              key={option}
              className="flex items-start gap-3 rounded-md border border-border bg-white px-4 py-3"
            >
              <input
                id={`nature-${option}`}
                type="radio"
                name={lockedNature ? undefined : 'nature'}
                value={option}
                checked={nature === option}
                disabled={lockedNature && nature !== option}
                onChange={() => setNature(option)}
                aria-describedby={`nature-${option}-hint`}
                className="mt-0.5 size-5 shrink-0 accent-primary"
              />
              <div>
                <label htmlFor={`nature-${option}`} className="text-sm font-medium">
                  {serviceNatureLabels[option as ServiceNature]}
                </label>
                <p id={`nature-${option}-hint`} className="text-xs text-muted-foreground">
                  {serviceNatureHints[option as ServiceNature]}
                </p>
              </div>
            </div>
          ))}
        </div>
        {lockedNature && (
          <p className="mt-1 text-xs text-muted-foreground">
            La nature ne change pas : créez un autre service pour vendre autrement.
          </p>
        )}
        <FieldError name="nature" error={errors.nature} />
      </fieldset>

      <div className="grid gap-5 sm:grid-cols-3">
        <div>
          <label className={labelClass} htmlFor="unit">
            Unité de facturation
          </label>
          {/* Un acte se facture toujours à l'unité : la liste est figée, la
              valeur part par le champ caché. */}
          {isAct && <input type="hidden" name="unit" value="unit" />}
          <select
            id="unit"
            name={isAct ? undefined : 'unit'}
            value={shownUnit}
            disabled={isAct}
            onChange={(event) => setUnit(event.target.value)}
            {...describedBy('unit', errors.unit, true)}
            className={`${fieldClass} mt-1`}
          >
            {rateUnits.map((option) => (
              <option key={option} value={option}>
                {rateUnitLabels[option]}
              </option>
            ))}
          </select>
          <FieldError name="unit" error={errors.unit} />
          <FieldHint name="unit">
            {isAct ? 'Un acte se facture à l’unité.' : 'Au mois pour un forfait mensuel.'}
          </FieldHint>
        </div>

        <TextField
          label="Prix unitaire HT"
          name="unitPrice"
          required
          inputMode="decimal"
          autoComplete="off"
          suffix="€"
          defaultValue={values.unitPrice}
          error={errors.unitPrice}
          hint={`${rateUnitSuffixes[shownUnit]}. Les souscriptions en cours gardent leur prix.`}
        />

        <TextField
          label="TVA"
          name="vatRate"
          required
          inputMode="decimal"
          autoComplete="off"
          suffix="%"
          defaultValue={values.vatRate}
          error={errors.vatRate}
          hint="20 % par défaut, à valider avec l’expert-comptable."
        />
      </div>

      <div className="flex items-start gap-3">
        <input
          id="isActive"
          name="isActive"
          type="checkbox"
          defaultChecked={values.isActive}
          aria-describedby="isActive-hint"
          className="mt-0.5 size-5 shrink-0 accent-primary"
        />
        <div>
          <label htmlFor="isActive" className="text-sm font-medium text-foreground">
            Proposé à la souscription
          </label>
          <p id="isActive-hint" className="text-xs text-muted-foreground">
            Décoché, le service n’est plus proposé ; ceux qui l’ont souscrit continuent d’être
            facturés.
          </p>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className={primaryButtonClass}>
          {pending ? 'Enregistrement…' : id ? 'Enregistrer' : 'Créer le service'}
        </button>
        <Link
          href={id ? `/services/${id}` : '/services'}
          className="text-sm text-muted-foreground hover:underline"
        >
          Annuler
        </Link>
        <PendingAnnouncement pending={pending} label="Enregistrement en cours" />
      </div>
    </form>
  )
}
