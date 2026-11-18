'use client'

import { useActionState } from 'react'

import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import {
  createAddressAction,
  updateAddressAction,
  type AddressBookFormState,
} from './carnet-adresses-actions.ts'
import { MAX_ADDRESS_LABEL_LENGTH, type AddressBookEntry } from './carnet-adresses-regles.ts'
import { RequiredMark, RequiredNotice } from './champs-obligatoires.tsx'

/**
 * Formulaire d'une adresse du carnet (ADR 078). Mobile d'abord : champs et
 * bouton à 44 px, en pleine largeur au téléphone. Chaque champ a son libellé
 * visible ; les obligatoires portent l'astérisque, `required` et
 * `aria-required` ; une erreur est dite à côté du champ et dans le résumé en
 * tête, focalisé à l'échec.
 */
const fieldClass =
  'mt-1 block min-h-11 w-full rounded-sm border border-border bg-white px-3 py-2 text-base outline-none focus:border-accent focus:ring-2 focus:ring-accent/40 aria-[invalid=true]:border-destructive sm:text-sm'
const labelClass = 'block text-sm font-medium text-foreground'
const primaryClass =
  'press inline-flex min-h-11 w-full items-center justify-center rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-60 sm:w-auto'

const labels: Record<string, string> = {
  adresseNom: 'Nom de l’adresse',
  forwardRecipient: 'Destinataire',
  forwardAddressLine1: 'Adresse',
  forwardAddressLine2: 'Complément d’adresse',
  forwardPostalCode: 'Code postal',
  forwardCity: 'Ville',
  forwardCountry: 'Pays',
}

export function AddressBookForm({
  entry,
  accounts = [],
  countries,
  idPrefix,
}: {
  /** L'adresse modifiée ; absente : une nouvelle adresse. */
  entry?: AddressBookEntry
  /** Entreprises du compte, pour une nouvelle adresse : le choix n'apparaît que s'il y en a plusieurs. */
  accounts?: { clientId: string; clientName: string }[]
  countries: { code: string; name: string }[]
  /** Préfixe des `id` : plusieurs formulaires sur une même page. */
  idPrefix: string
}) {
  const [state, formAction, pending] = useActionState<AddressBookFormState, FormData>(
    entry ? updateAddressAction : createAddressAction,
    null,
  )
  const values = state?.values
  const errors = state?.fieldErrors ?? {}
  const id = (name: string) => `${idPrefix}-${name}`
  // Les erreurs portent le nom du champ ; le résumé mène à son `id`, préfixé.
  const summaryErrors = Object.fromEntries(Object.entries(errors).map(([name, error]) => [id(name), error]))
  const summaryLabels = Object.fromEntries(Object.entries(labels).map(([name, label]) => [id(name), label]))
  const initial = (name: string, fallback: string | null | undefined) => values?.[name] ?? fallback ?? ''

  const input = (
    name: string,
    fallback: string | null | undefined,
    options: { optional?: boolean; autoComplete?: string; hint?: string; maxLength?: number } = {},
  ) => {
    const error = errors[name]
    const describedBy = [options.hint ? `${id(name)}-hint` : null, error ? `${id(name)}-error` : null]
      .filter(Boolean)
      .join(' ')
    return (
      <div>
        <label htmlFor={id(name)} className={labelClass}>
          {labels[name]}
          {options.optional ? (
            <span className="font-normal text-muted-foreground"> (facultatif)</span>
          ) : (
            <RequiredMark />
          )}
        </label>
        <input
          id={id(name)}
          name={name}
          required={!options.optional}
          aria-required={options.optional ? undefined : true}
          autoComplete={options.autoComplete}
          maxLength={options.maxLength}
          defaultValue={initial(name, fallback)}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy || undefined}
          className={fieldClass}
        />
        {options.hint && (
          <p id={`${id(name)}-hint`} className="mt-1 text-sm text-muted-foreground">
            {options.hint}
          </p>
        )}
        {error && (
          <p id={`${id(name)}-error`} className="mt-1 text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
    )
  }

  return (
    // Remonté après un échec pour reprendre les valeurs saisies.
    <form key={JSON.stringify(values ?? {})} action={formAction} className="flex flex-col gap-4">
      {entry && <input type="hidden" name="id" value={entry.id} />}
      <ErrorSummary errors={summaryErrors} labels={summaryLabels} message={state?.error} />
      <RequiredNotice />
      {!entry && accounts.length > 1 && (
        <div>
          <label htmlFor={id('entreprise')} className={labelClass}>
            Pour l’entreprise
            <RequiredMark />
          </label>
          <select
            id={id('entreprise')}
            name="entreprise"
            required
            aria-required
            defaultValue={accounts[0]?.clientId}
            className={fieldClass}
          >
            {accounts.map((account) => (
              <option key={account.clientId} value={account.clientId}>
                {account.clientName}
              </option>
            ))}
          </select>
        </div>
      )}
      {input('adresseNom', entry?.label, {
        optional: true,
        maxLength: MAX_ADDRESS_LABEL_LENGTH,
        hint: 'Pour la reconnaître dans la liste : « Siège », « Chez le comptable ».',
      })}
      {input('forwardRecipient', entry?.address.recipient, {
        autoComplete: 'name',
        hint: 'Personne ou société, tel qu’il doit figurer sur l’enveloppe.',
      })}
      {input('forwardAddressLine1', entry?.address.line1, { autoComplete: 'address-line1' })}
      {input('forwardAddressLine2', entry?.address.line2, { optional: true, autoComplete: 'address-line2' })}
      <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
        {input('forwardPostalCode', entry?.address.postalCode, { autoComplete: 'postal-code' })}
        {input('forwardCity', entry?.address.city, { autoComplete: 'address-level2' })}
      </div>
      <div>
        <label htmlFor={id('forwardCountry')} className={labelClass}>
          Pays
          <RequiredMark />
        </label>
        <select
          id={id('forwardCountry')}
          name="forwardCountry"
          autoComplete="country"
          required
          aria-required
          defaultValue={initial('forwardCountry', entry?.address.country ?? 'FR')}
          aria-invalid={errors.forwardCountry ? true : undefined}
          aria-describedby={errors.forwardCountry ? `${id('forwardCountry')}-error` : undefined}
          className={fieldClass}
        >
          {countries.map((country) => (
            <option key={country.code} value={country.code}>
              {country.name}
            </option>
          ))}
        </select>
        {errors.forwardCountry && (
          <p id={`${id('forwardCountry')}-error`} className="mt-1 text-sm text-destructive">
            {errors.forwardCountry}
          </p>
        )}
      </div>
      {!entry?.isDefault && (
        <div className="flex min-h-11 items-center gap-3">
          <input
            id={id('parDefaut')}
            name="parDefaut"
            type="checkbox"
            defaultChecked={values ? values.parDefaut === 'on' : false}
            className="size-5"
          />
          <label htmlFor={id('parDefaut')} className="text-sm font-medium">
            Proposer cette adresse en premier à chaque envoi (adresse par défaut)
          </label>
        </div>
      )}
      <div>
        <button type="submit" disabled={pending} className={primaryClass}>
          {pending ? 'Enregistrement…' : entry ? 'Enregistrer l’adresse' : 'Ajouter l’adresse'}
        </button>
      </div>
    </form>
  )
}
