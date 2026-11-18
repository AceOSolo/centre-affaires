'use client'

import { useActionState } from 'react'

import { ImagePlusIcon } from '../../components/ui/icons.tsx'
import { prepareResourceMediaAction, type ResourceMediaState } from './actions.ts'

/**
 * Photos et vidéos d'une ressource qui n'a pas encore d'annonce (ADR 082) :
 * elles se rangent dans l'annonce du site (ADR 073), que le bouton crée en
 * brouillon. La fiche se redessine aussitôt avec le bloc d'ajout.
 */
export function ResourceMediaStart({ resourceId }: { resourceId: string }) {
  const [state, formAction, pending] = useActionState<ResourceMediaState, FormData>(
    prepareResourceMediaAction,
    null,
  )

  return (
    <form action={formAction} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="id" value={resourceId} />
      <button
        type="submit"
        disabled={pending}
        className="inline-flex min-h-10 items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-white transition-colors duration-150 ease-out hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
      >
        <ImagePlusIcon size={18} />
        {pending ? 'Préparation…' : 'Ajouter des photos et vidéos'}
      </button>
      {/* Région présente dès le premier rendu : l'état est lu, pas seulement vu. */}
      <p aria-live="polite" className="text-sm empty:hidden">
        {pending && <span className="sr-only">Préparation de l’annonce en brouillon.</span>}
        {!pending && state?.error && (
          <span role="alert" className="text-destructive">
            {state.error}
          </span>
        )}
      </p>
    </form>
  )
}
