'use client'

import { useActionState } from 'react'

import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import { addClientMemberAction, type MemberFormState } from './comptes-actions.ts'

const fieldClass =
  'w-full rounded-sm border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/40 aria-[invalid=true]:border-destructive'
const labelClass = 'block text-sm font-medium text-foreground'

/**
 * Inscription d'une personne à l'espace d'une entreprise cliente.
 *
 * Aucun courriel n'est envoyé : la personne crée son accès avec cette adresse,
 * et le rattachement se fait à sa première connexion (ADR 015).
 */
export function MemberForm({ clientId }: { clientId: string }) {
  const [state, formAction, pending] = useActionState<MemberFormState, FormData>(
    addClientMemberAction,
    null,
  )
  const emailError = state?.fieldErrors?.email

  return (
    <div className="flex flex-col gap-3">
      {/* Remonté après chaque envoi : vide après un ajout, rempli après un refus
          (React réinitialise le formulaire à la fin de l'envoi). */}
      <form
        key={JSON.stringify(state?.values ?? state?.ok ?? '')}
        action={formAction}
        className="flex flex-col gap-3"
      >
        <input type="hidden" name="clientId" value={clientId} />
        <ErrorSummary errors={state?.fieldErrors} labels={{ email: 'Adresse' }} />

        <div className="grid gap-3 sm:grid-cols-[3fr_2fr_auto] sm:items-end">
          <div>
            <label className={labelClass} htmlFor="email">
              Adresse électronique
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="off"
              defaultValue={state?.values?.email ?? ''}
              aria-invalid={emailError ? true : undefined}
              aria-describedby={emailError ? 'email-error' : undefined}
              className={`${fieldClass} mt-1`}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="fullName">
              Nom <span className="font-normal text-muted-foreground">(facultatif)</span>
            </label>
            <input
              id="fullName"
              name="fullName"
              autoComplete="off"
              defaultValue={state?.values?.fullName ?? ''}
              className={`${fieldClass} mt-1`}
            />
          </div>
          <button
            type="submit"
            disabled={pending}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50"
          >
            {pending ? 'Ajout…' : 'Donner l’accès'}
          </button>
        </div>
        {emailError && (
          <p id="email-error" className="text-xs text-destructive">
            {emailError}
          </p>
        )}
      </form>
      {/* Hors du formulaire remonté : une région annoncée doit exister avant
          que son contenu change, sinon le lecteur d'écran ne dit rien. */}
      <p aria-live="polite" className="text-sm text-primary empty:hidden">
        {state?.ok}
      </p>
    </div>
  )
}
