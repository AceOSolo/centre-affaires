'use client'

import { useActionState, useState } from 'react'

import Link from 'next/link'

import type { Client } from '../clients/schema.ts'
import type { RatePlan } from '../facturation/schema.ts'
import { resourceTypeLabels } from '../ressources/labels.ts'
import type { Resource } from '../ressources/schema.ts'
import { createContractAction, type FormState } from './actions.ts'
import { billingPeriodLabels, billingPeriodSuffixes, contractTypeLabels } from './labels.ts'
import { billingPeriods, contractTypes, type BillingPeriod } from './schema.ts'

const fieldClass =
  'w-full rounded-sm border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/40'
const labelClass = 'block text-sm font-medium text-foreground'

/**
 * Saisie d'un contrat.
 *
 * Le montant est saisi en euros et converti en centimes par l'action serveur
 * (décision 5) : la conversion ne peut pas vivre ici, un formulaire soumis sans
 * JavaScript doit donner le même résultat.
 */
export function ContractForm({
  clients,
  ratePlans,
  resources,
  defaultClientId,
}: {
  clients: Client[]
  ratePlans: RatePlan[]
  resources: Resource[]
  defaultClientId?: string
}) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    createContractAction,
    null,
  )
  const [billingPeriod, setBillingPeriod] = useState<BillingPeriod>('monthly')

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

  return (
    <form action={formAction} className="flex max-w-3xl flex-col gap-5">
      {state?.error && (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
        >
          {state.error}
        </p>
      )}

      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label className={labelClass} htmlFor="clientId">
            Client
          </label>
          <select
            id="clientId"
            name="clientId"
            required
            defaultValue={defaultClientId ?? clients[0]?.id}
            className={`${fieldClass} mt-1`}
          >
            {clients.map((client) => (
              <option key={client.id} value={client.id}>
                {client.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className={labelClass} htmlFor="reference">
            Référence
          </label>
          <input
            id="reference"
            name="reference"
            required
            placeholder="DOM-2026-014"
            className={`${fieldClass} mt-1 font-mono`}
          />
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
            defaultValue="domiciliation"
            className={`${fieldClass} mt-1`}
          >
            {contractTypes.map((type) => (
              <option key={type} value={type}>
                {contractTypeLabels[type]}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className={labelClass} htmlFor="resourceId">
            Ressource attribuée <span className="font-normal text-muted-foreground">(facultatif)</span>
          </label>
          <select id="resourceId" name="resourceId" defaultValue="" className={`${fieldClass} mt-1`}>
            <option value="">Aucune</option>
            {resources.map((resource) => (
              <option key={resource.id} value={resource.id}>
                {resource.code} — {resource.name} ({resourceTypeLabels[resource.resourceType]})
              </option>
            ))}
          </select>
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
            className={`${fieldClass} mt-1`}
          />
        </div>
        <div>
          <label className={labelClass} htmlFor="endsOn">
            Fin <span className="font-normal text-muted-foreground">(facultatif)</span>
          </label>
          <input id="endsOn" name="endsOn" type="date" className={`${fieldClass} mt-1`} />
          <p className="mt-1 text-xs text-muted-foreground">
            Vide : durée indéterminée, jusqu’à résiliation.
          </p>
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
            className={`${fieldClass} mt-1`}
          >
            {billingPeriods.map((period) => (
              <option key={period} value={period}>
                {billingPeriodLabels[period]}
              </option>
            ))}
          </select>
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
              inputMode="decimal"
              placeholder="900,00"
              aria-describedby="amount-hint"
              className={`${fieldClass} tabular-nums`}
            />
            <span className="text-sm text-muted-foreground">€</span>
          </div>
          <p id="amount-hint" className="mt-1 text-xs text-muted-foreground">
            {billingPeriodSuffixes[billingPeriod]}
          </p>
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
              defaultValue={90}
              className={`${fieldClass} tabular-nums`}
            />
            <span className="text-sm text-muted-foreground">jours</span>
          </div>
        </div>
      </div>

      <div>
        <label className={labelClass} htmlFor="ratePlanId">
          Grille tarifaire <span className="font-normal text-muted-foreground">(facultatif)</span>
        </label>
        <select id="ratePlanId" name="ratePlanId" defaultValue="" className={`${fieldClass} mt-1`}>
          <option value="">Grille par défaut du centre</option>
          {ratePlans.map((plan) => (
            <option key={plan.id} value={plan.id}>
              {plan.name}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-muted-foreground">
          S’applique aux prestations hors forfait : salles de réunion, véhicules.
        </p>
      </div>

      <div>
        <label className={labelClass} htmlFor="notes">
          Notes <span className="font-normal text-muted-foreground">(facultatif)</span>
        </label>
        <textarea id="notes" name="notes" rows={3} className={`${fieldClass} mt-1`} />
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50"
        >
          {pending ? 'Enregistrement…' : 'Créer le contrat'}
        </button>
        <Link href="/contrats" className="text-sm text-muted-foreground hover:underline">
          Annuler
        </Link>
      </div>
      <p className="text-xs text-muted-foreground">
        Le contrat est créé en brouillon. Il devient facturable une fois activé.
      </p>
    </form>
  )
}
