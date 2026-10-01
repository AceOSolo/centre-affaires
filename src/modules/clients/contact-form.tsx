'use client'

import { useActionState } from 'react'

import Link from 'next/link'

import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import { saveClientContactAction, type ContactFormState } from './contacts-actions.ts'
import { PHONE_FORMAT_HINT, contactFieldLabels, type ContactValues } from './contacts-regles.ts'
import type { ClientContact } from './schema.ts'

const fieldClass =
  'w-full rounded-sm border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/40 aria-[invalid=true]:border-destructive'
const labelClass = 'block text-sm font-medium text-foreground'

/**
 * Contact d'une entreprise cliente, en ajout comme en modification (R07).
 *
 * Un contact est une personne à joindre, pas un accès à l'espace client : le
 * formulaire ne crée aucun compte et n'envoie aucun courriel.
 */
export function ContactForm({
  clientId,
  contact,
  currentPrimaryName,
  defaultPrimary = false,
}: {
  clientId: string
  contact?: ClientContact
  /** Nom du contact principal actuel, quand c'en est un autre que celui-ci. */
  currentPrimaryName?: string | null
  /** Coché d'office pour le premier contact d'une fiche. */
  defaultPrimary?: boolean
}) {
  const [state, formAction, pending] = useActionState<ContactFormState, FormData>(
    saveClientContactAction,
    null,
  )

  const values: ContactValues = state?.values ?? {
    fullName: contact?.fullName ?? '',
    jobTitle: contact?.jobTitle ?? '',
    email: contact?.email ?? '',
    phone: contact?.phone ?? '',
    isPrimary: contact?.isPrimary ?? defaultPrimary,
    isBilling: contact?.isBilling ?? false,
    notes: contact?.notes ?? '',
  }
  const errors = state?.fieldErrors ?? {}
  const cancelHref = `/clients/${clientId}`

  return (
    // Remonté après chaque refus : React réinitialise un formulaire à la fin de
    // l'envoi, la clé le recrée avec les valeurs saisies.
    <form
      key={JSON.stringify(state?.values ?? '')}
      action={formAction}
      noValidate
      className="flex max-w-3xl flex-col gap-5"
    >
      <input type="hidden" name="clientId" value={clientId} />
      {contact && <input type="hidden" name="id" value={contact.id} />}

      <ErrorSummary errors={state?.fieldErrors} labels={contactFieldLabels} message={state?.message} />

      <div className="grid gap-5 sm:grid-cols-2">
        <TextField
          label="Nom"
          name="fullName"
          required
          autoComplete="off"
          defaultValue={values.fullName}
          error={errors.fullName}
          hint="Prénom et nom, ou le nom d’un cabinet."
        />
        <TextField
          label="Fonction"
          name="jobTitle"
          optional
          autoComplete="off"
          defaultValue={values.jobTitle}
          hint="Gérante, expert-comptable, assistante…"
        />
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <TextField
          label="Courriel"
          name="email"
          type="email"
          optional
          autoComplete="off"
          defaultValue={values.email}
          error={errors.email}
        />
        <TextField
          label="Téléphone"
          name="phone"
          type="tel"
          optional
          autoComplete="off"
          defaultValue={values.phone}
          error={errors.phone}
          hint={PHONE_FORMAT_HINT}
        />
      </div>

      <fieldset className="flex flex-col gap-3">
        <legend className="text-sm font-medium text-foreground">Rôle auprès du centre</legend>
        <Checkbox
          name="isPrimary"
          label="Contact principal"
          defaultChecked={values.isPrimary}
          hint={
            currentPrimaryName
              ? `L’interlocuteur à joindre en premier. Coché, il remplace ${currentPrimaryName}, contact principal actuel.`
              : 'L’interlocuteur à joindre en premier. Un seul par entreprise.'
          }
        />
        <Checkbox
          name="isBilling"
          label="Destinataire des factures"
          defaultChecked={values.isBilling}
          hint="Plusieurs contacts peuvent recevoir les factures, le gérant et son comptable par exemple."
        />
      </fieldset>

      <div>
        <label className={labelClass} htmlFor="notes">
          Notes <span className="font-normal text-muted-foreground">(facultatif)</span>
        </label>
        <textarea
          id="notes"
          name="notes"
          rows={3}
          defaultValue={values.notes}
          className={`${fieldClass} mt-1`}
        />
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white transition-colors duration-150 ease-out hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
        >
          {pending ? 'Enregistrement…' : contact ? 'Enregistrer' : 'Ajouter le contact'}
        </button>
        <Link href={cancelHref} className="text-sm text-muted-foreground hover:underline">
          Annuler
        </Link>
        {/* Annoncé pendant l'envoi : le bouton désactivé ne se lit pas seul. */}
        <span aria-live="polite" className="sr-only">
          {pending ? 'Enregistrement en cours' : ''}
        </span>
      </div>
    </form>
  )
}

function TextField({
  label,
  name,
  hint,
  error,
  optional = false,
  ...props
}: {
  label: string
  name: string
  hint?: string
  error?: string
  optional?: boolean
} & React.InputHTMLAttributes<HTMLInputElement>) {
  const describedBy = [error ? `${name}-error` : null, hint ? `${name}-hint` : null]
    .filter(Boolean)
    .join(' ')
  return (
    <div>
      {/* Le libellé est visible, jamais remplacé par un placeholder. L'`id` est
          le nom du champ : c'est la cible du lien du résumé d'erreurs. */}
      <label className={labelClass} htmlFor={name}>
        {label}
        {optional && <span className="font-normal text-muted-foreground"> (facultatif)</span>}
      </label>
      <input
        id={name}
        name={name}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        className={`${fieldClass} mt-1`}
        {...props}
      />
      {error && (
        <p id={`${name}-error`} className="mt-1 text-xs text-destructive">
          {error}
        </p>
      )}
      {hint && (
        <p id={`${name}-hint`} className="mt-1 text-xs text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  )
}

function Checkbox({
  name,
  label,
  hint,
  defaultChecked,
}: {
  name: string
  label: string
  hint: string
  defaultChecked: boolean
}) {
  return (
    <div className="flex items-start gap-3">
      <input
        id={name}
        name={name}
        type="checkbox"
        defaultChecked={defaultChecked}
        aria-describedby={`${name}-hint`}
        className="mt-0.5 size-5 shrink-0 accent-primary"
      />
      <div>
        <label htmlFor={name} className="text-sm font-medium text-foreground">
          {label}
        </label>
        <p id={`${name}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      </div>
    </div>
  )
}
