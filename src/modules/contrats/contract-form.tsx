'use client'

import { useActionState, useState } from 'react'

import Link from 'next/link'

import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import type { RatePlan } from '../facturation/schema.ts'
import { resourceTypeLabels } from '../ressources/labels.ts'
import type { Resource } from '../ressources/schema.ts'
import { createContractAction, updateContractAction, type FormState } from './actions.ts'
import { contractFieldLabels } from './formulaire.ts'
import { billingPeriodLabels, billingPeriodSuffixes, contractTypeLabels } from './labels.ts'
import { billingPeriods, contractTypes, type BillingPeriod } from './schema.ts'

const fieldClass =
  'w-full rounded-sm border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/40 aria-[invalid=true]:border-destructive'
const labelClass = 'block text-sm font-medium text-foreground'

/** Valeurs d'un brouillon à modifier, au format des champs. */
export type ContractFormDefaults = {
  id: string
  clientId: string
  reference: string
  contractType: string
  resourceId: string
  startsOn: string
  endsOn: string
  billingPeriod: BillingPeriod
  amount: string
  noticeDays: string
  ratePlanId: string
  notes: string
  vatRate: string
  commitmentMonths: string
  tacitRenewal: string
  renewalMonths: string
}

/**
 * Saisie d'un contrat, en création comme en modification d'un brouillon : les
 * mêmes champs et les mêmes règles (`formulaire.ts`), vérifiées par l'action
 * serveur.
 *
 * Le montant est saisi en euros et converti en centimes par l'action serveur
 * (décision 5) : la conversion ne peut pas vivre ici, un formulaire soumis sans
 * JavaScript doit donner le même résultat.
 *
 * En création, la référence est facultative : vide, la base attribue le
 * numéro suivant de la série du centre (ADR 021).
 */
