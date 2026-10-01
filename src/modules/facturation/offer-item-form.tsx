'use client'

import { useActionState, useState } from 'react'

import Link from 'next/link'

import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import { billingPeriodSuffixes } from '../contrats/labels.ts'
import { resourceTypeLabels } from '../ressources/labels.ts'
import type { ResourceType } from '../ressources/schema.ts'
import {
  FieldError,
  FieldHint,
  PendingAnnouncement,
  describedBy,
  fieldClass,
  labelClass,
  primaryButtonClass,
} from './champs.tsx'
import { rateUnitLabels } from './labels.ts'
import { saveOfferItemAction, type OfferItemFormState } from './offres-actions.ts'
import { priceOffer, type OfferCatalogue, type OfferInput } from './offres-prix.ts'
import {
  offerItemLabels,
  validateOfferItem,
  type OfferItemErrors,
  type OfferItemValues,
} from './offres-regles.ts'
import { formatBp } from './saisie.ts'
import { rateUnits } from './schema.ts'
import {
  offerPricingLabels,
  offerTargetLabels,
  serviceNatureLabels,
  type OfferPricing,
  type OfferTarget,
} from './services-labels.ts'
import { formatCents } from './tarifs.ts'

const targets: OfferTarget[] = ['resource_type', 'resource', 'service']
const pricings: OfferPricing[] = ['catalogue', 'price', 'discount_bp', 'discount_amount']

/** Identifiant de la ligne d'aperçu, quand elle n'existe pas encore. */
const DRAFT_ID = 'apercu'

/**
 * Ajout ou modification d'une ligne d'offre (R09), avec l'aperçu de son prix
 * et du nouveau total de l'offre, calculés dans le navigateur par le même
 * moteur que la page (`priceOffer`) à chaque saisie.
 *
 * L'aperçu annonce, il ne décide pas : l'action serveur revalide la ligne, et
 * la page recalcule le prix depuis la base.
 */
export function OfferItemForm({
  offerId,
  offer,
  catalogue,
  resourceTypes,
  editing,
}: {
  offerId: string
  /** L'offre telle qu'enregistrée, pour l'aperçu du total. */
  offer: OfferInput
  catalogue: OfferCatalogue
  resourceTypes: readonly ResourceType[]
  /** Ligne modifiée ; absente pour un ajout. */
  editing?: { itemId: string; values: OfferItemValues }
}) {
  const [state, formAction, pending] = useActionState<OfferItemFormState, FormData>(
    saveOfferItemAction,
    null,
  )
  const initial: OfferItemValues = state?.values ??
    editing?.values ?? {
      target: 'resource_type',
      resourceType: resourceTypes[0] ?? '',
      resourceId: '',
      serviceId: '',
      quantity: '1',
      unit: 'month',
      pricing: 'catalogue',
      price: '',
      discountPercent: '',
      discountAmount: '',
      vatRate: '',
    }

  return (
    <form action={formAction} noValidate className="flex flex-col gap-5">
      <input type="hidden" name="offerId" value={offerId} />
      {editing && <input type="hidden" name="itemId" value={editing.itemId} />}

      <ErrorSummary
        errors={state?.fieldErrors as Record<string, string> | undefined}
        labels={offerItemLabels}
        message={state?.message}
      />

      {/* Remonté après un refus : les champs contrôlés repartent de la saisie renvoyée. */}
      <ItemFields
        key={JSON.stringify(state?.values ?? '')}
        initial={initial}
        errors={state?.fieldErrors ?? {}}
        offer={offer}
        catalogue={catalogue}
        resourceTypes={resourceTypes}
        draftId={editing?.itemId ?? DRAFT_ID}
      />

      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className={primaryButtonClass}>
          {pending ? 'Enregistrement…' : editing ? 'Enregistrer la ligne' : 'Ajouter la ligne'}
        </button>
        {editing && (
          <Link
            href={`/offres/${offerId}#lignes`}
            className="text-sm text-muted-foreground hover:underline"
          >
            Annuler
          </Link>
        )}
        <PendingAnnouncement pending={pending} label="Enregistrement en cours" />
      </div>
    </form>
  )
}

