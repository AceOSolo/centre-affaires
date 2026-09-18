'use client'

import { useActionState } from 'react'

import Link from 'next/link'

import { createClientAction, updateClientAction, type FormState } from './actions.ts'
import { clientStatusLabels } from './labels.ts'
import { clientStatuses, type Client } from './schema.ts'

const fieldClass =
  'w-full rounded-sm border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/40'
const labelClass = 'block text-sm font-medium text-foreground'

/**
 * Fiche client, en création comme en modification : les deux formulaires ont
 * les mêmes champs et les mêmes règles, les séparer les ferait diverger.
 */
export function ClientForm({ client }: { client?: Client }) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    client ? updateClientAction : createClientAction,
    null,
  )

  return (
    <form action={formAction} className="flex max-w-3xl flex-col gap-5">
      {client && <input type="hidden" name="id" value={client.id} />}

      {state?.error && (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
        >
          {state.error}
        </p>
      )}

      <fieldset className="flex flex-col gap-5">
        <legend className="text-sm font-semibold tracking-tight">Identité</legend>

        <div className="grid gap-5 sm:grid-cols-[2fr_1fr]">
          <Field label="Raison sociale" name="name" required defaultValue={client?.name} />
          <Field
            label="Forme juridique"
            name="legalForm"
            placeholder="SAS"
            defaultValue={client?.legalForm ?? ''}
          />
        </div>

        <div className="grid gap-5 sm:grid-cols-3">
          <Field
            label="SIRET"
            name="siret"
            placeholder="12345678900012"
            hint="14 chiffres. Vide pour un client étranger."
            className="font-mono"
            defaultValue={client?.siret ?? ''}
          />
          <Field
            label="N° TVA"
            name="vatNumber"
            placeholder="FR12345678900"
            className="font-mono"
            defaultValue={client?.vatNumber ?? ''}
          />
          <div>
            <label className={labelClass} htmlFor="status">
              Statut
            </label>
            <select
              id="status"
              name="status"
              defaultValue={client?.status ?? 'prospect'}
              className={`${fieldClass} mt-1`}
            >
              {clientStatuses.map((status) => (
                <option key={status} value={status}>
                  {clientStatusLabels[status]}
                </option>
              ))}
            </select>
          </div>
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-5">
        <legend className="text-sm font-semibold tracking-tight">Contact</legend>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Courriel" name="email" type="email" defaultValue={client?.email ?? ''} />
          <Field label="Téléphone" name="phone" type="tel" defaultValue={client?.phone ?? ''} />
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-5">
        <legend className="text-sm font-semibold tracking-tight">Adresse</legend>
        <Field label="Adresse" name="addressLine1" defaultValue={client?.addressLine1 ?? ''} />
        <Field
          label="Complément"
          name="addressLine2"
          defaultValue={client?.addressLine2 ?? ''}
        />
        <div className="grid gap-5 sm:grid-cols-[1fr_2fr_1fr]">
          <Field label="Code postal" name="postalCode" defaultValue={client?.postalCode ?? ''} />
          <Field label="Ville" name="city" defaultValue={client?.city ?? ''} />
          <Field
            label="Pays"
            name="country"
            maxLength={2}
            className="uppercase"
            hint="Code ISO"
            defaultValue={client?.country ?? 'FR'}
          />
        </div>
      </fieldset>

      <div>
        <label className={labelClass} htmlFor="notes">
          Notes <span className="font-normal text-muted-foreground">(facultatif)</span>
        </label>
        <textarea
          id="notes"
          name="notes"
          rows={3}
          defaultValue={client?.notes ?? ''}
          className={`${fieldClass} mt-1`}
        />
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50"
        >
          {pending ? 'Enregistrement…' : client ? 'Enregistrer' : 'Créer le client'}
        </button>
        <Link
          href={client ? `/clients/${client.id}` : '/clients'}
          className="text-sm text-muted-foreground hover:underline"
        >
          Annuler
        </Link>
      </div>
    </form>
  )
}

function Field({
  label,
  name,
  hint,
  className = '',
  ...props
}: {
  label: string
  name: string
  hint?: string
} & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div>
      {/* Le libellé est visible, jamais remplacé par un placeholder. */}
      <label className={labelClass} htmlFor={name}>
        {label}
      </label>
      <input
        id={name}
        name={name}
        aria-describedby={hint ? `${name}-hint` : undefined}
        className={`${fieldClass} mt-1 ${className}`}
        {...props}
      />
      {hint && (
        <p id={`${name}-hint`} className="mt-1 text-xs text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  )
}
