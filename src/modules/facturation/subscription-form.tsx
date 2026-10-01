'use client'

import { useActionState, useState } from 'react'

import Link from 'next/link'

import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import {
  FieldError,
  FieldHint,
  PendingAnnouncement,
  describedBy,
  fieldClass,
  labelClass,
  primaryButtonClass,
} from './champs.tsx'
import { rateUnitSuffixes } from './labels.ts'
import { lineNetAmountCents } from './montants.ts'
import { bpToPercentInput, centsToAmountInput, parseInteger, parsePercentToBp } from './saisie.ts'
import type { RateUnit, ServiceNature } from './schema.ts'
import { serviceNatureLabels } from './services-labels.ts'
import {
  changeSubscriptionAction,
  subscribeAction,
  type SubscriptionFormState,
} from './souscriptions-actions.ts'
import {
  subscriptionFieldLabels,
  type DiscountKind,
  type SubscriptionValues,
} from './souscriptions-regles.ts'
import { formatCents, parseAmountToCents } from './tarifs.ts'

/** Un service proposé à la souscription, avec son prix du catalogue. */
export type SubscribableOption = {
  id: string
  name: string
  nature: ServiceNature
  unit: RateUnit
  unitPriceCents: number
  vatRateBp: number
  currency: string
}

const discountLabels: Record<DiscountKind, string> = {
  none: 'Aucune',
  percent: 'En pourcentage',
  amount: 'En montant, par période',
}

/**
 * Souscrire un client à un service (R18), ou changer les conditions d'une
 * souscription à une date d'effet.
 *
 * Le prix et la TVA sont proposés depuis le catalogue et **figés** à
 * l'enregistrement : une révision du catalogue ne les changera pas. Pour un
 * acte, le prix est celui d'un acte au-delà des inclus.
 *
 * Les montants partent en euros et en pourcentage ; l'action serveur les
 * convertit en centimes et en points de base (décision 5).
 */
export function SubscriptionForm({
  mode,
  clientId,
  services,
  contracts = [],
  subscription,
  defaults,
}: {
  mode: 'create' | 'change'
  clientId: string
  /** En création : les services proposés. En changement : le seul service souscrit. */
  services: SubscribableOption[]
  contracts?: { id: string; reference: string; statusLabel: string }[]
  /** En changement : la souscription en cours. */
  subscription?: { id: string }
  defaults: SubscriptionValues
}) {
  const [state, formAction, pending] = useActionState<SubscriptionFormState, FormData>(
    mode === 'create' ? subscribeAction : changeSubscriptionAction,
    null,
  )

  if (mode === 'create' && services.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border bg-white px-5 py-4 text-sm text-muted-foreground">
        Aucun service n’est proposé à la souscription.{' '}
        <Link href="/services" className="font-medium text-primary underline underline-offset-2">
          Ouvrir le catalogue de services
        </Link>
        .
      </p>
    )
  }

  return (
    <form action={formAction} noValidate className="flex max-w-3xl flex-col gap-5">
      {mode === 'create' && <input type="hidden" name="clientId" value={clientId} />}
      {subscription && <input type="hidden" name="id" value={subscription.id} />}

      <ErrorSummary
        errors={state?.fieldErrors as Record<string, string> | undefined}
        labels={subscriptionFieldLabels}
        message={state?.message}
      />

      <Fields
        key={JSON.stringify(state?.values ?? '')}
        mode={mode}
        initial={state?.values ?? defaults}
        errors={state?.fieldErrors ?? {}}
        services={services}
        contracts={contracts}
      />

      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className={primaryButtonClass}>
          {pending
            ? 'Enregistrement…'
            : mode === 'create'
              ? 'Souscrire'
              : 'Appliquer les nouvelles conditions'}
        </button>
        <Link
          href={`/clients/${clientId}#services`}
          className="text-sm text-muted-foreground hover:underline"
        >
          Annuler
        </Link>
        <PendingAnnouncement pending={pending} label="Enregistrement en cours" />
      </div>
    </form>
  )
}

