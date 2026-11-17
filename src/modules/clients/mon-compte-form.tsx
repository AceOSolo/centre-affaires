'use client'

import { useActionState } from 'react'

import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import { saveProfileAction, type ProfileFormState } from './mon-compte-actions.ts'
import { PHONE_FORMAT_HINT, profileFieldLabels, type ProfileValues } from './mon-compte.ts'

const fieldClass =
  'mt-1.5 w-full rounded-lg border border-border bg-white px-3 py-2.5 text-base outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/40 aria-[invalid=true]:border-destructive'
const labelClass = 'block text-sm font-medium text-foreground'

/**
 * Mes informations (ADR 077) : nom et téléphone, que l'équipe voit sur la
 * fiche du client. L'adresse se lit, elle ne se change pas ici : c'est
 * l'identifiant du compte (`mon-compte.ts`).
 *
 * L'astérisque du champ obligatoire n'est pas la seule information :
 * `required` et `aria-required` sur le contrôle, et la phrase en tête du
 * formulaire. Le composant commun de l'astérisque (lot 1 de la recette du
 * 17/11) le remplacera à la fusion.
 */
export function ProfileForm({ initial, email }: { initial: ProfileValues; email: string }) {
  const [state, formAction, pending] = useActionState<ProfileFormState, FormData>(saveProfileAction, null)
  const values = state?.values ?? initial
  const errors = state?.errors ?? {}

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      <p className="text-sm text-muted-foreground">
        Les champs marqués <span aria-hidden="true">*</span>
        <span className="sr-only">d’un astérisque</span> sont obligatoires.
      </p>
      <ErrorSummary errors={state?.errors} labels={profileFieldLabels} message={state?.error} />

      <div>
        <label className={labelClass} htmlFor="fullName">
          {profileFieldLabels.fullName}{' '}
          <span aria-hidden="true" className="text-primary">
            *
          </span>
        </label>
        <input
          id="fullName"
          name="fullName"
          type="text"
          required
          aria-required="true"
          autoComplete="name"
          maxLength={120}
          defaultValue={values.fullName}
          key={`nom-${values.fullName}`}
          aria-invalid={errors.fullName ? true : undefined}
          aria-describedby={errors.fullName ? 'fullName-error' : undefined}
          className={fieldClass}
        />
        {errors.fullName && (
          <p id="fullName-error" role="alert" className="mt-1 text-sm text-destructive">
            {errors.fullName}
          </p>
        )}
      </div>

      <div>
        <label className={labelClass} htmlFor="phone">
          {profileFieldLabels.phone}
        </label>
        <input
          id="phone"
          name="phone"
          type="tel"
          autoComplete="tel"
          inputMode="tel"
          defaultValue={values.phone}
          key={`tel-${values.phone}`}
          aria-invalid={errors.phone ? true : undefined}
          aria-describedby={errors.phone ? 'phone-error phone-hint' : 'phone-hint'}
          className={fieldClass}
        />
        <p id="phone-hint" className="mt-1 text-xs text-muted-foreground">
          Facultatif. {PHONE_FORMAT_HINT}
        </p>
        {errors.phone && (
          <p id="phone-error" role="alert" className="mt-1 text-sm text-destructive">
            {errors.phone}
          </p>
        )}
      </div>

      <div>
        <p className={labelClass} id="email-label">
          Adresse électronique
        </p>
        <p aria-labelledby="email-label" className="mt-1.5 break-all rounded-lg bg-muted px-3 py-2.5 text-base">
          {email}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          C’est votre identifiant de connexion. Pour en changer, demandez-le à l’accueil du centre.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex min-h-11 items-center rounded-xl bg-primary px-5 text-sm font-medium text-white transition-colors hover:bg-primary-hover disabled:opacity-60"
        >
          {pending ? 'Enregistrement…' : 'Enregistrer mes informations'}
        </button>
        <p role="status" className="text-sm text-primary">
          {state?.saved && !pending ? 'Vos informations sont enregistrées.' : ''}
        </p>
      </div>
    </form>
  )
}
