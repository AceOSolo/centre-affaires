'use client'

import { useActionState } from 'react'

import Link from 'next/link'

import { saveListingAction, type FormState } from './annonces-actions.ts'
import { resourceTypeLabels } from './labels.ts'
import type { Listing, Resource } from './schema.ts'

const fieldClass =
  'w-full rounded-md border border-border bg-white px-3 py-2 text-sm outline-none focus:border-primary'
const labelClass = 'block text-sm font-medium text-foreground'

/**
 * Rédaction d'une annonce.
 *
 * Le titre est distinct du nom interne de la ressource : « Salle Europe, 12
 * places, vue sur cour » se lit mieux sur le site public que « S-101 ».
 */
export function AnnonceForm({
  resource,
  listing,
  resources,
}: {
  resource?: Resource
  listing?: Listing
  /** Proposées à la création, quand aucune ressource n'est encore choisie. */
  resources: Resource[]
}) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    saveListingAction,
    null,
  )

  const sansAnnonce = resources

  return (
    <form action={formAction} className="flex max-w-2xl flex-col gap-5">
      {state?.error && (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
        >
          {state.error}
        </p>
      )}

      {resource ? (
        <>
          <input type="hidden" name="resourceId" value={resource.id} />
          <p className="rounded-md border border-border bg-muted px-4 py-3 text-sm">
            <span className="font-medium">{resource.name}</span>{' '}
            <span className="text-muted-foreground">
              {resource.code} · {resourceTypeLabels[resource.resourceType]}
              {resource.capacity ? ` · ${resource.capacity} places` : ''}
            </span>
          </p>
        </>
      ) : (
        <div>
          <label className={labelClass} htmlFor="resourceId">
            Ressource à annoncer
          </label>
          <select id="resourceId" name="resourceId" required className={`${fieldClass} mt-1`}>
            {sansAnnonce.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.code} — {candidate.name} (
                {resourceTypeLabels[candidate.resourceType]})
              </option>
            ))}
          </select>
        </div>
      )}

      <div>
        <label className={labelClass} htmlFor="headline">
          Titre de l’annonce
        </label>
        <input
          id="headline"
          name="headline"
          required
          maxLength={120}
          defaultValue={listing?.headline ?? ''}
          placeholder="Salle de réunion 12 places, vue sur cour"
          className={`${fieldClass} mt-1`}
        />
      </div>

      <div>
        <label className={labelClass} htmlFor="description">
          Description
        </label>
        <textarea
          id="description"
          name="description"
          rows={5}
          defaultValue={listing?.description ?? ''}
          placeholder="Ce que le visiteur doit savoir avant de réserver."
          className={`${fieldClass} mt-1`}
        />
      </div>

      <div>
        <label className={labelClass} htmlFor="highlights">
          Points forts
        </label>
        <textarea
          id="highlights"
          name="highlights"
          rows={4}
          defaultValue={(listing?.highlights ?? []).join('\n')}
          placeholder={'Visioconférence\nTableau blanc\nCafé inclus'}
          aria-describedby="highlights-hint"
          className={`${fieldClass} mt-1`}
        />
        <p id="highlights-hint" className="mt-1 text-xs text-muted-foreground">
          Un par ligne, huit au maximum.
        </p>
      </div>

      <div>
        <label className={labelClass} htmlFor="slug">
          Adresse publique
        </label>
        <div className="mt-1 flex items-center gap-2">
          <span className="text-sm text-muted-foreground">/annonces/</span>
          <input
            id="slug"
            name="slug"
            defaultValue={listing?.slug ?? ''}
            placeholder="déduite du titre"
            aria-describedby="slug-hint"
            className={`${fieldClass} font-mono`}
          />
        </div>
        <p id="slug-hint" className="mt-1 text-xs text-muted-foreground">
          {listing
            ? 'La changer casse les liens déjà partagés et les résultats de recherche.'
            : 'Laisser vide pour la déduire du titre. Elle ne bougera plus ensuite.'}
        </p>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50"
        >
          {pending ? 'Enregistrement…' : 'Enregistrer'}
        </button>
        <Link
          href="/ressources/annonces"
          className="text-sm text-muted-foreground hover:underline"
        >
          Annuler
        </Link>
      </div>
      {!listing && (
        <p className="text-xs text-muted-foreground">
          L’annonce est enregistrée en brouillon. Elle n’apparaît sur le site public
          qu’une fois publiée.
        </p>
      )}
    </form>
  )
}