function Fields({
  mode,
  initial,
  errors,
  services,
  contracts,
}: {
  mode: 'create' | 'change'
  initial: SubscriptionValues
  errors: Partial<Record<keyof SubscriptionValues, string>>
  services: SubscribableOption[]
  contracts: { id: string; reference: string; statusLabel: string }[]
}) {
  const [values, setValues] = useState<SubscriptionValues>(initial)
  const set = <K extends keyof SubscriptionValues>(key: K, value: SubscriptionValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }))

  const service = services.find((candidate) => candidate.id === values.serviceId)
  const isAct = service?.nature === 'act'

  /** Choisir un service propose son prix et sa TVA du catalogue. */
  function chooseService(id: string) {
    const chosen = services.find((candidate) => candidate.id === id)
    setValues((current) => ({
      ...current,
      serviceId: id,
      unitPrice: chosen ? centsToAmountInput(chosen.unitPriceCents) : current.unitPrice,
      vatRate: chosen ? bpToPercentInput(chosen.vatRateBp) : current.vatRate,
      discountKind:
        chosen?.nature === 'act' && current.discountKind === 'amount' ? 'none' : current.discountKind,
    }))
  }

  // Aperçu du montant d'une période, à la règle d'arrondi de la base.
  const quantity = isAct ? 1 : parseInteger(values.quantity, 1)
  const unitPriceCents = parseAmountToCents(values.unitPrice)
  const discountBp = values.discountKind === 'percent' ? parsePercentToBp(values.discountPercent) : null
  const discountAmountCents =
    values.discountKind === 'amount' ? parseAmountToCents(values.discountAmount) : null
  const preview =
    service && quantity !== undefined && unitPriceCents !== undefined && discountBp !== undefined && discountAmountCents !== undefined
      ? lineNetAmountCents({ quantity, unitPriceCents, discountBp, discountAmountCents })
      : null

  return (
    <>
      {mode === 'create' ? (
        <div className="grid gap-5 sm:grid-cols-2">
          <div>
            <label className={labelClass} htmlFor="serviceId">
              Service
            </label>
            <select
              id="serviceId"
              name="serviceId"
              value={values.serviceId}
              onChange={(event) => chooseService(event.target.value)}
              {...describedBy('serviceId', errors.serviceId)}
              className={`${fieldClass} mt-1`}
            >
              <option value="" disabled>
                Choisir un service…
              </option>
              {(['package', 'act'] as const).map((nature) => {
                const ofNature = services.filter((candidate) => candidate.nature === nature)
                if (ofNature.length === 0) return null
                return (
                  <optgroup key={nature} label={`${serviceNatureLabels[nature]}s`}>
                    {ofNature.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.name} — {formatCents(candidate.unitPriceCents, candidate.currency)}{' '}
                        {rateUnitSuffixes[candidate.unit]}
                      </option>
                    ))}
                  </optgroup>
                )
              })}
            </select>
            <FieldError name="serviceId" error={errors.serviceId} />
          </div>

          <div>
            <label className={labelClass} htmlFor="contractId">
              Contrat <span className="font-normal text-muted-foreground">(facultatif)</span>
            </label>
            <select
              id="contractId"
              name="contractId"
              value={values.contractId}
              onChange={(event) => set('contractId', event.target.value)}
              {...describedBy('contractId', errors.contractId, true)}
              className={`${fieldClass} mt-1`}
            >
              <option value="">Hors contrat</option>
              {contracts.map((contract) => (
                <option key={contract.id} value={contract.id}>
                  {contract.reference} ({contract.statusLabel.toLowerCase()})
                </option>
              ))}
            </select>
            <FieldError name="contractId" error={errors.contractId} />
            <FieldHint name="contractId">
              Rattachée à un contrat, la souscription se lit avec lui ; elle n’en change pas le
              loyer.
            </FieldHint>
          </div>
        </div>
      ) : (
        <input type="hidden" name="serviceId" value={values.serviceId} />
      )}

      <div className="grid gap-5 sm:grid-cols-3">
        {!isAct && (
          <div>
            <label className={labelClass} htmlFor="quantity">
              Quantité
            </label>
            <input
              id="quantity"
              name="quantity"
              type="number"
              min={1}
              step={1}
              inputMode="numeric"
              value={values.quantity}
              onChange={(event) => set('quantity', event.target.value)}
              {...describedBy('quantity', errors.quantity, true)}
              className={`${fieldClass} mt-1 tabular`}
            />
            <FieldError name="quantity" error={errors.quantity} />
            <FieldHint name="quantity">Deux lignes de standard : quantité 2.</FieldHint>
          </div>
        )}

        <div>
          <label className={labelClass} htmlFor="unitPrice">
            {isAct ? 'Prix HT d’un acte' : 'Prix unitaire HT'}
          </label>
          <div className="mt-1 flex items-center gap-2">
            <input
              id="unitPrice"
              name="unitPrice"
              inputMode="decimal"
              autoComplete="off"
              value={values.unitPrice}
              onChange={(event) => set('unitPrice', event.target.value)}
              {...describedBy('unitPrice', errors.unitPrice, true)}
              className={`${fieldClass} tabular`}
            />
            <span className="text-sm text-muted-foreground">€</span>
          </div>
          <FieldError name="unitPrice" error={errors.unitPrice} />
          <FieldHint name="unitPrice">
            {isAct
              ? 'Dû pour chaque acte au-delà des inclus. Figé à la souscription.'
              : `${service ? rateUnitSuffixes[service.unit] : 'Par unité'}. Figé à la souscription.`}
          </FieldHint>
        </div>

        <div>
          <label className={labelClass} htmlFor="vatRate">
            TVA
          </label>
          <div className="mt-1 flex items-center gap-2">
            <input
              id="vatRate"
              name="vatRate"
              inputMode="decimal"
              autoComplete="off"
              value={values.vatRate}
              onChange={(event) => set('vatRate', event.target.value)}
              {...describedBy('vatRate', errors.vatRate)}
              className={`${fieldClass} tabular`}
            />
            <span className="text-sm text-muted-foreground">%</span>
          </div>
          <FieldError name="vatRate" error={errors.vatRate} />
        </div>

        {isAct && (
          <div>
            <label className={labelClass} htmlFor="includedQuantity">
              Actes inclus par période
            </label>
            <input
              id="includedQuantity"
              name="includedQuantity"
              type="number"
              min={0}
              step={1}
              inputMode="numeric"
              value={values.includedQuantity}
              onChange={(event) => set('includedQuantity', event.target.value)}
              {...describedBy('includedQuantity', errors.includedQuantity, true)}
              className={`${fieldClass} mt-1 tabular`}
            />
            <FieldError name="includedQuantity" error={errors.includedQuantity} />
            <FieldHint name="includedQuantity">
              Les premiers actes de chaque mois, facturés 0 € avec la mention « inclus ».
            </FieldHint>
          </div>
        )}
      </div>

      <fieldset id="discountKind" tabIndex={-1}>
        <legend className={labelClass}>Remise</legend>
        <div className="mt-2 flex flex-wrap gap-x-6 gap-y-2">
          {(Object.keys(discountLabels) as DiscountKind[]).map((kind) => {
            const unavailable = kind === 'amount' && isAct
            return (
              <div key={kind} className="flex items-center gap-2">
                <input
                  id={`discountKind-${kind}`}
                  type="radio"
                  name="discountKind"
                  value={kind}
                  checked={values.discountKind === kind}
                  disabled={unavailable}
                  onChange={() => set('discountKind', kind)}
                  className="size-5 accent-primary"
                />
                <label
                  htmlFor={`discountKind-${kind}`}
                  className={`text-sm ${unavailable ? 'text-muted-foreground' : ''}`}
                >
                  {discountLabels[kind]}
                  {unavailable && ' (pas pour un acte)'}
                </label>
              </div>
            )
          })}
        </div>
        <div className="mt-3 max-w-xs">
          {values.discountKind === 'percent' && (
            <SuffixedInput
              name="discountPercent"
              label="Remise en pourcentage"
              suffix="%"
              value={values.discountPercent}
              error={errors.discountPercent}
              onChange={(value) => set('discountPercent', value)}
            />
          )}
          {values.discountKind === 'amount' && (
            <SuffixedInput
              name="discountAmount"
              label="Remise HT, par période"
              suffix="€"
              value={values.discountAmount}
              error={errors.discountAmount}
              onChange={(value) => set('discountAmount', value)}
            />
          )}
        </div>
      </fieldset>

      {mode === 'create' ? (
        <div className="grid gap-5 sm:grid-cols-2">
          <DateInput
            name="startsOn"
            label="Premier jour"
            value={values.startsOn}
            error={errors.startsOn}
            onChange={(value) => set('startsOn', value)}
          />
          <DateInput
            name="endsOn"
            label="Dernier jour"
            optional
            value={values.endsOn}
            error={errors.endsOn}
            hint="Vide : jusqu’à ce que vous y mettiez fin."
            onChange={(value) => set('endsOn', value)}
          />
        </div>
      ) : (
        <div className="max-w-xs">
          <DateInput
            name="effectiveOn"
            label="À compter du"
            value={values.effectiveOn}
            error={errors.effectiveOn}
            hint="La souscription en cours prend fin la veille ; les jours déjà facturés gardent leurs conditions."
            onChange={(value) => set('effectiveOn', value)}
          />
        </div>
      )}

      <div>
        <label className={labelClass} htmlFor="notes">
          Notes <span className="font-normal text-muted-foreground">(facultatif)</span>
        </label>
        <textarea
          id="notes"
          name="notes"
          rows={2}
          value={values.notes}
          onChange={(event) => set('notes', event.target.value)}
          className={`${fieldClass} mt-1`}
        />
      </div>

      <p
        role="status"
        aria-live="polite"
        className="min-h-10 rounded-md border border-border bg-muted/40 px-4 py-2 text-sm"
      >
        {!service || preview === null ? (
          <span className="text-muted-foreground">Le montant s’affiche une fois le prix saisi.</span>
        ) : preview < 0 ? (
          <span className="text-destructive">La remise dépasse le montant de la période.</span>
        ) : isAct ? (
          <>
            Au-delà des inclus :{' '}
            <strong className="tabular">{formatCents(preview, service.currency)} HT l’acte</strong>
          </>
        ) : (
          <>
            Montant de la période :{' '}
            <strong className="tabular">
              {formatCents(preview, service.currency)} HT {rateUnitSuffixes[service.unit]}
            </strong>
          </>
        )}
      </p>
    </>
  )
}

