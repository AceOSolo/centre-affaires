'use client'

import { useActionState, type ReactNode } from 'react'

import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import type { PaymentMethod, ProrataRule, RecurringBillingTiming } from '../../db/tenants.ts'
import {
  saveBankDetailsAction,
  saveInvoicingRulesAction,
  savePricingRulesAction,
  saveSellerIdentityAction,
  type SettingsFormState,
} from './parametres-actions.ts'
import {
  centreSettingsLabels as labels,
  paymentMethodLabels,
  prorataRuleLabels,
  recurringBillingTimingLabels,
} from './parametres-libelles.ts'

const fieldClass =
  'w-full rounded-sm border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/40 aria-[invalid=true]:border-destructive'
const labelClass = 'block text-sm font-medium text-foreground'

// Les listes de choix suivent les libellés : le composant client n'a pas à
// charger le schéma de la base pour les connaître.
const prorataRules = Object.keys(prorataRuleLabels) as ProrataRule[]
const recurringBillingTimings = Object.keys(recurringBillingTimingLabels) as RecurringBillingTiming[]
const paymentMethods = Object.keys(paymentMethodLabels) as PaymentMethod[]

type Action = (previous: SettingsFormState, formData: FormData) => Promise<SettingsFormState>

/** Ce que chaque champ reçoit de sa section : valeur courante et erreur. */
type FieldContext = {
  value: (name: string) => string
  error: (name: string) => string | undefined
}

/**
 * Une section de la configuration : un formulaire, un bouton, un état rendu
 * (résumé d'erreurs en tête, confirmation après l'enregistrement).
 */
function SettingsSection({
  id,
  title,
  description,
  action,
  values,
  submitLabel,
  children,
}: {
  id: string
  title: string
  description: ReactNode
  action: Action
  values: Record<string, string>
  submitLabel: string
  children: (context: FieldContext) => ReactNode
}) {
  const [state, formAction, pending] = useActionState<SettingsFormState, FormData>(action, null)
  const context: FieldContext = {
    value: (name) => state?.values?.[name] ?? values[name] ?? '',
    error: (name) => state?.fieldErrors?.[name],
  }

  return (
    <section aria-labelledby={`${id}-title`} className="rounded-lg border border-border bg-white px-5 py-4">
      <h2 id={`${id}-title`} className="text-base font-semibold tracking-tight">
        {title}
      </h2>
      <div className="mt-1 max-w-[70ch] text-sm text-muted-foreground">{description}</div>
      <form
        // Remonté après un échec pour reprendre la saisie, que React efface à
        // la fin de l'envoi.
        key={JSON.stringify(state?.values ?? values)}
        action={formAction}
        className="mt-4 flex flex-col gap-4"
      >
        <ErrorSummary errors={state?.fieldErrors} labels={labels} message={state?.error} />
        {children(context)}
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={pending}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50"
          >
            {pending ? 'Enregistrement…' : submitLabel}
          </button>
          <p role="status" className="text-sm text-primary">
            {state?.saved && !pending ? 'Enregistré.' : ''}
          </p>
        </div>
      </form>
    </section>
  )
}

function describedBy(name: string, error: string | undefined, hint?: string) {
  return [hint && `${name}-hint`, error && `${name}-error`].filter(Boolean).join(' ') || undefined
}

function FieldError({ name, error }: { name: string; error?: string }) {
  if (!error) return null
  return (
    <p id={`${name}-error`} role="alert" className="mt-1 text-xs text-destructive">
      {error}
    </p>
  )
}

