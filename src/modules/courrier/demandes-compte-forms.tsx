'use client'

import { useActionState, useState } from 'react'

import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import {
  cancelMailRequestAction,
  requestForwardAction,
  requestScanAction,
  type ClientRequestState,
} from './demandes-compte-actions.ts'

/**
 * Formulaires de l'espace client pour les demandes sur un pli (R21) : mobile
 * d'abord, champs et boutons à 44 px, 8 px au moins entre deux cibles
 * (`CLAUDE.md`). Chaque champ a son libellé visible ; une erreur est dite à
 * côté du champ et dans le résumé en tête, focalisé à l'échec.
 */
const fieldClass =
  'mt-1 block min-h-11 w-full rounded-sm border border-border bg-white px-3 py-2 text-base outline-none focus:border-accent focus:ring-2 focus:ring-accent/40 aria-[invalid=true]:border-destructive sm:text-sm'
const labelClass = 'block text-sm font-medium text-foreground'
const primaryClass =
  'press inline-flex min-h-11 w-full items-center justify-center rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-60 sm:w-auto'

function FieldError({ name, error }: { name: string; error?: string }) {
  if (!error) return null
  return (
    <p id={`${name}-error`} className="mt-1 text-sm text-destructive">
      {error}
    </p>
  )
}

const describedBy = (name: string, error?: string, hint = true) =>
  [hint ? `${name}-hint` : null, error ? `${name}-error` : null].filter(Boolean).join(' ') || undefined

/** Numérisation seule d'un pli déjà ouvert. */
export function ScanRequestForm({ mailItemId, announcement }: { mailItemId: string; announcement: string }) {
  const [state, formAction, pending] = useActionState<ClientRequestState, FormData>(requestScanAction, null)
  const error = state?.fieldErrors?.scanNote

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="id" value={mailItemId} />
      <ErrorSummary errors={state?.fieldErrors} labels={{ scanNote: 'Précisions' }} message={state?.error} />
      <div>
        <label htmlFor="scanNote" className={labelClass}>
          Précisions pour le centre <span className="font-normal text-muted-foreground">(facultatif)</span>
        </label>
        <textarea
          id="scanNote"
          name="scanNote"
          rows={2}
          maxLength={500}
          defaultValue={state?.values?.scanNote ?? ''}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy('scanNote', error)}
          className={fieldClass}
        />
        <p id="scanNote-hint" className="mt-1 text-sm text-muted-foreground">
          Par exemple : numériser aussi les annexes, ou la page 3 en couleur.
        </p>
        <FieldError name="scanNote" error={error} />
      </div>
      <p className="text-sm text-muted-foreground">{announcement}</p>
      <div>
        <button type="submit" disabled={pending} className={primaryClass}>
          {pending ? 'Envoi de la demande…' : 'Demander la numérisation'}
        </button>
      </div>
    </form>
  )
}

export type AddressOption = { requestId: string; label: string; lines: string[] }

const addressLabels: Record<string, string> = {
  adresse: 'Adresse de réexpédition',
  forwardRecipient: 'Destinataire',
  forwardAddressLine1: 'Adresse',
  forwardAddressLine2: 'Complément d’adresse',
  forwardPostalCode: 'Code postal',
  forwardCity: 'Ville',
  forwardCountry: 'Pays',
  forwardNote: 'Précisions',
}

/**
 * Réexpédition : une adresse déjà utilisée par l'entreprise, ou une autre,
 * saisie ici. Elle est figée dans la demande (ADR 037) : pour en changer,
 * on annule et on redemande.
 */
