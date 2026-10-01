'use client'

import { useActionState, useState } from 'react'

import Link from 'next/link'

import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import { resourceTypeLabels } from '../ressources/labels.ts'
import type { ResourceType } from '../ressources/schema.ts'
import { commitmentEndsOn } from './echeancier.ts'
import { contractFieldLabels, isCalendarDate, type ContractField } from './formulaire.ts'
import { billingPeriodLabels, billingPeriodSuffixes, contractTypeLabels } from './labels.ts'
import type { LineFormValues } from './lignes.ts'
import { LinesEditor, lineErrorLabels, type LinesCatalog } from './lines-editor.tsx'
import { formatCalendarDate } from './occupation.ts'
import { createContractFromOfferAction, type OfferContractFormState } from './offre-actions.ts'
import { actFieldLabels, actFieldName, type ActField, type ActFormValues } from './offres.ts'
import { billingPeriods, contractTypes, type BillingPeriod } from './schema.ts'

const fieldClass =
  'w-full rounded-sm border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/40 aria-[invalid=true]:border-destructive'
const labelClass = 'block text-sm font-medium text-foreground'
const smallLabelClass = 'block text-xs font-medium text-foreground'

/** Champs du contrat au format de saisie, pré-remplis depuis l'offre. */
export type OfferContractDefaults = Record<ContractField, string>

/**
 * « Nouveau contrat depuis une offre » (R09, R12) : la proposition tirée de
 * l'offre — lignes, actes inclus, période, engagement — s'ajuste ici avant la
 * création. Le montant du contrat est la somme des lignes récurrentes,
 * annoncée en direct et recalculée par la base ; la fin d'engagement est
 * annoncée de date à date, comme la base la calcule.
 */
