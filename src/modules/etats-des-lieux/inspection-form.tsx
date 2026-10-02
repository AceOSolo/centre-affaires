'use client'

import { useActionState } from 'react'

import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import { saveInspectionAction, type InspectionFormState } from './actions.ts'
import { valueInputName } from './champs.ts'
import { conditionLevelLabels, conditionLevelOrder } from './labels.ts'
import { DraftPhotos, type DraftPhoto } from './photos-brouillon.tsx'
import type { InspectionField } from './schema.ts'
import { errorClass, fieldClass, hintClass, labelClass, primaryButton, secondaryButton } from './styles.ts'

/** Au-delà, une liste de boutons radio devient une liste déroulante. */
const RADIO_LIMIT = 6

/**
 * Saisie d'un état des lieux en brouillon : un formulaire généré depuis la
 * version de son modèle (R06, ADR 039). Chaque champ porte ses photos.
 *
 * Deux envois : « Enregistrer » garde le brouillon ; « Clore » l'enregistre
 * et le fige, après confirmation. La validation de la saisie se fait au
 * serveur, selon le modèle (`champs.ts`), puis par la base.
 */
export function InspectionForm({
  inspectionId,
  fields,
  initialValues,
  performedAt,
  observations,
  photos,
  photoBase,
}: {
  inspectionId: string
  fields: InspectionField[]
  /** Valeurs enregistrées, au format des contrôles (`valueToInput`). */
  initialValues: Record<string, string>
  /** Heure murale du centre, au format `datetime-local`. */
  performedAt: string
  observations: string
  photos: (DraftPhoto & { fieldId: string | null })[]
  photoBase: string
}) {
  const [state, formAction, pending] = useActionState<InspectionFormState, FormData>(
    saveInspectionAction,
    null,
  )
  const errors = state?.fieldErrors ?? {}
  const value = (name: string) => state?.values?.[name] ?? initialValues[name] ?? ''

  const labels: Record<string, string> = {
    performedAt: 'Date de l’état des lieux',
    observations: 'Observations',
    confirmClose: 'Confirmation de la clôture',
  }
  for (const field of fields) labels[valueInputName(field.id)] = field.label

  const generalPhotos = photos.filter((photo) => photo.fieldId === null)

  return (
    <form action={formAction} className="flex flex-col gap-6">
      <input type="hidden" name="id" value={inspectionId} />
      <ErrorSummary errors={state?.fieldErrors} labels={labels} message={state?.error} />

      <div className="max-w-xs">
        <label className={labelClass} htmlFor="performedAt">
          Date et heure
        </label>
        <input
          id="performedAt"
          name="performedAt"
          type="datetime-local"
          required
          defaultValue={value('performedAt') || performedAt}
          aria-invalid={errors.performedAt ? true : undefined}
          aria-describedby={errors.performedAt ? 'performedAt-error' : undefined}
          className={`${fieldClass} mt-1 tabular`}
        />
        <FieldError id="performedAt" error={errors.performedAt} />
      </div>

      <ol className="flex flex-col gap-4">
        {fields.map((field) => {
          const name = valueInputName(field.id)
          return (
            <li key={field.id} className="flex flex-col gap-3 rounded-lg border border-border bg-white px-5 py-4">
              <FieldInput field={field} name={name} value={value(name)} error={errors[name]} />
              <DraftPhotos
                inspectionId={inspectionId}
                fieldId={field.id}
                subject={field.label}
                photos={photos.filter((photo) => photo.fieldId === field.id)}
                photoBase={photoBase}
              />
            </li>
          )
        })}
      </ol>

      <div>
        <label className={labelClass} htmlFor="observations">
          Observations <span className="font-normal text-muted-foreground">(facultatif)</span>
        </label>
        <textarea
          id="observations"
          name="observations"
          rows={4}
          maxLength={10_000}
          defaultValue={state?.values?.observations ?? observations}
          aria-invalid={errors.observations ? true : undefined}
          aria-describedby={`observations-hint${errors.observations ? ' observations-error' : ''}`}
          className={`${fieldClass} mt-1`}
        />
        <p id="observations-hint" className={hintClass}>
          Ce que les champs ne disent pas : réserves, travaux convenus, objets laissés sur place.
        </p>
        <FieldError id="observations" error={errors.observations} />
      </div>

      <section aria-labelledby="photos-ensemble" className="flex flex-col gap-3 rounded-lg border border-border bg-white px-5 py-4">
        <h2 id="photos-ensemble" className="text-sm font-semibold tracking-tight">
          Photos d’ensemble
        </h2>
        <p className="-mt-2 text-xs text-muted-foreground">
          Vues générales, compteur, clés. Les photos sont réduites et recompressées sur cet appareil
          avant l’envoi, puis chiffrées par le centre.
        </p>
        <DraftPhotos
          inspectionId={inspectionId}
          fieldId={null}
          subject="vue d’ensemble"
          photos={generalPhotos}
          photoBase={photoBase}
        />
      </section>

      <div className="flex flex-col gap-4 border-t border-border pt-4">
        <div>
          <button type="submit" name="intent" value="save" disabled={pending} className={secondaryButton}>
            {pending ? 'Enregistrement…' : 'Enregistrer le brouillon'}
          </button>
        </div>

        <fieldset className="flex flex-col gap-3 rounded-lg border border-primary/30 bg-white px-5 py-4">
          <legend className="px-1 text-sm font-semibold tracking-tight">Clore l’état des lieux</legend>
          <p className="text-sm text-muted-foreground">
            La clôture enregistre la saisie et la fige : ni les valeurs, ni les photos, ni la date ne
            changeront plus. Le client le consulte alors dans son espace et le valide. Chaque champ
            obligatoire doit être renseigné.
          </p>
          <label className="inline-flex min-h-6 items-start gap-2 text-sm">
            <input
              id="confirmClose"
              name="confirmClose"
              type="checkbox"
              aria-invalid={errors.confirmClose ? true : undefined}
              aria-describedby={errors.confirmClose ? 'confirmClose-error' : undefined}
              className="mt-0.5 size-4 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            />
            Je confirme que l’état des lieux est terminé et peut être figé.
          </label>
          <FieldError id="confirmClose" error={errors.confirmClose} />
          <div>
            <button type="submit" name="intent" value="close" disabled={pending} className={primaryButton}>
              {pending ? 'Enregistrement…' : 'Enregistrer et clore'}
            </button>
          </div>
        </fieldset>
      </div>
    </form>
  )
}

