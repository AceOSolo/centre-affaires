'use client'

import { useActionState } from 'react'

import { ErrorSummary } from '../../../components/ui/error-summary.tsx'
import { addTeamMemberAction, type TeamFormState } from '../../../lib/auth/equipe-actions.ts'

const fieldClass =
  'w-full rounded-sm border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/40 aria-[invalid=true]:border-destructive'
const labelClass = 'block text-sm font-medium text-foreground'

/**
 * Inscription d'un membre de l'équipe par son adresse (ADR 008, ADR 019).
 *
 * Aucun courriel n'est envoyé : la personne crée son accès sur la page de
 * connexion avec cette adresse, et le rattachement se fait à sa première
 * connexion.
 *
 * Les rôles arrivent du serveur, libellés compris : le schéma de la base n'a
 * pas à voyager jusqu'au navigateur.
 */
export function TeamMemberForm({ roles }: { roles: { value: string; label: string }[] }) {
  const [state, formAction, pending] = useActionState<TeamFormState, FormData>(
    addTeamMemberAction,
    null,
  )
  const emailError = state?.fieldErrors?.email
  const roleError = state?.fieldErrors?.role

  return (
    <div className="flex flex-col gap-3">
      {/* Remonté après chaque envoi : vide après un ajout, rempli après un refus
          (React réinitialise le formulaire à la fin de l'envoi). */}
      <form
        key={JSON.stringify(state?.values ?? state?.ok ?? '')}
        action={formAction}
        className="flex flex-col gap-3"
      >
        <ErrorSummary errors={state?.fieldErrors} labels={{ email: 'Adresse', role: 'Rôle' }} />

        <div className="grid gap-3 sm:grid-cols-[3fr_2fr_2fr_auto] sm:items-start">
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
            {emailError && (
              <p id="email-error" className="mt-1 text-xs text-destructive">
                {emailError}
              </p>
            )}
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
          <div>
            <label className={labelClass} htmlFor="role">
              Rôle
            </label>
            <select
              id="role"
              name="role"
              defaultValue={state?.values?.role ?? 'staff'}
              aria-invalid={roleError ? true : undefined}
              aria-describedby={roleError ? 'role-error' : undefined}
              className={`${fieldClass} mt-1`}
            >
              {roles.map((role) => (
                <option key={role.value} value={role.value}>
                  {role.label}
                </option>
              ))}
            </select>
            {roleError && (
              <p id="role-error" className="mt-1 text-xs text-destructive">
                {roleError}
              </p>
            )}
          </div>
          <button
            type="submit"
            disabled={pending}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-hover disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:mt-6"
          >
            {pending ? 'Inscription…' : 'Inscrire'}
          </button>
        </div>
      </form>
      {/* Hors du formulaire remonté : une région annoncée doit exister avant
          que son contenu change, sinon le lecteur d'écran ne dit rien. */}
      <p aria-live="polite" className="text-sm text-primary empty:hidden">
        {state?.ok}
      </p>
    </div>
  )
}