export function OfferContractForm({
  offer,
  defaults,
  initialLines,
  initialActs,
  catalog,
  clients,
  resources,
  currency,
}: {
  offer: { id: string; name: string }
  defaults: OfferContractDefaults
  initialLines: LineFormValues[]
  initialActs: ActFormValues[]
  catalog: LinesCatalog
  clients: { id: string; name: string }[]
  resources: { id: string; code: string; name: string; resourceType: ResourceType }[]
  currency: string
}) {
  const [state, formAction, pending] = useActionState<OfferContractFormState, FormData>(
    createContractFromOfferAction,
    null,
  )
  const [values, setValues] = useState(defaults)
  const [lines, setLines] = useState(initialLines)
  const [acts, setActs] = useState(initialActs)
  const errors = state?.fieldErrors ?? {}

  const set = (field: ContractField) => (
    event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>,
  ) => setValues({ ...values, [field]: event.target.value })

  const invalid = (field: ContractField, hint?: string) => ({
    id: field,
    name: field,
    'aria-invalid': errors[field] ? true : undefined,
    'aria-describedby': [hint, errors[field] && `${field}-error`].filter(Boolean).join(' ') || undefined,
  })

  const billingPeriod = (billingPeriods as readonly string[]).includes(values.billingPeriod)
    ? (values.billingPeriod as BillingPeriod)
    : 'monthly'
  const months = /^\d+$/.test(values.commitmentMonths) ? Number(values.commitmentMonths) : null
  const commitmentEnd =
    months && months <= 120 && isCalendarDate(values.startsOn)
      ? commitmentEndsOn(values.startsOn, months)
      : null

  const actLabels: Record<string, string> = {}
  for (const name of Object.keys(errors)) {
    const match = /^acte-(.+)-([a-zA-Z]+)$/.exec(name)
    if (!match) continue
    const act = acts.find((candidate) => candidate.key === match[1])
    actLabels[name] = `${act?.serviceName ?? 'Acte inclus'} — ${actFieldLabels[match[2] as ActField] ?? match[2]}`
  }

  return (
    <form action={formAction} className="flex flex-col gap-6">
      <ErrorSummary
        errors={state?.fieldErrors}
        labels={{ ...contractFieldLabels, ...lineErrorLabels(errors, lines), ...actLabels }}
        message={state?.error}
      />
      <input type="hidden" name="offerId" value={offer.id} />
      <input type="hidden" name="currency" value={currency} />
      {/* TVA d'une version sans ligne : celle du centre. Les lignes portent la leur. */}
      <input type="hidden" name="vatRate" value={values.vatRate} />

      <fieldset className="grid gap-5 rounded-lg border border-border bg-white px-5 py-4 sm:grid-cols-2 lg:grid-cols-4">
        <legend className="px-1 text-sm font-semibold">Contrat</legend>

        <div className="sm:col-span-2">
          <label className={labelClass} htmlFor="clientId">Client</label>
          <select {...invalid('clientId')} value={values.clientId} onChange={set('clientId')} className={`${fieldClass} mt-1`}>
            <option value="" disabled>Choisir un client…</option>
            {clients.map((client) => (
              <option key={client.id} value={client.id}>{client.name}</option>
            ))}
          </select>
          <FieldError name="clientId" error={errors.clientId} />
        </div>

        <div>
          <label className={labelClass} htmlFor="contractType">Type</label>
          <select {...invalid('contractType')} value={values.contractType} onChange={set('contractType')} className={`${fieldClass} mt-1`}>
            {contractTypes.map((type) => (
              <option key={type} value={type}>{contractTypeLabels[type]}</option>
            ))}
          </select>
          <FieldError name="contractType" error={errors.contractType} />
        </div>

        <div>
          <label className={labelClass} htmlFor="reference">
            Référence <span className="font-normal text-muted-foreground">(facultatif)</span>
          </label>
          <input {...invalid('reference', 'reference-hint')} maxLength={50} autoComplete="off" value={values.reference} onChange={set('reference')} className={`${fieldClass} mt-1 tabular`} />
          <p id="reference-hint" className="mt-1 text-xs text-muted-foreground">Vide : numéro suivant, CT-AAAA-NNNN.</p>
          <FieldError name="reference" error={errors.reference} />
        </div>

        <div className="sm:col-span-2">
          <label className={labelClass} htmlFor="resourceId">
            Ressource occupée <span className="font-normal text-muted-foreground">(facultatif)</span>
          </label>
          <select {...invalid('resourceId', 'resourceId-hint')} value={values.resourceId} onChange={set('resourceId')} className={`${fieldClass} mt-1`}>
            <option value="">Aucune</option>
            {resources.map((resource) => (
              <option key={resource.id} value={resource.id}>
                {resource.code} — {resource.name} ({resourceTypeLabels[resource.resourceType]})
              </option>
            ))}
          </select>
          <p id="resourceId-hint" className="mt-1 text-xs text-muted-foreground">
            Occupée au planning dès l’activation. Un contrat n’occupe qu’une ressource : les autres
            lignes sont facturées sans occuper.
          </p>
          <FieldError name="resourceId" error={errors.resourceId} />
        </div>

        <div>
          <label className={labelClass} htmlFor="startsOn">Début</label>
          <input {...invalid('startsOn')} type="date" required value={values.startsOn} onChange={set('startsOn')} className={`${fieldClass} mt-1`} />
          <FieldError name="startsOn" error={errors.startsOn} />
        </div>

        <div>
          <label className={labelClass} htmlFor="endsOn">
            Fin <span className="font-normal text-muted-foreground">(facultatif)</span>
          </label>
          <input {...invalid('endsOn', 'endsOn-hint')} type="date" value={values.endsOn} onChange={set('endsOn')} className={`${fieldClass} mt-1`} />
          <p id="endsOn-hint" className="mt-1 text-xs text-muted-foreground">Vide : jusqu’à résiliation.</p>
          <FieldError name="endsOn" error={errors.endsOn} />
        </div>

        <div>
          <label className={labelClass} htmlFor="billingPeriod">Périodicité</label>
          <select {...invalid('billingPeriod', 'billingPeriod-hint')} value={values.billingPeriod} onChange={set('billingPeriod')} className={`${fieldClass} mt-1`}>
            {billingPeriods.map((period) => (
              <option key={period} value={period}>{billingPeriodLabels[period]}</option>
            ))}
          </select>
          <p id="billingPeriod-hint" className="mt-1 text-xs text-muted-foreground">
            Les quantités de l’offre sont dues par période de facturation : changer la périodicité
            ne les recalcule pas, ajustez les lignes.
          </p>
          <FieldError name="billingPeriod" error={errors.billingPeriod} />
        </div>

        <div>
          <label className={labelClass} htmlFor="noticeDays">Préavis (jours)</label>
          <input {...invalid('noticeDays')} type="number" min={0} step={1} value={values.noticeDays} onChange={set('noticeDays')} className={`${fieldClass} mt-1 tabular`} />
          <FieldError name="noticeDays" error={errors.noticeDays} />
        </div>

        <div>
          <label className={labelClass} htmlFor="commitmentMonths">
            Engagement (mois) <span className="font-normal text-muted-foreground">(facultatif)</span>
          </label>
          <input {...invalid('commitmentMonths', 'commitmentMonths-hint')} inputMode="numeric" value={values.commitmentMonths} onChange={set('commitmentMonths')} className={`${fieldClass} mt-1 tabular`} />
          <p id="commitmentMonths-hint" className="mt-1 text-xs text-muted-foreground" aria-live="polite">
            {commitmentEnd ? `Engagé jusqu’au ${formatCalendarDate(commitmentEnd)} inclus.` : 'Vide : sans engagement.'}
          </p>
          <FieldError name="commitmentMonths" error={errors.commitmentMonths} />
        </div>

        <div className="flex flex-col gap-2">
          <label className="mt-6 flex items-center gap-2 text-sm" htmlFor="tacitRenewal">
            <input
              id="tacitRenewal"
              name="tacitRenewal"
              type="checkbox"
              value="on"
              checked={values.tacitRenewal === 'on'}
              onChange={(event) => setValues({ ...values, tacitRenewal: event.target.checked ? 'on' : '' })}
              className="size-4 accent-primary"
            />
            Reconduction tacite
          </label>
        </div>

        {values.tacitRenewal === 'on' && (
          <div>
            <label className={labelClass} htmlFor="renewalMonths">Reconduit par périodes de (mois)</label>
            <input {...invalid('renewalMonths')} inputMode="numeric" value={values.renewalMonths} onChange={set('renewalMonths')} className={`${fieldClass} mt-1 tabular`} />
            <FieldError name="renewalMonths" error={errors.renewalMonths} />
          </div>
        )}

        <div className="sm:col-span-2 lg:col-span-4">
          <label className={labelClass} htmlFor="notes">
            Notes <span className="font-normal text-muted-foreground">(facultatif)</span>
          </label>
          <textarea id="notes" name="notes" rows={2} value={values.notes} onChange={set('notes')} className={`${fieldClass} mt-1`} />
        </div>
      </fieldset>

      <section aria-labelledby="lignes-title" className="flex flex-col gap-3">
        <h2 id="lignes-title" className="text-sm font-semibold tracking-tight">
          Lignes du contrat
        </h2>
        <p className="text-xs text-muted-foreground">
          Copiées de l’offre « {offer.name} » : elles ne la suivront plus. Le montant du contrat en
          découle.
        </p>
        <LinesEditor
          lines={lines}
          setLines={setLines}
          catalog={catalog}
          errors={errors}
          periodSuffix={billingPeriodSuffixes[billingPeriod]}
          currency={currency}
        />
      </section>

      <section aria-labelledby="actes-title" className="flex flex-col gap-3">
        <h2 id="actes-title" tabIndex={-1} className="text-sm font-semibold tracking-tight">
          Actes inclus
        </h2>
        <p className="text-xs text-muted-foreground">
          Souscrits au nom du client avec le contrat, sur sa période : les premiers actes de chaque
          mois sont inclus, les suivants facturés au prix indiqué.
        </p>
        {acts.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border bg-white px-4 py-6 text-center text-sm text-muted-foreground">
            L’offre n’inclut aucun acte.
          </p>
        ) : (
          acts.map((act) => (
            <ActFieldset
              key={act.key}
              act={act}
              errors={errors}
              onChange={(patch) =>
                setActs((current) => current.map((candidate) => (candidate.key === act.key ? { ...candidate, ...patch } : candidate)))
              }
              onRemove={() => {
                setActs((current) => current.filter((candidate) => candidate.key !== act.key))
                // Le bouton disparaît avec l'acte : le focus revient au titre de la section.
                requestAnimationFrame(() => document.getElementById('actes-title')?.focus())
              }}
            />
          ))
        )}
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50"
        >
          {pending ? 'Création…' : 'Créer le contrat en brouillon'}
        </button>
        <Link href="/contrats/nouveau/offre" className="text-sm text-muted-foreground hover:underline">
          Choisir une autre offre
        </Link>
      </div>
      <p className="text-xs text-muted-foreground">
        Le contrat est créé en brouillon : il se relit et se modifie, puis s’active. Son document
        est archivé à l’activation.
      </p>
    </form>
  )
}

