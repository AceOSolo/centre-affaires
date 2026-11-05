'use client'

import { useActionState } from 'react'

import Link from 'next/link'

import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import { inviteNewClientAction, type QuickInviteFormState } from './comptes-actions.ts'

const fieldClass =
  'w-full rounded-sm border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/40 aria-[invalid=true]:border-destructive'
const labelClass = 'block text-sm font-medium text-foreground'

const labels = { email: 'Adresse électronique', fullName: 'Nom', company: 'Entreprise' }

/**
 * « Inviter un client » (ADR 068) : une adresse, et si on les connaît un nom
 * et une entreprise. La fiche prospect est créée, la personne reçoit le lien
 * pour choisir son mot de passe. Pour donner l'accès à une entreprise qui a
 * déjà sa fiche, on passe par la fiche, comme avant.
 */
export function InviteClientForm() {
  const [state, formAction, pending] = useActionState<QuickInviteFormState, FormData>(inviteNewClientAction, null)
  const errors = state?.fieldErrors

  return (
    <div className="flex flex-col gap-3">
      {/* Remonté après chaque envoi : vide après une invitation, rempli après
          un refus (React réinitialise le formulaire à la fin de l'envoi). */}
      <form
        key={JSON.stringify(state?.values ?? state?.ok ?? '')}
        action={formAction}
        noValidate
        className="flex flex-col gap-3"
      >
        <ErrorSummary errors={errors} labels={labels} />

        <div className="grid gap-3 lg:grid-cols-[3fr_2fr_2fr_auto] lg:items-start">
          <div>
            <label className={labelClass} htmlFor="email">
              {labels.email}
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="off"
              defaultValue={state?.values?.email ?? ''}
              aria-invalid={errors?.email ? true : undefined}
              aria-describedby={errors?.email ? 'email-error' : undefined}
              className={`${fieldClass} mt-1`}
            />
            {errors?.email && (
              <p id="email-error" role="alert" className="mt-1 text-xs text-destructive">
                {errors.email}{' '}
                {state?.client && (
                  <Link href={`/clients/${state.client.id}`} className="font-medium underline underline-offset-2">
                    Ouvrir la fiche
                  </Link>
                )}
              </p>
            )}
          </div>
          <div>
            <label className={labelClass} htmlFor="fullName">
              {labels.fullName} <span className="font-normal text-muted-foreground">(facultatif)</span>
            </label>
            <input
              id="fullName"
              name="fullName"
              autoComplete="off"
              maxLength={255}
              defaultValue={state?.values?.fullName ?? ''}
              aria-invalid={errors?.fullName ? true : undefined}
              aria-describedby={errors?.fullName ? 'fullName-error' : undefined}
              className={`${fieldClass} mt-1`}
            />
            {errors?.fullName && (
              <p id="fullName-error" role="alert" className="mt-1 text-xs text-destructive">
                {errors.fullName}
              </p>
            )}
          </div>
          <div>
            <label className={labelClass} htmlFor="company">
              {labels.company} <span className="font-normal text-muted-foreground">(facultatif)</span>
            </label>
            <input
              id="company"
              name="company"
              autoComplete="off"
              maxLength={255}
              defaultValue={state?.values?.company ?? ''}
              aria-invalid={errors?.company ? true : undefined}
              aria-describedby={errors?.company ? 'company-error' : 'company-hint'}
              className={`${fieldClass} mt-1`}
            />
            {errors?.company ? (
              <p id="company-error" role="alert" className="mt-1 text-xs text-destructive">
                {errors.company}
              </p>
            ) : (
              <p id="company-hint" className="mt-1 text-xs text-muted-foreground">
                Vide : la fiche porte le nom de la personne.
              </p>
            )}
          </div>
          <button
            type="submit"
            disabled={pending}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50 lg:mt-6"
          >
            {pending ? 'Envoi…' : 'Inviter'}
          </button>
        </div>
      </form>
      {/* Hors du formulaire remonté : une région annoncée doit exister avant
          que son contenu change, sinon le lecteur d'écran ne dit rien. */}
      <p aria-live="polite" className="text-sm text-primary empty:hidden">
        {state?.ok}
        {state?.ok && state.client && (
          <>
            {' '}
            <Link href={`/clients/${state.client.id}`} className="font-medium underline underline-offset-2">
              Ouvrir la fiche
            </Link>
          </>
        )}
      </p>
    </div>
  )
}
