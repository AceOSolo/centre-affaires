'use client'

import { useActionState, useId } from 'react'
import { useFormStatus } from 'react-dom'

import { CheckIcon } from '../../components/ui/icons.tsx'
import { removeEmailLogoAction, uploadEmailLogoAction, type LogoFormState } from './identite-actions.ts'
import type { LogoSource } from './identite.ts'
import { EMAIL_LOGO_ACCEPT } from './logo-courriels.ts'

const sourceLabels: Record<LogoSource, string> = {
  courriels: 'Logo déposé pour les courriels.',
  site: 'Logo du site, utilisé tant qu’aucun logo n’est déposé pour les courriels.',
  aucun: 'Aucun logo : les courriels portent le nom du centre en tête.',
}

/** Bouton d'envoi qui dit l'état de **son** formulaire. */
function SubmitButton({ label, pendingLabel, primary }: { label: string; pendingLabel: string; primary?: boolean }) {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className={`inline-flex min-h-10 items-center rounded-md px-4 text-sm font-medium transition-colors duration-150 ease-out focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-60 ${
        primary
          ? 'bg-primary text-primary-foreground hover:bg-primary-hover'
          : 'border border-border bg-white text-foreground hover:bg-muted'
      }`}
    >
      {pending ? pendingLabel : label}
    </button>
  )
}

/**
 * Logo de l'en-tête des courriels (ADR 080) : celui en place, le dépôt d'un
 * autre (PNG, JPEG ou SVG), le retour au logo du site. Chaque envoi rend son
 * état : en cours, déposé, refusé et pourquoi.
 */
export function EmailLogoForm({
  source,
  src,
  width,
  height,
  centreName,
}: {
  source: LogoSource
  /** Adresse du logo en place sur le site, pour l'afficher ici. */
  src: string | null
  width: number | null
  height: number | null
  centreName: string
}) {
  // Un seul état pour les deux formulaires : l'issue affichée est celle du
  // dernier envoi.
  const [state, action] = useActionState<LogoFormState, FormData>(
    async (previous, formData) =>
      formData.get('intent') === 'retirer' ? removeEmailLogoAction() : uploadEmailLogoAction(previous, formData),
    null,
  )
  const inputId = useId()

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-4">
        {/* Même cadre que l'en-tête du courriel : 56 px de haut, sur blanc. */}
        <div className="flex h-20 min-w-40 items-center justify-center rounded-md border border-border bg-white px-4">
          {src ? (
            // Servi par le site, hors de l'optimiseur d'images, qui refuserait un SVG.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={src}
              alt={`Logo de ${centreName}`}
              width={width ?? undefined}
              height={height ?? 56}
              className="max-h-14 w-auto max-w-[220px]"
            />
          ) : (
            <span className="text-base font-semibold text-primary">{centreName}</span>
          )}
        </div>
        <p className="max-w-prose text-sm text-muted-foreground">{sourceLabels[source]}</p>
      </div>

      <form action={action} className="flex flex-col gap-2">
        <input type="hidden" name="intent" value="deposer" />
        <label htmlFor={inputId} className="text-sm font-medium text-foreground">
          Déposer un logo pour les courriels
          <span aria-hidden="true" className="text-destructive">
            {' '}
            *
          </span>
        </label>
        <p id={`${inputId}-hint`} className="max-w-prose text-xs text-muted-foreground">
          PNG de préférence, sur fond blanc ou transparent, 500 pixels de large environ, 1 Mo au plus. Un SVG est
          accepté, mais Gmail et Outlook n’affichent pas les SVG : ils montrent alors le nom du centre à la place.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <input
            id={inputId}
            name="logo"
            type="file"
            accept={EMAIL_LOGO_ACCEPT}
            required
            aria-required="true"
            aria-describedby={`${inputId}-hint`}
            className="max-w-full text-sm file:mr-3 file:min-h-10 file:rounded-md file:border file:border-border file:bg-white file:px-3 file:text-sm file:font-medium hover:file:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          />
          <SubmitButton label="Déposer le logo" pendingLabel="Dépôt en cours…" primary />
        </div>
      </form>

      {source === 'courriels' && (
        <form action={action}>
          <input type="hidden" name="intent" value="retirer" />
          <SubmitButton label="Revenir au logo du site" pendingLabel="Retour en cours…" />
        </form>
      )}

      <div aria-live="polite" className="empty:hidden">
        {state?.saved && (
          <p className="flex items-center gap-2 text-sm text-foreground">
            <CheckIcon size={20} className="shrink-0 text-primary" />
            {state.saved === 'retire'
              ? 'Les courriels reprennent le logo du site.'
              : 'Logo déposé : les prochains courriels le portent.'}
          </p>
        )}
      </div>
      {state?.error && (
        <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-foreground">
          {state.error}
        </p>
      )}
    </div>
  )
}
