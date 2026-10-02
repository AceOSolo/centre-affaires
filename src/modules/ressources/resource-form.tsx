'use client'

import { useActionState, useState } from 'react'

import Link from 'next/link'

import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import { createResourceAction, updateResourceAction, type FormState } from './actions.ts'
import {
  attributeFields,
  attributeFormValue,
  hasCapacity,
  resourceFieldLabels,
  type AttributeField,
} from './attributs.ts'
import { resourceStatusLabels, resourceTypeLabels } from './labels.ts'
import { resourceStatuses, resourceTypes, type Resource, type ResourceType } from './schema.ts'

const fieldClass =
  'w-full rounded-sm border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/40 aria-[invalid=true]:border-destructive'
const labelClass = 'block text-sm font-medium text-foreground'

/**
 * Formulaire d'une ressource, en création comme en modification (R01) : les
 * deux ont les mêmes champs et les mêmes règles, les séparer les ferait
 * diverger.
 *
 * Les champs propres au type viennent de `attributeFields`, la description qui
 * sert aussi à la validation côté serveur : c'est la contrepartie à l'écran de
 * la table unique et de sa colonne `attributes` (décision 2).
 *
 * En modification, le type est affiché et non modifiable : une salle ne devient
 * pas un casier, on archive et on déclare.
 */
export function ResourceForm({ resource }: { resource?: Resource }) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    resource ? updateResourceAction : createResourceAction,
    null,
  )
  const values = state?.values

  return (
    // Remonté après un échec pour reprendre la saisie : React réinitialise le
    // formulaire à la fin de chaque envoi.
    <ResourceFields
      key={JSON.stringify(values ?? {})}
      resource={resource}
      state={state}
      formAction={formAction}
      pending={pending}
    />
  )
}

function ResourceFields({
  resource,
  state,
  formAction,
  pending,
}: {
  resource?: Resource
  state: FormState
  formAction: (formData: FormData) => void
  pending: boolean
}) {
  const values = state?.values
  const errors = state?.fieldErrors ?? {}
  const initialType = (resource?.resourceType ??
    resourceTypes.find((type) => type === values?.resourceType) ??
    'salle') as ResourceType
  const [resourceType, setResourceType] = useState<ResourceType>(initialType)
  const attributes = (resource?.attributes ?? {}) as Record<string, unknown>

  /** Valeur réaffichée : la saisie refusée d'abord, la ressource ensuite. */
  const value = (name: string, stored?: unknown) =>
    values?.[name] ?? attributeFormValue(stored)

  const statuses = resource ? resourceStatuses : (['active', 'maintenance'] as const)

  return (
    <form action={formAction} className="flex max-w-2xl flex-col gap-5">
      {resource && <input type="hidden" name="id" value={resource.id} />}

      <ErrorSummary errors={state?.fieldErrors} labels={resourceFieldLabels} message={state?.error} />

      <div className="grid gap-5 sm:grid-cols-2">
        {resource ? (
          <div>
            <p className={labelClass}>Type</p>
            <p className="mt-1 rounded-sm border border-border bg-muted px-3 py-2 text-sm">
              {resourceTypeLabels[resource.resourceType]}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Non modifiable : archivez et déclarez une autre ressource.
            </p>
          </div>
        ) : (
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
        )}

        <TextField
          name="code"
          label="Code interne"
          required
          placeholder="S-101"
          hint="Unique dans le centre, réutilisable après archivage."
          defaultValue={value('code', resource?.code)}
          error={errors.code}
          maxLength={30}
        />

        <div className="sm:col-span-2">
          <TextField
            name="name"
            label="Nom"
            required
            placeholder="Salle Europe"
            defaultValue={value('name', resource?.name)}
            error={errors.name}
            maxLength={120}
          />
        </div>

        {hasCapacity(resourceType) && (
          <TextField
            name="capacity"
            label="Capacité (personnes)"
            inputMode="numeric"
            optional
            defaultValue={value('capacity', resource?.capacity)}
            error={errors.capacity}
          />
        )}

        <div>
          <label className={labelClass} htmlFor="status">
            État
          </label>
          <select
            id="status"
            name="status"
            defaultValue={values?.status ?? resource?.status ?? 'active'}
            aria-invalid={errors.status ? true : undefined}
            aria-describedby={errors.status ? 'status-error' : undefined}
            className={`${fieldClass} mt-1`}
          >
            {statuses.map((status) => (
              <option key={status} value={status}>
                {resourceStatusLabels[status]}
              </option>
            ))}
          </select>
          <FieldError name="status" error={errors.status} />
        </div>
      </div>

      {attributeFields[resourceType].length > 0 && (
        <fieldset className="flex flex-col gap-5 rounded-lg border border-border bg-white px-5 py-4">
          <legend className="px-1 text-sm font-semibold tracking-tight">
            Caractéristiques — {resourceTypeLabels[resourceType].toLocaleLowerCase('fr-FR')}
          </legend>
          <div className="grid gap-5 sm:grid-cols-2">
            {attributeFields[resourceType].map((field) => (
              <AttributeInput
                key={field.name}
                field={field}
                defaultValue={value(field.name, attributes[field.name])}
                error={errors[field.name]}
              />
            ))}
          </div>
        </fieldset>
      )}

      <div>
        <label className={labelClass} htmlFor="description">
          Description <span className="font-normal text-muted-foreground">(facultatif)</span>
        </label>
        <textarea
          id="description"
          name="description"
          rows={3}
          maxLength={2000}
          defaultValue={value('description', resource?.description)}
          aria-invalid={errors.description ? true : undefined}
          aria-describedby={errors.description ? 'description-error' : undefined}
          className={`${fieldClass} mt-1`}
        />
        <FieldError name="description" error={errors.description} />
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white transition-colors duration-150 ease-out hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
        >
          {pending ? 'Enregistrement…' : resource ? 'Enregistrer' : 'Créer la ressource'}
        </button>
        <Link
          href={resource ? `/ressources/${resource.id}` : '/ressources'}
          className="text-sm text-muted-foreground hover:underline"
        >
          Annuler
        </Link>
        {/* Région annoncée présente dès le premier rendu : l'état d'envoi est
            lu par les lecteurs d'écran, pas seulement vu. */}
        <p aria-live="polite" className="sr-only">
          {pending ? 'Enregistrement en cours.' : ''}
        </p>
      </div>
    </form>
  )
}