function FieldError({ id, error }: { id: string; error?: string }) {
  if (!error) return null
  return (
    <p id={`${id}-error`} className={errorClass}>
      {error}
    </p>
  )
}

/** Le contrôle d'un champ, selon son type. Libellé toujours visible. */
function FieldInput({
  field,
  name,
  value,
  error,
}: {
  field: InspectionField
  name: string
  value: string
  error?: string
}) {
  const describedBy = [field.help ? `${name}-hint` : null, error ? `${name}-error` : null]
    .filter(Boolean)
    .join(' ') || undefined
  const required = field.required ? (
    <span className="font-normal text-muted-foreground"> (obligatoire pour clore)</span>
  ) : null
  const help = field.help ? (
    <p id={`${name}-hint`} className={hintClass}>
      {field.help}
    </p>
  ) : null

  if (field.type === 'condition' || field.type === 'checkbox' || (field.type === 'choice' && (field.options?.length ?? 0) <= RADIO_LIMIT)) {
    const options: { value: string; label: string }[] =
      field.type === 'condition'
        ? conditionLevelOrder.map((level) => ({ value: level, label: conditionLevelLabels[level] }))
        : field.type === 'checkbox'
          ? [
              { value: 'oui', label: 'Oui' },
              { value: 'non', label: 'Non' },
            ]
          : (field.options ?? []).map((option) => ({ value: option, label: option }))
    return (
      <fieldset aria-describedby={describedBy}>
        <legend className={labelClass}>
          {field.label}
          {required}
        </legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {options.map((option, index) => (
            <label
              key={option.value}
              className="inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-md border border-border bg-white px-3 text-sm has-[:checked]:border-primary has-[:checked]:bg-primary/5 has-[:checked]:font-medium has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent"
            >
              <input
                // Le premier bouton porte l'identifiant du champ : le résumé d'erreurs y mène.
                id={index === 0 ? name : `${name}-${index}`}
                type="radio"
                name={name}
                value={option.value}
                defaultChecked={value === option.value}
                className="size-4 accent-primary"
              />
              {option.label}
            </label>
          ))}
          {!field.required && (
            <label className="inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-md border border-dashed border-border bg-white px-3 text-sm text-muted-foreground has-[:checked]:border-primary has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent">
              <input type="radio" name={name} value="" defaultChecked={value === ''} className="size-4 accent-primary" />
              Non renseigné
            </label>
          )}
        </div>
        {help}
        <FieldError id={name} error={error} />
      </fieldset>
    )
  }

  return (
    <div>
      <label className={labelClass} htmlFor={name}>
        {field.label}
        {field.type === 'number' && field.unit ? ` (${field.unit})` : ''}
        {required}
      </label>
      {field.type === 'text' ? (
        <textarea
          id={name}
          name={name}
          rows={3}
          maxLength={5000}
          defaultValue={value}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={`${fieldClass} mt-1`}
        />
      ) : field.type === 'choice' ? (
        <select
          id={name}
          name={name}
          defaultValue={value}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={`${fieldClass} mt-1 max-w-md`}
        >
          <option value="">Non renseigné</option>
          {(field.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={name}
          name={name}
          inputMode="decimal"
          autoComplete="off"
          defaultValue={value}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={`${fieldClass} mt-1 max-w-xs tabular`}
        />
      )}
      {help}
      <FieldError id={name} error={error} />
    </div>
  )
}