export function ForwardRequestForm({
  mailItemId,
  clientId,
  previous,
  countries,
  announcement,
}: {
  mailItemId: string
  clientId: string
  previous: AddressOption[]
  countries: { code: string; name: string }[]
  announcement: string
}) {
  const [state, formAction, pending] = useActionState<ClientRequestState, FormData>(
    requestForwardAction,
    null,
  )
  const values = state?.values
  const errors = state?.fieldErrors ?? {}
  const [choice, setChoice] = useState(values?.adresse || previous[0]?.requestId || 'nouvelle')
  const typing = choice === 'nouvelle'

  const input = (name: string, label: string, options: { optional?: boolean; autoComplete?: string; hint?: string } = {}) => (
    <div>
      <label htmlFor={name} className={labelClass}>
        {label}
        {options.optional && <span className="font-normal text-muted-foreground"> (facultatif)</span>}
      </label>
      <input
        id={name}
        name={name}
        required={!options.optional && typing}
        autoComplete={options.autoComplete}
        defaultValue={values?.[name] ?? ''}
        aria-invalid={errors[name] ? true : undefined}
        aria-describedby={describedBy(name, errors[name], Boolean(options.hint))}
        className={fieldClass}
      />
      {options.hint && (
        <p id={`${name}-hint`} className="mt-1 text-sm text-muted-foreground">
          {options.hint}
        </p>
      )}
      <FieldError name={name} error={errors[name]} />
    </div>
  )

  return (
    // Remonté après un échec pour reprendre les valeurs saisies.
    <form key={JSON.stringify(values ?? {})} action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="id" value={mailItemId} />
      <input type="hidden" name="clientId" value={clientId} />
      <ErrorSummary errors={state?.fieldErrors} labels={addressLabels} message={state?.error} />

      {previous.length > 0 && (
        <fieldset className="flex flex-col gap-2">
          <legend id="adresse" tabIndex={-1} className={`${labelClass} mb-1`}>
            Adresse de réexpédition
          </legend>
          {previous.map((option) => (
            <label
              key={option.requestId}
              className="flex min-h-11 cursor-pointer items-start gap-3 rounded-md border border-border bg-white px-3 py-3 has-[:checked]:border-primary has-[:checked]:bg-accent/5"
            >
              <input
                type="radio"
                name="adresse"
                value={option.requestId}
                checked={choice === option.requestId}
                onChange={() => setChoice(option.requestId)}
                className="mt-1 size-5 shrink-0 accent-[var(--primary)]"
              />
              <span className="text-sm">
                <span className="block font-medium">{option.label}</span>
                <span className="block text-muted-foreground">{option.lines.join(', ')}</span>
              </span>
            </label>
          ))}
          <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-border bg-white px-3 py-3 has-[:checked]:border-primary has-[:checked]:bg-accent/5">
            <input
              type="radio"
              name="adresse"
              value="nouvelle"
              checked={typing}
              onChange={() => setChoice('nouvelle')}
              className="size-5 shrink-0 accent-[var(--primary)]"
            />
            <span className="text-sm font-medium">Une autre adresse</span>
          </label>
          <FieldError name="adresse" error={errors.adresse} />
        </fieldset>
      )}
      {previous.length === 0 && <input type="hidden" name="adresse" value="nouvelle" />}

      {/* Masqués plutôt que retirés : la saisie en cours survit à un changement d'avis. */}
      <fieldset hidden={!typing} className="flex flex-col gap-4">
        <legend className="sr-only">Nouvelle adresse</legend>
        {input('forwardRecipient', 'Destinataire', { autoComplete: 'name', hint: 'Personne ou société, tel qu’il doit figurer sur l’enveloppe.' })}
        {input('forwardAddressLine1', 'Adresse', { autoComplete: 'address-line1' })}
        {input('forwardAddressLine2', 'Complément d’adresse', { optional: true, autoComplete: 'address-line2' })}
        <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
          {input('forwardPostalCode', 'Code postal', { autoComplete: 'postal-code' })}
          {input('forwardCity', 'Ville', { autoComplete: 'address-level2' })}
        </div>
        <div>
          <label htmlFor="forwardCountry" className={labelClass}>
            Pays
          </label>
          <select
            id="forwardCountry"
            name="forwardCountry"
            autoComplete="country"
            defaultValue={values?.forwardCountry || 'FR'}
            aria-invalid={errors.forwardCountry ? true : undefined}
            aria-describedby={describedBy('forwardCountry', errors.forwardCountry, false)}
            className={fieldClass}
          >
            {countries.map((country) => (
              <option key={country.code} value={country.code}>
                {country.name}
              </option>
            ))}
          </select>
          <FieldError name="forwardCountry" error={errors.forwardCountry} />
        </div>
      </fieldset>

      <div>
        <label htmlFor="forwardNote" className={labelClass}>
          Précisions pour le centre <span className="font-normal text-muted-foreground">(facultatif)</span>
        </label>
        <textarea
          id="forwardNote"
          name="forwardNote"
          rows={2}
          maxLength={500}
          defaultValue={values?.forwardNote ?? ''}
          aria-invalid={errors.forwardNote ? true : undefined}
          aria-describedby={describedBy('forwardNote', errors.forwardNote)}
          className={fieldClass}
        />
        <p id="forwardNote-hint" className="mt-1 text-sm text-muted-foreground">
          Par exemple : envoyer en lettre suivie.
        </p>
        <FieldError name="forwardNote" error={errors.forwardNote} />
      </div>

      <p className="text-sm text-muted-foreground">{announcement}</p>
      <div>
        <button type="submit" disabled={pending} className={primaryClass}>
          {pending ? 'Envoi de la demande…' : 'Demander la réexpédition'}
        </button>
      </div>
    </form>
  )
}

/**
 * Annulation d'une demande que le centre n'a pas encore prise en charge. La
 * demande reste dans l'historique, annulée, au nom de la personne.
 */
export function CancelMailRequestButton({
  requestId,
  mailItemId,
  from,
  label,
}: {
  requestId: string
  mailItemId: string
  from: 'pli' | 'demandes'
  /** Nom accessible : « Annuler la demande de réexpédition du 12 sept. ». */
  label: string
}) {
  const [state, formAction, pending] = useActionState<ClientRequestState, FormData>(
    cancelMailRequestAction,
    null,
  )
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="id" value={requestId} />
      <input type="hidden" name="mailItemId" value={mailItemId} />
      <input type="hidden" name="retour" value={from} />
      <button
        type="submit"
        disabled={pending}
        aria-label={label}
        className="inline-flex min-h-11 w-full items-center justify-center rounded-md border border-border bg-white px-5 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-60 sm:w-auto"
      >
        {pending ? 'Annulation…' : 'Annuler la demande'}
      </button>
      {/* Toujours présent, pour que le lecteur d'écran annonce le résultat. */}
      <p aria-live="polite" className="text-sm empty:hidden">
        {state?.error && <span className="text-destructive">{state.error}</span>}
      </p>
    </form>
  )
}
