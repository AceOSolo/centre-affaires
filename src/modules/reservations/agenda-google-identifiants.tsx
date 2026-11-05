'use client'

import { useActionState } from 'react'

import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import { CopyField } from './agenda-google-copie.tsx'
import { saveGoogleClientAction, type GoogleClientFormState } from './agenda-google-actions.ts'

/*
 * Identifiants Google Cloud du centre (ADR 069) : la marche à suivre chez
 * Google, puis l'ID client et le code secret, enregistrés et éprouvés d'un
 * clic qui part aussitôt vers la page de consentement.
 */

const focus = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'
const fieldClass =
  'mt-1 w-full rounded-sm border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/40 aria-[invalid=true]:border-destructive'
const linkClass = `text-primary underline underline-offset-2 ${focus}`
const primaryButton = `rounded-md bg-primary px-4 py-2 text-sm font-medium text-white transition-colors duration-150 ease-out hover:bg-primary-hover disabled:opacity-50 ${focus}`

const CONSOLE = 'https://console.cloud.google.com'

function ExternalLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={linkClass}>
      {children}
      <span className="sr-only"> (nouvel onglet)</span>
    </a>
  )
}

export function GoogleClientForm({ redirectUri }: { redirectUri: string }) {
  const [state, formAction, pending] = useActionState<GoogleClientFormState, FormData>(
    saveGoogleClientAction,
    null,
  )
  const errors = state?.fieldErrors
  const describe = (field: 'clientId' | 'clientSecret') =>
    [`${field}-aide`, errors?.[field] ? `${field}-erreur` : ''].filter(Boolean).join(' ')

  return (
    <div className="flex flex-col gap-4">
      <ol className="flex max-w-3xl list-decimal flex-col gap-3 pl-5 text-sm text-foreground">
        <li>
          Avec le compte Google du centre, ouvrez{' '}
          <ExternalLink href={`${CONSOLE}/apis/library/calendar-json.googleapis.com`}>
            Google Calendar API
          </ExternalLink>{' '}
          dans Google Cloud, créez un projet si on vous le demande, puis cliquez « Activer ».
        </li>
        <li>
          Ouvrez l’
          <ExternalLink href={`${CONSOLE}/apis/credentials/consent`}>écran de consentement</ExternalLink>{' '}
          : public « Externe » pour un compte Gmail, « Interne » pour Google Workspace. Pour
          « Externe », publiez ensuite l’application : en mode test, Google coupe l’accès au bout
          de sept jours.
        </li>
        <li className="flex flex-col gap-2">
          <span>
            <ExternalLink href={`${CONSOLE}/apis/credentials/oauthclient`}>
              Créez un ID client OAuth
            </ExternalLink>{' '}
            de type « Application Web », avec cette URI de redirection autorisée :
          </span>
          <CopyField id="google-uri-redirection" label="URI de redirection autorisée" value={redirectUri} />
        </li>
        <li>
          Google affiche l’ID client et son code secret : collez-les ci-dessous. Sur la page de
          Google qui suit, un avertissement « application non validée » peut s’afficher : cliquez
          « Paramètres avancés », puis « Accéder ».
        </li>
      </ol>

      {/* Remonté après chaque envoi : le code secret ne reste jamais dans le champ. */}
      <form
        key={JSON.stringify(state ?? '')}
        action={formAction}
        noValidate
        className="flex max-w-xl flex-col gap-4"
      >
        <ErrorSummary
          errors={errors as Record<string, string> | undefined}
          labels={{ clientId: 'ID client', clientSecret: 'Code secret du client' }}
          message={state?.message}
        />
        <div>
          <label htmlFor="clientId" className="block text-sm font-medium text-foreground">
            ID client
          </label>
          <input
            id="clientId"
            name="clientId"
            autoComplete="off"
            spellCheck={false}
            defaultValue={state?.values?.clientId ?? ''}
            aria-invalid={errors?.clientId ? true : undefined}
            aria-describedby={describe('clientId')}
            className={fieldClass}
          />
          <p id="clientId-aide" className="mt-1 text-xs text-muted-foreground">
            Il se termine par .apps.googleusercontent.com.
          </p>
          {errors?.clientId && (
            <p id="clientId-erreur" role="alert" className="mt-1 text-xs text-destructive">
              {errors.clientId}
            </p>
          )}
        </div>
        <div>
          <label htmlFor="clientSecret" className="block text-sm font-medium text-foreground">
            Code secret du client
          </label>
          <input
            id="clientSecret"
            name="clientSecret"
            type="password"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={errors?.clientSecret ? true : undefined}
            aria-describedby={describe('clientSecret')}
            className={fieldClass}
          />
          <p id="clientSecret-aide" className="mt-1 text-xs text-muted-foreground">
            Gardé chiffré, jamais réaffiché.
          </p>
          {errors?.clientSecret && (
            <p id="clientSecret-erreur" role="alert" className="mt-1 text-xs text-destructive">
              {errors.clientSecret}
            </p>
          )}
        </div>
        <div>
          <button type="submit" disabled={pending} className={primaryButton}>
            {pending ? 'Vérification auprès de Google…' : 'Enregistrer et connecter le compte Google'}
          </button>
        </div>
      </form>
    </div>
  )
}