function ActFieldset({
  act,
  errors,
  onChange,
  onRemove,
}: {
  act: ActFormValues
  errors: Record<string, string>
  onChange: (patch: Partial<ActFormValues>) => void
  onRemove: () => void
}) {
  const name = (field: ActField) => actFieldName(act.key, field)
  const invalid = (field: ActField) => ({
    id: name(field),
    name: name(field),
    'aria-invalid': errors[name(field)] ? true : undefined,
    'aria-describedby': errors[name(field)] ? `${name(field)}-error` : undefined,
  })
  return (
    <fieldset className="rounded-lg border border-border bg-white px-4 pb-4 pt-2">
      <legend className="px-1 text-sm font-medium">{act.serviceName}</legend>
      <input type="hidden" name="acte" value={act.key} />
      <input type="hidden" name={name('serviceId')} value={act.serviceId} />
      <input type="hidden" name={name('serviceName')} value={act.serviceName} />
      <input type="hidden" name={name('offerItemId')} value={act.offerItemId} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <div>
          <label className={smallLabelClass} htmlFor={name('includedQuantity')}>Actes inclus par mois</label>
          <input {...invalid('includedQuantity')} inputMode="numeric" value={act.includedQuantity} onChange={(event) => onChange({ includedQuantity: event.target.value })} className={`${fieldClass} mt-1 tabular`} />
          <FieldError name={name('includedQuantity')} error={errors[name('includedQuantity')]} />
        </div>
        <div>
          <label className={smallLabelClass} htmlFor={name('unitPrice')}>Prix HT d’un acte au-delà (€)</label>
          <input {...invalid('unitPrice')} inputMode="decimal" value={act.unitPrice} onChange={(event) => onChange({ unitPrice: event.target.value })} className={`${fieldClass} mt-1 tabular`} />
          <FieldError name={name('unitPrice')} error={errors[name('unitPrice')]} />
        </div>
        <div>
          <label className={smallLabelClass} htmlFor={name('discountKind')}>Remise</label>
          <select {...invalid('discountKind')} value={act.discountKind} onChange={(event) => onChange({ discountKind: event.target.value, discount: '' })} className={`${fieldClass} mt-1`}>
            <option value="">Aucune</option>
            <option value="percent">En pourcentage</option>
            <option value="amount">En montant (€)</option>
          </select>
        </div>
        <div>
          <label className={smallLabelClass} htmlFor={name('discount')}>Valeur de la remise</label>
          <input {...invalid('discount')} inputMode="decimal" disabled={act.discountKind === ''} value={act.discount} onChange={(event) => onChange({ discount: event.target.value })} className={`${fieldClass} mt-1 tabular disabled:bg-muted`} />
          <FieldError name={name('discount')} error={errors[name('discount')]} />
        </div>
        <div>
          <label className={smallLabelClass} htmlFor={name('vatRate')}>TVA (%)</label>
          <input {...invalid('vatRate')} inputMode="decimal" value={act.vatRate} onChange={(event) => onChange({ vatRate: event.target.value })} className={`${fieldClass} mt-1 tabular`} />
          <FieldError name={name('vatRate')} error={errors[name('vatRate')]} />
        </div>
      </div>
      <button
        type="button"
        onClick={onRemove}
        className="mt-3 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted"
      >
        Ne pas inclure {act.serviceName}
      </button>
    </fieldset>
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
