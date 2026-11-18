'use client'

import { useActionState } from 'react'

import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import { saveEmailIdentityAction, type IdentityFormState } from './identite-actions.ts'
import { emailIdentityLabels as labels, SIGNATURE_LINE_MAX, SIGNATURE_MAX_LINES } from './identite.ts'

const fieldClass =
  'mt-1 w-full rounded-sm border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/40 aria-[invalid=true]:border-destructive'
const labelClass = 'block text-sm font-medium text-foreground'

function describedBy(name: string, error: string | undefined, hint: boolean) {
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

/**
 * Formulaire « Nom et signature » (ADR 080) : nom du centre, téléphone, site,
 * lignes de signature. Le nom est obligatoire : astérisque, `required` et
 * `aria-required` ; la phrase qui l'explique est en tête de la section
 * (recette du 17/11).
 */
export function EmailIdentityForm({
  values,
  automaticLines,
}: {
  values: Record<string, string>
  /** Signature automatique, montrée tant que les lignes ne sont pas saisies. */
  automaticLines: readonly string[]
}) {
  const [state, formAction, pending] = useActionState<IdentityFormState, FormData>(saveEmailIdentityAction, null)
  const value = (name: string) => state?.values?.[name] ?? values[name] ?? ''
  const error = (name: string) => state?.fieldErrors?.[name]

  return (
    <form
      // Remonté après un échec pour reprendre la saisie, que React efface à la
      // fin de l'envoi.
      key={JSON.stringify(state?.values ?? values)}
      action={formAction}
      className="flex flex-col gap-4"
    >
      <ErrorSummary errors={state?.fieldErrors} labels={labels} message={state?.error} />

      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <label className={labelClass} htmlFor="name">
            {labels.name}
            <span aria-hidden="true" className="text-destructive">
              {' '}
              *
            </span>
          </label>
          <input
            id="name"
            name="name"
            required
            aria-required="true"
            defaultValue={value('name')}
            autoComplete="organization"
            aria-invalid={error('name') ? true : undefined}
            aria-describedby={describedBy('name', error('name'), true)}
            className={fieldClass}
          />
          <p id="name-hint" className="mt-1 text-xs text-muted-foreground">
            En tête de la signature, et partout où le site nomme le centre.
          </p>
          <FieldError name="name" error={error('name')} />
        </div>
        <div>
          <label className={labelClass} htmlFor="phone">
            {labels.phone}
          </label>
          <input
            id="phone"
            name="phone"
            type="tel"
            defaultValue={value('phone')}
            autoComplete="tel"
            inputMode="tel"
            aria-invalid={error('phone') ? true : undefined}
            aria-describedby={describedBy('phone', error('phone'), true)}
            className={`${fieldClass} tabular`}
          />
          <p id="phone-hint" className="mt-1 text-xs text-muted-foreground">
            Exemple : 04 28 35 09 31. Affiché aussi sur le site public.
          </p>
          <FieldError name="phone" error={error('phone')} />
        </div>
        <div>
          <label className={labelClass} htmlFor="websiteUrl">
            {labels.websiteUrl}
          </label>
          <input
            id="websiteUrl"
            name="websiteUrl"
            defaultValue={value('websiteUrl')}
            autoComplete="url"
            inputMode="url"
            spellCheck={false}
            aria-invalid={error('websiteUrl') ? true : undefined}
            aria-describedby={describedBy('websiteUrl', error('websiteUrl'), true)}
            className={fieldClass}
          />
          <p id="websiteUrl-hint" className="mt-1 text-xs text-muted-foreground">
            Exemple : www.centre.fr
          </p>
          <FieldError name="websiteUrl" error={error('websiteUrl')} />
        </div>
      </div>

      <div className="max-w-2xl">
        <label className={labelClass} htmlFor="emailSignature">
          {labels.emailSignature}
        </label>
        <textarea
          id="emailSignature"
          name="emailSignature"
          rows={4}
          defaultValue={value('emailSignature')}
          aria-invalid={error('emailSignature') ? true : undefined}
          aria-describedby={describedBy('emailSignature', error('emailSignature'), true)}
          className={`${fieldClass} leading-relaxed`}
        />
        <div id="emailSignature-hint" className="mt-1 text-xs text-muted-foreground">
          <p>
            Sous le nom du centre, {SIGNATURE_MAX_LINES} lignes au plus de {SIGNATURE_LINE_MAX} caractères. Laissées
            vides, elles reprennent l’adresse du centre, son téléphone, son adresse e-mail et son site :
          </p>
          {automaticLines.length > 0 ? (
            <p className="mt-1 whitespace-pre-line rounded-sm bg-muted px-2 py-1 text-foreground">
              {automaticLines.join('\n')}
            </p>
          ) : (
            <p className="mt-1">Aucune coordonnée renseignée pour l’instant.</p>
          )}
        </div>
        <FieldError name="emailSignature" error={error('emailSignature')} />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50"
        >
          {pending ? 'Enregistrement…' : 'Enregistrer la signature'}
        </button>
        <p role="status" className="text-sm text-primary">
          {state?.saved && !pending ? 'Enregistré. L’aperçu ci-dessous est à jour.' : ''}
        </p>
      </div>
    </form>
  )
}