export function ContractForm({
  clients,
  ratePlans,
  resources,
  defaultClientId,
  contract,
  amountFromLines = false,
}: {
  clients: { id: string; name: string }[]
  ratePlans: RatePlan[]
  resources: Resource[]
  defaultClientId?: string
  /** Brouillon à modifier ; absent en création. */
  contract?: ContractFormDefaults
  /**
   * Le brouillon a des lignes récurrentes : son montant en est la somme, tenue
   * par la base (ADR 025). Le champ est alors en lecture seule.
   */
  amountFromLines?: boolean
}) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    contract ? updateContractAction : createContractAction,
    null,
  )
  const [billingPeriod, setBillingPeriod] = useState<BillingPeriod>(
    contract?.billingPeriod ?? 'monthly',
  )
  const errors = state?.fieldErrors ?? {}
  // Saisie rendue après un échec, sinon le brouillon, sinon les valeurs par défaut.
  const value = (field: keyof ContractFormDefaults, fallback = '') =>
    state?.values?.[field] ?? contract?.[field] ?? fallback

  if (clients.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border bg-white px-6 py-12 text-center text-sm text-muted-foreground">
        Aucun client enregistré.{' '}
        <Link href="/clients/nouveau" className="underline underline-offset-2">
          Créer un client
        </Link>{' '}
        avant d’établir un contrat.
      </p>
    )
  }

  /** Attributs d'accessibilité d'un champ : son aide, et son erreur s'il en a une. */
  const invalid = (field: string, hasHint = false) => ({
    'aria-invalid': errors[field] ? true : undefined,
    'aria-describedby':
      [hasHint && `${field}-hint`, errors[field] && `${field}-error`].filter(Boolean).join(' ') ||
      undefined,
  })

  return (
    // Remonté après un échec pour reprendre les valeurs saisies : React
    // réinitialise le formulaire à la fin de chaque envoi.
    <form
      key={JSON.stringify(state?.values ?? {})}
      action={formAction}
      className="flex max-w-3xl flex-col gap-5"
    >
      <ErrorSummary
        errors={state?.fieldErrors as Record<string, string> | undefined}
        labels={contractFieldLabels}
        message={state?.error}
      />

      {contract && <input type="hidden" name="id" value={contract.id} />}

      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label className={labelClass} htmlFor="clientId">
            Client
          </label>
          <select
            id="clientId"
            name="clientId"
            required
            defaultValue={value('clientId', defaultClientId ?? '')}
            {...invalid('clientId')}
            className={`${fieldClass} mt-1`}
          >
            <option value="" disabled>
              Choisir un client…
            </option>
            {clients.map((client) => (
              <option key={client.id} value={client.id}>
                {client.name}
              </option>
            ))}
          </select>
          <FieldError name="clientId" error={errors.clientId} />
        </div>

        <div>
          <label className={labelClass} htmlFor="reference">
            Référence{' '}
            {!contract && <span className="font-normal text-muted-foreground">(facultatif)</span>}
          </label>
          <input
            id="reference"
            name="reference"
            required={Boolean(contract)}
            maxLength={50}
            autoComplete="off"
            defaultValue={value('reference')}
            {...invalid('reference', true)}
            className={`${fieldClass} mt-1 tabular`}
          />
          <p id="reference-hint" className="mt-1 text-xs text-muted-foreground">
            {contract
              ? 'Attribuée à la création. Modifiable tant que le contrat est un brouillon.'
              : 'Laissez vide : le numéro suivant de la série du centre est attribué à l’enregistrement, au format CT-AAAA-NNNN.'}
          </p>
          <FieldError name="reference" error={errors.reference} />
        </div>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label className={labelClass} htmlFor="contractType">
            Type
          </label>
          <select
            id="contractType"
            name="contractType"
            defaultValue={value('contractType', 'domiciliation')}
            {...invalid('contractType')}
            className={`${fieldClass} mt-1`}
          >
            {contractTypes.map((type) => (
              <option key={type} value={type}>
                {contractTypeLabels[type]}
              </option>
            ))}
          </select>
          <FieldError name="contractType" error={errors.contractType} />
        </div>

        <div>
          <label className={labelClass} htmlFor="resourceId">
            Ressource attribuée <span className="font-normal text-muted-foreground">(facultatif)</span>
          </label>
          <select
            id="resourceId"
            name="resourceId"
            defaultValue={value('resourceId')}
            {...invalid('resourceId', true)}
            className={`${fieldClass} mt-1`}
          >
            <option value="">Aucune</option>
            {resources.map((resource) => (
              <option key={resource.id} value={resource.id}>
                {resource.code} — {resource.name} ({resourceTypeLabels[resource.resourceType]})
              </option>
            ))}
          </select>
          <p id="resourceId-hint" className="mt-1 text-xs text-muted-foreground">
            Occupée pendant toute la période du contrat, dès son activation.
          </p>
          <FieldError name="resourceId" error={errors.resourceId} />
        </div>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label className={labelClass} htmlFor="startsOn">
            Début
          </label>
          <input
            id="startsOn"
            name="startsOn"
            type="date"
            required
            defaultValue={value('startsOn')}
            {...invalid('startsOn')}
            className={`${fieldClass} mt-1`}
          />
          <FieldError name="startsOn" error={errors.startsOn} />
        </div>
        <div>
          <label className={labelClass} htmlFor="endsOn">
            Fin <span className="font-normal text-muted-foreground">(facultatif)</span>
          </label>
          <input
            id="endsOn"
            name="endsOn"
            type="date"
            defaultValue={value('endsOn')}
            {...invalid('endsOn', true)}
            className={`${fieldClass} mt-1`}
          />
          <p id="endsOn-hint" className="mt-1 text-xs text-muted-foreground">
            Vide : durée indéterminée, jusqu’à résiliation.
          </p>
          <FieldError name="endsOn" error={errors.endsOn} />
        </div>
      </div>

      <div className="grid gap-5 sm:grid-cols-3">
        <div>
          <label className={labelClass} htmlFor="billingPeriod">
            Périodicité
          </label>
          <select
            id="billingPeriod"
            name="billingPeriod"
            value={billingPeriod}
            onChange={(event) => setBillingPeriod(event.target.value as BillingPeriod)}
            {...invalid('billingPeriod')}
            className={`${fieldClass} mt-1`}
          >
            {billingPeriods.map((period) => (
              <option key={period} value={period}>
                {billingPeriodLabels[period]}
              </option>
            ))}
          </select>
          <FieldError name="billingPeriod" error={errors.billingPeriod} />
        </div>

        <div>
          <label className={labelClass} htmlFor="amount">
            Montant HT
          </label>
          <div className="mt-1 flex items-center gap-2">
            <input
              id="amount"
              name="amount"
              required
              readOnly={amountFromLines}
              inputMode="decimal"
              placeholder="900,00"
              defaultValue={value('amount')}
              {...invalid('amount', true)}
              className={`${fieldClass} tabular read-only:bg-muted`}
            />
            <span className="text-sm text-muted-foreground">€</span>
          </div>
          <p id="amount-hint" className="mt-1 text-xs text-muted-foreground">
            {billingPeriodSuffixes[billingPeriod]}
            {amountFromLines && contract && (
              <>
                {' '}— somme des lignes récurrentes.{' '}
                <Link href={`/contrats/${contract.id}/lignes`} className="underline underline-offset-2">
                  Modifier les lignes
                </Link>
              </>
            )}
          </p>
          <FieldError name="amount" error={errors.amount} />
        </div>

        <div>
          <label className={labelClass} htmlFor="noticeDays">
            Préavis
          </label>
          <div className="mt-1 flex items-center gap-2">
            <input
              id="noticeDays"
              name="noticeDays"
              type="number"
              min={0}
              step={1}
              defaultValue={value('noticeDays', '90')}
              {...invalid('noticeDays')}
              className={`${fieldClass} tabular`}
            />
            <span className="text-sm text-muted-foreground">jours</span>
          </div>
          <FieldError name="noticeDays" error={errors.noticeDays} />
        </div>
      </div>

      <div className="grid gap-5 sm:grid-cols-4">
        <div>
          <label className={labelClass} htmlFor="vatRate">
            TVA
          </label>
          <div className="mt-1 flex items-center gap-2">
            <input
              id="vatRate"
              name="vatRate"
              inputMode="decimal"
              defaultValue={value('vatRate', '20')}
              {...invalid('vatRate', true)}
              className={`${fieldClass} tabular`}
            />
            <span className="text-sm text-muted-foreground">%</span>
          </div>
          <p id="vatRate-hint" className="mt-1 text-xs text-muted-foreground">
            Du montant, quand le prix n’est pas détaillé en lignes.
          </p>
          <FieldError name="vatRate" error={errors.vatRate} />
        </div>

        <div>
          <label className={labelClass} htmlFor="commitmentMonths">
            Engagement <span className="font-normal text-muted-foreground">(facultatif)</span>
          </label>
          <div className="mt-1 flex items-center gap-2">
            <input
              id="commitmentMonths"
              name="commitmentMonths"
              inputMode="numeric"
              defaultValue={value('commitmentMonths')}
              {...invalid('commitmentMonths', true)}
              className={`${fieldClass} tabular`}
            />
            <span className="text-sm text-muted-foreground">mois</span>
          </div>
          <p id="commitmentMonths-hint" className="mt-1 text-xs text-muted-foreground">
            De date à date. Vide : sans engagement.
          </p>
          <FieldError name="commitmentMonths" error={errors.commitmentMonths} />
        </div>

        <div className="flex items-end pb-2">
          <label className="flex items-center gap-2 text-sm" htmlFor="tacitRenewal">
            <input
              id="tacitRenewal"
              name="tacitRenewal"
              type="checkbox"
              value="on"
              defaultChecked={value('tacitRenewal') === 'on'}
              className="size-4 accent-primary"
            />
            Reconduction tacite
          </label>
        </div>

        <div>
          <label className={labelClass} htmlFor="renewalMonths">
            Reconduit par
          </label>
          <div className="mt-1 flex items-center gap-2">
            <input
              id="renewalMonths"
              name="renewalMonths"
              inputMode="numeric"
              defaultValue={value('renewalMonths')}
              {...invalid('renewalMonths', true)}
              className={`${fieldClass} tabular`}
            />
            <span className="text-sm text-muted-foreground">mois</span>
          </div>
          <p id="renewalMonths-hint" className="mt-1 text-xs text-muted-foreground">
            Seulement avec la reconduction tacite.
          </p>
          <FieldError name="renewalMonths" error={errors.renewalMonths} />
        </div>
      </div>

      <div>
        <label className={labelClass} htmlFor="ratePlanId">
          Grille tarifaire <span className="font-normal text-muted-foreground">(facultatif)</span>
        </label>
        <select
          id="ratePlanId"
          name="ratePlanId"
          defaultValue={value('ratePlanId')}
          {...invalid('ratePlanId', true)}
          className={`${fieldClass} mt-1`}
        >
          <option value="">Grille par défaut du centre</option>
          {ratePlans.map((plan) => (
            <option key={plan.id} value={plan.id}>
              {plan.name}
            </option>
          ))}
        </select>
        <p id="ratePlanId-hint" className="mt-1 text-xs text-muted-foreground">
          S’applique aux prestations hors forfait : salles de réunion, véhicules.
        </p>
        <FieldError name="ratePlanId" error={errors.ratePlanId} />
      </div>

      <div>
        <label className={labelClass} htmlFor="notes">
          Notes <span className="font-normal text-muted-foreground">(facultatif)</span>
        </label>
        <textarea
          id="notes"
          name="notes"
          rows={3}
          defaultValue={value('notes')}
          className={`${fieldClass} mt-1`}
        />
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50"
        >
          {pending ? 'Enregistrement…' : contract ? 'Enregistrer le brouillon' : 'Créer le contrat'}
        </button>
        <Link
          href={contract ? `/contrats/${contract.id}` : '/contrats'}
          className="text-sm text-muted-foreground hover:underline"
        >
          Annuler
        </Link>
      </div>
      <p className="text-xs text-muted-foreground">
        {contract
          ? 'Le contrat reste en brouillon. Il devient facturable, et occupe sa ressource, une fois activé.'
          : 'Le contrat est créé en brouillon. Il devient facturable, et occupe sa ressource, une fois activé.'}
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