function SuffixedInput({
  name,
  label,
  suffix,
  value,
  error,
  onChange,
}: {
  name: string
  label: string
  suffix: string
  value: string
  error?: string
  onChange: (value: string) => void
}) {
  return (
    <div>
      <label className={labelClass} htmlFor={name}>
        {label}
      </label>
      <div className="mt-1 flex items-center gap-2">
        <input
          id={name}
          name={name}
          inputMode="decimal"
          autoComplete="off"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          {...describedBy(name, error)}
          className={`${fieldClass} tabular`}
        />
        <span className="text-sm text-muted-foreground">{suffix}</span>
      </div>
      <FieldError name={name} error={error} />
    </div>
  )
}

function DateInput({
  name,
  label,
  value,
  error,
  hint,
  optional = false,
  onChange,
}: {
  name: string
  label: string
  value: string
  error?: string
  hint?: string
  optional?: boolean
  onChange: (value: string) => void
}) {
  return (
    <div>
      <label className={labelClass} htmlFor={name}>
        {label}
        {optional && <span className="font-normal text-muted-foreground"> (facultatif)</span>}
      </label>
      <input
        id={name}
        name={name}
        type="date"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        {...describedBy(name, error, hint)}
        className={`${fieldClass} mt-1`}
      />
      <FieldError name={name} error={error} />
      <FieldHint name={name}>{hint}</FieldHint>
    </div>
  )
}