/** Champ texte : label visible, aide facultative, erreur annoncée sous le champ. */
function TextField({
  name,
  context,
  hint,
  optional,
  suffix,
  inputMode,
  autoComplete,
  className = '',
}: {
  name: string
  context: FieldContext
  hint?: string
  optional?: boolean
  suffix?: string
  inputMode?: 'numeric' | 'decimal' | 'text'
  autoComplete?: string
  className?: string
}) {
  const error = context.error(name)
  return (
    <div className={className}>
      <label className={labelClass} htmlFor={name}>
        {labels[name]}
        {optional && <span className="font-normal text-muted-foreground"> (facultatif)</span>}
      </label>
      <div className="mt-1 flex items-center gap-2">
        <input
          id={name}
          name={name}
          defaultValue={context.value(name)}
          inputMode={inputMode}
          autoComplete={autoComplete ?? 'off'}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(name, error, hint)}
          className={`${fieldClass} ${inputMode ? 'tabular' : ''}`}
        />
        {suffix && <span className="shrink-0 text-sm text-muted-foreground">{suffix}</span>}
      </div>
      {hint && (
        <p id={`${name}-hint`} className="mt-1 text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      <FieldError name={name} error={error} />
    </div>
  )
}

function TextAreaField({
  name,
  context,
  hint,
  optional,
}: {
  name: string
  context: FieldContext
  hint?: string
  optional?: boolean
}) {
  const error = context.error(name)
  return (
    <div>
      <label className={labelClass} htmlFor={name}>
        {labels[name]}
        {optional && <span className="font-normal text-muted-foreground"> (facultatif)</span>}
      </label>
      <textarea
        id={name}
        name={name}
        rows={2}
        defaultValue={context.value(name)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(name, error, hint)}
        className={`${fieldClass} mt-1`}
      />
      {hint && (
        <p id={`${name}-hint`} className="mt-1 text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      <FieldError name={name} error={error} />
    </div>
  )
}

/** Choix exclusif : chaque option porte son libellé et son exemple. */
function RadioField<T extends string>({
  name,
  context,
  options,
}: {
  name: string
  context: FieldContext
  options: readonly { value: T; label: string; example: string }[]
}) {
  const error = context.error(name)
  const current = context.value(name)
  return (
    <fieldset aria-describedby={error ? `${name}-error` : undefined}>
      <legend className={labelClass}>{labels[name]}</legend>
      <div className="mt-2 flex flex-col gap-2">
        {options.map((option, index) => (
          <div key={option.value} className="flex items-start gap-2">
            <input
              // Le premier choix porte le nom du champ : le lien du résumé
              // d'erreurs y mène.
              id={index === 0 ? name : `${name}-${option.value}`}
              name={name}
              type="radio"
              value={option.value}
              defaultChecked={current === option.value}
              aria-describedby={`${name}-${option.value}-hint`}
              className="mt-1"
            />
            <div>
              <label
                htmlFor={index === 0 ? name : `${name}-${option.value}`}
                className="text-sm font-medium"
              >
                {option.label}
              </label>
              <p id={`${name}-${option.value}-hint`} className="text-xs text-muted-foreground">
                {option.example}
              </p>
            </div>
          </div>
        ))}
      </div>
      <FieldError name={name} error={error} />
    </fieldset>
  )
}

/**
 * Écran de configuration du centre (R10) : règles tarifaires, facturation,
 * identité légale et coordonnées bancaires du vendeur. Quatre formulaires
 * indépendants : enregistrer l'un ne touche pas aux autres.
 */
export function CentreSettingsForms({ values }: { values: Record<string, string> }) {
  return (
    <div className="flex flex-col gap-6">
      <SettingsSection
        id="tarification"
        title="Règles tarifaires"
        description={
          <>
            Elles fixent le montant des devis de réservation et des loyers. Un changement vaut pour
            les devis à venir : une réservation déjà chiffrée et une facture émise gardent leur
            montant. Valeurs par défaut à valider avec l’exploitation et l’expert-comptable.
          </>
        }
        action={savePricingRulesAction}
        values={values}
        submitLabel="Enregistrer les règles tarifaires"
      >
        {(context) => (
          <>
            <RadioField
              name="prorataRule"
              context={context}
              options={prorataRules.map((rule) => ({ value: rule, ...prorataRuleLabels[rule] }))}
            />
            <div className="grid gap-4 sm:grid-cols-3">
              <TextField
                name="startedUnitToleranceMinutes"
                context={context}
                inputMode="numeric"
                suffix="min"
                hint="0 : toute unité entamée est due (1 h 10 = 2 h). 10 : 1 h 10 = 1 h."
              />
              <TextField
                name="halfDayMinutes"
                context={context}
                inputMode="numeric"
                suffix="min"
                hint="240 = 4 h, le créneau vendu le matin ou l’après-midi."
              />
              <TextField
                name="defaultVatRate"
                context={context}
                inputMode="decimal"
                suffix="%"
                hint="Appliqué aux réservations. 20 % pour la location de salles et de bureaux équipés."
              />
            </div>
          </>
        )}
      </SettingsSection>

      <SettingsSection
        id="facturation"
        title="Facturation"
        description="Échéance et mentions obligatoires, reprises dans chaque facture émise et figées avec elle."
        action={saveInvoicingRulesAction}
        values={values}
        submitLabel="Enregistrer la facturation"
      >
        {(context) => (
          <>
            <div className="grid gap-4 sm:grid-cols-3">
              <TextField
                name="invoicePaymentTermsDays"
                context={context}
                inputMode="numeric"
                suffix="jours"
                hint="Après la date d’émission. 60 jours au plus (art. L. 441-10)."
              />
              <TextField
                name="recoveryIndemnity"
                context={context}
                inputMode="decimal"
                suffix="€"
                hint="40 € minimum entre professionnels (art. D. 441-5)."
              />
            </div>
            <RadioField
              name="recurringBillingTiming"
              context={context}
              options={recurringBillingTimings.map((timing) => ({
                value: timing,
                ...recurringBillingTimingLabels[timing],
              }))}
            />
            <div className="flex items-start gap-2">
              <input
                id="vatOnDebits"
                name="vatOnDebits"
                type="checkbox"
                defaultChecked={values.vatOnDebits === 'on'}
                aria-describedby="vatOnDebits-hint"
                className="mt-1"
              />
              <div>
                <label htmlFor="vatOnDebits" className="text-sm font-medium">
                  {labels.vatOnDebits}
                </label>
                <p id="vatOnDebits-hint" className="text-xs text-muted-foreground">
                  Option du centre pour ses prestations de services : la mention « TVA acquittée
                  d’après les débits » figure alors sur les factures.
                </p>
              </div>
            </div>
            <TextAreaField name="latePaymentPenaltyText" context={context} />
            <TextAreaField name="earlyPaymentDiscountText" context={context} />
            <TextAreaField
              name="invoiceFooterText"
              context={context}
              optional
              hint="Mentions complémentaires imprimées au pied des factures."
            />
          </>
        )}
      </SettingsSection>

      <SettingsSection
        id="identite"
        title="Identité légale du vendeur"
        description={
          <>
            Mentions obligatoires de chaque facture : sans raison sociale, adresse, SIREN et numéro
            de TVA, aucune facture ne peut être émise. L’adresse est aussi celle du site public.
          </>
        }
        action={saveSellerIdentityAction}
        values={values}
        submitLabel="Enregistrer l’identité"
      >
        {(context) => (
          <>
            <div className="grid gap-4 sm:grid-cols-3">
              <TextField name="legalName" context={context} className="sm:col-span-2" autoComplete="organization" />
              <TextField name="legalForm" context={context} optional hint="SAS, SARL…" />
              <TextField
                name="shareCapital"
                context={context}
                optional
                inputMode="decimal"
                suffix="€"
              />
              <TextField name="siren" context={context} inputMode="numeric" hint="Neuf chiffres." />
              <TextField name="siret" context={context} optional inputMode="numeric" hint="Quatorze chiffres." />
              <TextField name="vatNumber" context={context} hint="FR, deux chiffres de clé, le SIREN." />
              <TextField name="rcsCity" context={context} optional hint="Ville du greffe : « RCS Vienne »." />
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <TextField name="addressLine1" context={context} className="sm:col-span-3" autoComplete="address-line1" />
              <TextField name="addressLine2" context={context} optional className="sm:col-span-3" autoComplete="address-line2" />
              <TextField name="postalCode" context={context} inputMode="numeric" autoComplete="postal-code" />
              <TextField name="city" context={context} autoComplete="address-level2" />
              <TextField name="country" context={context} hint="Deux lettres : FR." autoComplete="country" />
            </div>
          </>
        )}
      </SettingsSection>

      <SettingsSection
        id="reglement"
        title="Règlement"
        description="Coordonnées du compte du centre, imprimées sur les factures payées par virement : ce sont des coordonnées publiques du vendeur. Le paiement est suivi à la main (ADR 016)."
        action={saveBankDetailsAction}
        values={values}
        submitLabel="Enregistrer le règlement"
      >
        {(context) => {
          const error = context.error('defaultPaymentMethod')
          return (
            <>
              <div className="grid gap-4 sm:grid-cols-3">
                <TextField name="bankIban" context={context} className="sm:col-span-2" />
                <TextField name="bankBic" context={context} optional />
                <TextField
                  name="sepaCreditorId"
                  context={context}
                  optional
                  className="sm:col-span-2"
                  hint="Nécessaire pour facturer par prélèvement. Délivré par la banque du centre."
                />
                <div>
                  <label className={labelClass} htmlFor="defaultPaymentMethod">
                    {labels.defaultPaymentMethod}
                  </label>
                  <select
                    id="defaultPaymentMethod"
                    name="defaultPaymentMethod"
                    defaultValue={context.value('defaultPaymentMethod')}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={describedBy('defaultPaymentMethod', error, 'hint')}
                    className={`${fieldClass} mt-1`}
                  >
                    {paymentMethods.map((method) => (
                      <option key={method} value={method}>
                        {paymentMethodLabels[method]}
                      </option>
                    ))}
                  </select>
                  <p id="defaultPaymentMethod-hint" className="mt-1 text-xs text-muted-foreground">
                    Pour un client sans mandat de prélèvement actif.
                  </p>
                  <FieldError name="defaultPaymentMethod" error={error} />
                </div>
              </div>
            </>
          )
        }}
      </SettingsSection>
    </div>
  )
}
