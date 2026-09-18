'use client'

import { useActionState, useState } from 'react'

import Link from 'next/link'

import { createResourceAction, type FormState } from './actions.ts'
import { resourceTypeLabels } from './labels.ts'
import { resourceTypes, type ResourceType } from './schema.ts'

const fieldClass =
  'w-full rounded-sm border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/40'
const labelClass = 'block text-sm font-medium text-foreground'

/**
 * Formulaire de déclaration d'une ressource.
 *
 * Les champs propres au type sont montés selon le type choisi : c'est la
 * contrepartie côté écran de la table unique et de sa colonne `attributes`
 * (décision 2).
 */
export function ResourceForm() {
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    createResourceAction,
    null,
  )
  const [resourceType, setResourceType] = useState<ResourceType>('salle')

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

      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label className={labelClass} htmlFor="resourceType">
            Type
          </label>
          <select
            id="resourceType"
            name="resourceType"
            className={`${fieldClass} mt-1`}
            value={resourceType}
            onChange={(event) => setResourceType(event.target.value as ResourceType)}
          >
            {resourceTypes.map((type) => (
              <option key={type} value={type}>
                {resourceTypeLabels[type]}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className={labelClass} htmlFor="code">
            Code interne
          </label>
          <input
            id="code"
            name="code"
            required
            placeholder="S-101"
            className={`${fieldClass} mt-1 font-mono`}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Unique dans le centre, réutilisable après archivage.
          </p>
        </div>

        <div className="sm:col-span-2">
          <label className={labelClass} htmlFor="name">
            Nom
          </label>
          <input
            id="name"
            name="name"
            required
            placeholder="Salle Europe"
            className={`${fieldClass} mt-1`}
          />
        </div>

        <div>
          <label className={labelClass} htmlFor="capacity">
            Capacité (personnes)
          </label>
          <input id="capacity" name="capacity" type="number" min="0" className={`${fieldClass} mt-1`} />
        </div>

        <div>
          <label className={labelClass} htmlFor="status">
            État
          </label>
          <select id="status" name="status" defaultValue="active" className={`${fieldClass} mt-1`}>
            <option value="active">En service</option>
            <option value="maintenance">En maintenance</option>
          </select>
        </div>

        <TypeFields resourceType={resourceType} />

        <div className="sm:col-span-2">
          <label className={labelClass} htmlFor="description">
            Description
          </label>
          <textarea id="description" name="description" rows={3} className={`${fieldClass} mt-1`} />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50"
        >
          {pending ? 'Enregistrement…' : 'Créer la ressource'}
        </button>
        <Link href="/ressources" className="text-sm text-muted-foreground hover:underline">
          Annuler
        </Link>
      </div>
    </form>
  )
}

/** Champs qui n'existent que pour certains types, stockés en JSONB. */
function TypeFields({ resourceType }: { resourceType: ResourceType }) {
  switch (resourceType) {
    case 'salle':
      return (
        <>
          <NumberField name="superficieM2" label="Superficie (m²)" />
          <TextField name="equipements" label="Équipements" placeholder="visio, tableau, écran" hint="Séparés par des virgules." />
        </>
      )
    case 'bureau':
      return (
        <>
          <NumberField name="superficieM2" label="Superficie (m²)" />
          <NumberField name="postes" label="Postes de travail" />
        </>
      )
    case 'casier':
      return (
        <div>
          <label className={labelClass} htmlFor="taille">
            Taille
          </label>
          <select id="taille" name="taille" defaultValue="M" className={`${fieldClass} mt-1`}>
            <option value="S">S</option>
            <option value="M">M</option>
            <option value="L">L</option>
          </select>
        </div>
      )
    case 'vehicule':
      return (
        <>
          <TextField name="immatriculation" label="Immatriculation" placeholder="AB-123-CD" />
          <NumberField name="kilometrage" label="Kilométrage" />
          <NumberField name="places" label="Places" />
        </>
      )
    case 'boite_aux_lettres':
      return null
  }
}

function TextField({
  name,
  label,
  placeholder,
  hint,
}: {
  name: string
  label: string
  placeholder?: string
  hint?: string
}) {
  return (
    <div>
      <label className={labelClass} htmlFor={name}>
        {label}
      </label>
      <input id={name} name={name} placeholder={placeholder} className={`${fieldClass} mt-1`} />
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

function NumberField({ name, label }: { name: string; label: string }) {
  return (
    <div>
      <label className={labelClass} htmlFor={name}>
        {label}
      </label>
      <input id={name} name={name} type="number" min="0" className={`${fieldClass} mt-1`} />
    </div>
  )
}