/** Un champ propre au type, monté d'après sa description. */
function AttributeInput({
  field,
  defaultValue,
  error,
}: {
  field: AttributeField
  defaultValue: string
  error?: string
}) {
  if (field.kind === 'choice') {
    return (
      <div>
        <label className={labelClass} htmlFor={field.name}>
          {field.label}{' '}
          {!field.required && <span className="font-normal text-muted-foreground">(facultatif)</span>}
        </label>
        <select
          id={field.name}
          name={field.name}
          defaultValue={defaultValue}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${field.name}-error` : undefined}
          className={`${fieldClass} mt-1`}
        >
          {!field.required && <option value="">Non précisée</option>}
          {field.choices?.map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
        </select>
        <FieldError name={field.name} error={error} />
      </div>
    )
  }

  const numeric = field.kind === 'integer' || field.kind === 'decimal'
  return (
    <div className={field.kind === 'list' ? 'sm:col-span-2' : undefined}>
      <TextField
        name={field.name}
        label={field.label}
        required={field.required}
        optional={!field.required}
        hint={field.hint}
        placeholder={field.placeholder}
        inputMode={field.kind === 'integer' ? 'numeric' : field.kind === 'decimal' ? 'decimal' : undefined}
        className={numeric ? 'tabular' : undefined}
        defaultValue={defaultValue}
        error={error}
      />
    </div>
  )
}

function TextField({
  name,
  label,
  hint,
  error,
  optional,
  className = '',
  ...props
}: {
  name: string
  label: string
  hint?: string
  error?: string
  /** Affiche « (facultatif) » à côté du libellé. */
  optional?: boolean
} & React.InputHTMLAttributes<HTMLInputElement>) {
  const describedBy = [hint && `${name}-hint`, error && `${name}-error`].filter(Boolean).join(' ')
  return (
    <div>
      {/* Le libellé est visible, jamais remplacé par un placeholder. */}
      <label className={labelClass} htmlFor={name}>
        {label}{' '}
        {optional && <span className="font-normal text-muted-foreground">(facultatif)</span>}
      </label>
      <input
        id={name}
        name={name}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        className={`${fieldClass} mt-1 ${className}`}
        {...props}
      />
      {hint && (
        <p id={`${name}-hint`} className="mt-1 text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      <FieldError name={name} error={error} />
    </div>
  )
}

function FieldError({ name, error }: { name: string; error?: string }) {
  if (!error) return null
  return (
    <p id={`${name}-error`} className="mt-1 text-xs text-destructive">
      {error}
    </p>
  )
}
