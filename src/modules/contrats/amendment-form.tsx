'use client'

import { useActionState, useState } from 'react'

import Link from 'next/link'

import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import { addDaysToIsoDate, formatCalendarDate } from '../../lib/dates.ts'
import { resourceTypeLabels } from '../ressources/labels.ts'
import { amendmentFieldLabels, type AmendmentField } from './avenant-formulaire.ts'
import {
  createAmendmentAction,
  updateAmendmentAction,
  type AmendmentFormState,
} from './avenants-actions.ts'
import type { AmendmentPriceMode } from './avenants.ts'
import type { LineFormValues } from './lignes.ts'
import { LinesEditor, lineErrorLabels, type LinesCatalog } from './lines-editor.tsx'

const fieldClass =
  'w-full rounded-sm border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/40 aria-[invalid=true]:border-destructive'
const labelClass = 'block text-sm font-medium text-foreground'

/** Valeurs d'un avenant au format des champs. */
export type AmendmentFormDefaults = {
  effectiveOn: string
  reason: string
  priceMode: AmendmentPriceMode
  amount: string
  changesResource: boolean
  resourceId: string
}

/**
 * Saisie d'un avenant (R12, ADR 025) : sa date d'effet, son objet, et ce
 * qu'il change — le prix (un nouveau montant, ou de nouvelles lignes qui
 * remplacent toutes les précédentes), la ressource, ou les deux.
 *
 * Les nouvelles lignes sont pré-remplies avec celles de la version en
 * vigueur : on les ajuste plutôt que de les ressaisir. Rien n'engage avant
 * la signature, sur la page de l'avenant.
 */