function ItemFields({
  initial,
  errors,
  offer,
  catalogue,
  resourceTypes,
  draftId,
}: {
  initial: OfferItemValues
  errors: OfferItemErrors
  offer: OfferInput
  catalogue: OfferCatalogue
  resourceTypes: readonly ResourceType[]
  draftId: string
}) {
  const [values, setValues] = useState<OfferItemValues>(initial)
  const set = <K extends keyof OfferItemValues>(key: K, value: OfferItemValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }))

  const services = catalogue.services.filter((service) => !service.archived && service.isActive)
  const resources = catalogue.resources.filter((resource) => !resource.archived)
  const service =
    values.target === 'service'
      ? catalogue.services.find((candidate) => candidate.id === values.serviceId)
      : undefined
  const isAct = service?.nature === 'act'
  const shownUnit = service ? service.unit : values.unit

  // Aperçu : la ligne saisie, si elle est complète, à la place de celle
  // qu'elle modifie ou à la suite des autres.
  const { input } = validateOfferItem(values, {
    resourceTypes,
    resources: catalogue.resources,
    services: catalogue.services,
  })
  const existing = offer.items.find((item) => item.id === draftId)
  const quote = input
    ? priceOffer(
        {
          ...offer,
          items: [
            ...offer.items.filter((item) => item.id !== draftId),
            { id: draftId, position: existing?.position ?? Number.MAX_SAFE_INTEGER, ...input },
          ],
        },
        catalogue,
      )
    : null
  const draft = quote?.lines.find((line) => line.id === draftId)
  const suffix = billingPeriodSuffixes[offer.billingPeriod]

  return (
    <>
      <fieldset id="target" tabIndex={-1}>
        <legend className={labelClass}>Ce que la ligne propose</legend>
        <div className="mt-2 flex flex-wrap gap-x-6 gap-y-2">
          {targets.map((target) => (
            <div key={target} className="flex items-center gap-2">
              <input
                id={`target-${target}`}
                type="radio"
                name="target"
                value={target}
                checked={values.target === target}
                onChange={() => set('target', target)}
                className="size-5 accent-primary"
              />
              <label htmlFor={`target-${target}`} className="text-sm">
                {offerTargetLabels[target]}
              </label>
            </div>
          ))}
        </div>
      </fieldset>

      <div className="grid gap-5 sm:grid-cols-3">
        <div className="sm:col-span-2">
          {values.target === 'resource_type' && (
            <>
              <label className={labelClass} htmlFor="resourceType">
                Type de ressource
              </label>
              <select
                id="resourceType"
                name="resourceType"
                value={values.resourceType}
                onChange={(event) => set('resourceType', event.target.value)}
                {...describedBy('resourceType', errors.resourceType, true)}
                className={`${fieldClass} mt-1`}
              >
                {resourceTypes.map((type) => (
                  <option key={type} value={type}>
                    {resourceTypeLabels[type]}
                  </option>
                ))}
              </select>
              <FieldError name="resourceType" error={errors.resourceType} />
              <FieldHint name="resourceType">
                La ressource précise sera choisie au contrat. Prix : celui du type dans la grille
                par défaut.
              </FieldHint>
            </>
          )}
          {values.target === 'resource' && (
            <>
              <label className={labelClass} htmlFor="resourceId">
                Ressource
              </label>
              <select
                id="resourceId"
                name="resourceId"
                value={values.resourceId}
                onChange={(event) => set('resourceId', event.target.value)}
                {...describedBy('resourceId', errors.resourceId)}
                className={`${fieldClass} mt-1`}
              >
                <option value="" disabled>
                  Choisir une ressource…
                </option>
                {resourceTypes.map((type) => {
                  const ofType = resources.filter((resource) => resource.resourceType === type)
                  if (ofType.length === 0) return null
                  return (
                    <optgroup key={type} label={resourceTypeLabels[type]}>
                      {ofType.map((resource) => (
                        <option key={resource.id} value={resource.id}>
                          {resource.code} — {resource.name}
                        </option>
                      ))}
                    </optgroup>
                  )
                })}
              </select>
              <FieldError name="resourceId" error={errors.resourceId} />
            </>
          )}
          {values.target === 'service' && (
            <>
              <label className={labelClass} htmlFor="serviceId">
                Service
              </label>
              <select
                id="serviceId"
                name="serviceId"
                value={values.serviceId}
                onChange={(event) => set('serviceId', event.target.value)}
                {...describedBy('serviceId', errors.serviceId, true)}
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
                          {candidate.name} — {formatCents(candidate.unitPriceCents, candidate.currency)}
                        </option>
                      ))}
                    </optgroup>
                  )
                })}
              </select>
              <FieldError name="serviceId" error={errors.serviceId} />
              <FieldHint name="serviceId">
                {services.length === 0 ? (
                  <>
                    Aucun service proposé :{' '}
                    <Link href="/services/nouveau" className="underline underline-offset-2">
                      créez-en un
                    </Link>
                    .
                  </>
                ) : isAct ? (
                  'Un acte : la quantité est le nombre d’actes inclus par période, les suivants sont dus au prix de la ligne.'
                ) : (
                  'Un forfait, dû à chaque période.'
                )}
              </FieldHint>
            </>
          )}
        </div>

        <div>
          <label className={labelClass} htmlFor="unit">
            Unité
          </label>
          <select
            id="unit"
            name={service ? undefined : 'unit'}
            value={shownUnit}
            disabled={Boolean(service)}
            onChange={(event) => set('unit', event.target.value)}
            {...describedBy('unit', errors.unit, true)}
            className={`${fieldClass} mt-1`}
          >
            {rateUnits.map((unit) => (
              <option key={unit} value={unit}>
                {rateUnitLabels[unit]}
              </option>
            ))}
          </select>
          <FieldError name="unit" error={errors.unit} />
          <FieldHint name="unit">
            {service ? 'Celle du service.' : 'Le prix du catalogue est lu dans la grille pour cette unité.'}
          </FieldHint>
        </div>
      </div>

      <div className="grid gap-5 sm:grid-cols-3">
        <div>
          <label className={labelClass} htmlFor="quantity">
            {isAct ? 'Actes inclus par période' : 'Quantité par période'}
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
          <FieldHint name="quantity">
            Due {suffix} : trois mois de bureau dans une offre trimestrielle.
          </FieldHint>
        </div>

        <div>
          <label className={labelClass} htmlFor="vatRate">
            TVA <span className="font-normal text-muted-foreground">(facultatif)</span>
          </label>
          <div className="mt-1 flex items-center gap-2">
            <input
              id="vatRate"
              name="vatRate"
              inputMode="decimal"
              autoComplete="off"
              value={values.vatRate}
              onChange={(event) => set('vatRate', event.target.value)}
              {...describedBy('vatRate', errors.vatRate, true)}
              className={`${fieldClass} tabular`}
            />
            <span className="text-sm text-muted-foreground">%</span>
          </div>
          <FieldError name="vatRate" error={errors.vatRate} />
          <FieldHint name="vatRate">
            Vide : {service ? `celle du service (${formatBp(service.vatRateBp)})` : `celle du centre (${formatBp(catalogue.defaultVatRateBp)})`}.
          </FieldHint>
        </div>
      </div>

      <fieldset id="pricing" tabIndex={-1}>
        <legend className={labelClass}>Prix de la ligne</legend>
        <div className="mt-2 flex flex-wrap gap-x-6 gap-y-2">
          {pricings.map((pricing) => {
            const unavailable = pricing === 'discount_amount' && isAct
            return (
              <div key={pricing} className="flex items-center gap-2">
                <input
                  id={`pricing-${pricing}`}
                  type="radio"
                  name="pricing"
                  value={pricing}
                  checked={values.pricing === pricing}
                  disabled={unavailable}
                  onChange={() => set('pricing', pricing)}
                  className="size-5 accent-primary"
                />
                <label
                  htmlFor={`pricing-${pricing}`}
                  className={`text-sm ${unavailable ? 'text-muted-foreground' : ''}`}
                >
                  {offerPricingLabels[pricing]}
                  {unavailable && ' (pas pour un acte)'}
                </label>
              </div>
            )
          })}
        </div>

        <div className="mt-3 max-w-xs">
          {values.pricing === 'price' && (
            <AmountInput
              name="price"
              label={isAct ? 'Prix HT d’un acte au-delà des inclus' : 'Prix forfaitaire HT, par unité'}
              suffix="€"
              value={values.price}
              error={errors.price}
              onChange={(value) => set('price', value)}
            />
          )}
          {values.pricing === 'discount_bp' && (
            <AmountInput
              name="discountPercent"
              label="Remise en pourcentage"
              suffix="%"
              value={values.discountPercent}
              error={errors.discountPercent}
              onChange={(value) => set('discountPercent', value)}
            />
          )}
          {values.pricing === 'discount_amount' && (
            <AmountInput
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

      {/* Aperçu calculé à chaque saisie : place réservée, pas de saut de page. */}
      <div
        role="status"
        aria-live="polite"
        className="min-h-16 rounded-md border border-border bg-muted/40 px-4 py-3 text-sm"
      >
        {!draft || !quote ? (
          <p className="text-muted-foreground">Complétez la ligne pour voir son prix.</p>
        ) : draft.problem ? (
          <p className="text-destructive">À corriger : {draft.problem}</p>
        ) : (
          <>
            <p>
              Cette ligne :{' '}
              <strong className="tabular">
                {draft.kind === 'act'
                  ? `${draft.includedActs} actes inclus, puis ${draft.extraActNetCents !== null ? formatCents(draft.extraActNetCents, quote.currency) : '—'} HT l’acte`
                  : `${formatCents(draft.netAmountCents ?? 0, quote.currency)} HT ${suffix}`}
              </strong>
              {draft.priceSource === 'catalogue' && draft.kind !== 'act' && ' (prix du catalogue)'}
            </p>
            <p className="mt-1 text-muted-foreground">
              Offre avec cette ligne :{' '}
              <span className="tabular">
                {formatCents(quote.totalExclTaxCents, quote.currency)} HT,{' '}
                {formatCents(quote.totalInclTaxCents, quote.currency)} TTC {suffix}
              </span>
              {!quote.complete && ' — d’autres lignes sont à corriger'}
            </p>
          </>
        )}
      </div>
    </>
  )
}

function AmountInput({
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