export function AmendmentForm({
  contractId,
  amendmentId,
  defaults,
  initialLines,
  catalog,
  resources,
  currentResourceLabel,
  currentAmountLabel,
  periodSuffix,
  currency,
  billedThrough = null,
}: {
  contractId: string
  /** Avenant brouillon à modifier ; absent en création. */
  amendmentId?: string
  defaults: AmendmentFormDefaults
  initialLines: LineFormValues[]
  catalog: LinesCatalog
  resources: { id: string; code: string; name: string; resourceType: keyof typeof resourceTypeLabels }[]
  currentResourceLabel: string
  currentAmountLabel: string
  periodSuffix: string
  currency: string
  /** Dernier jour déjà facturé du contrat : un nouveau prix prend effet après (ADR 032). */
  billedThrough?: string | null
}) {
  const [state, formAction, pending] = useActionState<AmendmentFormState, FormData>(
    amendmentId ? updateAmendmentAction : createAmendmentAction,
    null,
  )
  const [priceMode, setPriceMode] = useState<AmendmentPriceMode>(defaults.priceMode)
  const [changesResource, setChangesResource] = useState(defaults.changesResource)
  const [lines, setLines] = useState(initialLines)
  const [values, setValues] = useState({
    effectiveOn: defaults.effectiveOn,
    reason: defaults.reason,
    amount: defaults.amount,
    resourceId: defaults.resourceId,
  })
  const errors = state?.fieldErrors ?? {}

  const invalid = (field: AmendmentField, hint?: string) => ({
    id: field,
    name: field,
    'aria-invalid': errors[field] ? true : undefined,
    'aria-describedby': [hint, errors[field] && `${field}-error`].filter(Boolean).join(' ') || undefined,
  })

  return (
    <form action={formAction} className="flex flex-col gap-6">
      <ErrorSummary
        errors={state?.fieldErrors}
        labels={{ ...amendmentFieldLabels, ...lineErrorLabels(errors, lines) }}
        message={state?.error}
      />
      <input type="hidden" name="contractId" value={contractId} />
      {amendmentId && <input type="hidden" name="amendmentId" value={amendmentId} />}

      <div className="grid gap-5 sm:grid-cols-[12rem_1fr]">
        <div>
          <label className={labelClass} htmlFor="effectiveOn">
            Date d’effet
          </label>
          <input
            {...invalid('effectiveOn', 'effectiveOn-hint')}
            type="date"
            required
            value={values.effectiveOn}
            onChange={(event) => setValues({ ...values, effectiveOn: event.target.value })}
            className={`${fieldClass} mt-1`}
          />
          <p id="effectiveOn-hint" className="mt-1 text-xs text-muted-foreground">
            Premier jour de la nouvelle version.
            {billedThrough && (
              <>
                {' '}
                Contrat facturé jusqu’au <span className="tabular">{formatCalendarDate(billedThrough)}</span> : un
                nouveau prix prend effet au plus tôt le{' '}
                <span className="tabular">{formatCalendarDate(addDaysToIsoDate(billedThrough, 1))}</span>.
              </>
            )}
          </p>
          <FieldError name="effectiveOn" error={errors.effectiveOn} />
        </div>
        <div>
          <label className={labelClass} htmlFor="reason">
            Objet de l’avenant <span className="font-normal text-muted-foreground">(facultatif)</span>
          </label>
          <input
            {...invalid('reason', 'reason-hint')}
            maxLength={500}
            value={values.reason}
            onChange={(event) => setValues({ ...values, reason: event.target.value })}
            className={`${fieldClass} mt-1`}
          />
          <p id="reason-hint" className="mt-1 text-xs text-muted-foreground">
            Porté sur le document : « Indexation annuelle », « Passage au bureau 12 ».
          </p>
          <FieldError name="reason" error={errors.reason} />
        </div>
      </div>

      <fieldset className="flex flex-col gap-3 rounded-lg border border-border bg-white px-5 py-4">
        <legend className="px-1 text-sm font-semibold">Prix</legend>
        <p className="text-xs text-muted-foreground">Prix en vigueur : {currentAmountLabel}.</p>
        <div id="priceMode" tabIndex={-1} className="flex flex-col gap-2">
          {(
            [
              ['unchanged', 'Inchangé'],
              ['amount', 'Nouveau montant, sans détail'],
              ['lines', 'Nouvelles lignes, qui remplacent toutes les précédentes'],
            ] as const
          ).map(([mode, label]) => (
            <label key={mode} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="priceMode"
                value={mode}
                checked={priceMode === mode}
                onChange={() => setPriceMode(mode)}
                aria-describedby={errors.priceMode ? 'priceMode-error' : undefined}
                className="size-4 accent-primary"
              />
              {label}
            </label>
          ))}
        </div>
        <FieldError name="priceMode" error={errors.priceMode} />

        {priceMode === 'amount' && (
          <div className="max-w-xs">
            <label className={labelClass} htmlFor="amount">
              Nouveau montant HT (€)
            </label>
            <input
              {...invalid('amount', 'amount-hint')}
              inputMode="decimal"
              value={values.amount}
              onChange={(event) => setValues({ ...values, amount: event.target.value })}
              className={`${fieldClass} mt-1 tabular`}
            />
            <p id="amount-hint" className="mt-1 text-xs text-muted-foreground">
              {periodSuffix}, à la TVA du contrat.
            </p>
            <FieldError name="amount" error={errors.amount} />
          </div>
        )}

        {priceMode === 'lines' && (
          <LinesEditor
            lines={lines}
            setLines={setLines}
            catalog={catalog}
            errors={errors}
            periodSuffix={periodSuffix}
            currency={currency}
          />
        )}
      </fieldset>

      <fieldset className="flex flex-col gap-3 rounded-lg border border-border bg-white px-5 py-4">
        <legend className="px-1 text-sm font-semibold">Ressource</legend>
        <p className="text-xs text-muted-foreground">
          Ressource à la date d’effet sans cet avenant : {currentResourceLabel}.
        </p>
        <label className="flex items-center gap-2 text-sm" htmlFor="changesResource">
          <input
            id="changesResource"
            name="changesResource"
            type="checkbox"
            value="on"
            checked={changesResource}
            onChange={(event) => setChangesResource(event.target.checked)}
            className="size-4 accent-primary"
          />
          Changer la ressource à la date d’effet
        </label>
        {changesResource && (
          <div className="max-w-xl">
            <label className={labelClass} htmlFor="resourceId">
              Nouvelle ressource
            </label>
            <select
              {...invalid('resourceId', 'resourceId-hint')}
              value={values.resourceId}
              onChange={(event) => setValues({ ...values, resourceId: event.target.value })}
              className={`${fieldClass} mt-1`}
            >
              <option value="">Aucune — retirer la ressource</option>
              {resources.map((resource) => (
                <option key={resource.id} value={resource.id}>
                  {resource.code} — {resource.name} ({resourceTypeLabels[resource.resourceType]})
                </option>
              ))}
            </select>
            <p id="resourceId-hint" className="mt-1 text-xs text-muted-foreground">
              L’ancienne ressource reste occupée jusqu’à la veille, la nouvelle l’est à partir de la
              date d’effet, une fois l’avenant signé.
            </p>
            <FieldError name="resourceId" error={errors.resourceId} />
          </div>
        )}
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50"
        >
          {pending ? 'Enregistrement…' : 'Enregistrer le brouillon d’avenant'}
        </button>
        <Link
          href={amendmentId ? `/contrats/${contractId}/avenants/${amendmentId}` : `/contrats/${contractId}`}
          className="text-sm text-muted-foreground hover:underline"
        >
          Annuler
        </Link>
      </div>
      <p className="text-xs text-muted-foreground">
        Un brouillon d’avenant n’engage rien : il prend effet une fois signé.
      </p>
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
