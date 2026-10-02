'use client'

import { useActionState, useRef, useState } from 'react'

import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import { publishTemplateAction, type InspectionFormState } from './actions.ts'
import type { EditorField } from './champs.ts'
import { fieldTypeLabels, fieldTypeOrder } from './labels.ts'
import {
  dangerSmallButton,
  errorClass,
  fieldClass,
  hintClass,
  labelClass,
  primaryButton,
  secondaryButton,
  smallButton,
} from './styles.ts'

type Row = EditorField & { key: number }

/**
 * Éditeur du modèle d'état des lieux d'un type de ressource (R06, ADR 039).
 *
 * Chaque publication qui change les champs crée une version ; les états des
 * lieux déjà saisis gardent la leur. Tout se fait au clavier : monter,
 * descendre, retirer un champ sont des boutons, et le focus suit le champ
 * déplacé. Le déplacement est annoncé aux lecteurs d'écran.
 */
export function TemplateEditor({
  resourceType,
  initialName,
  initialFields,
  published,
}: {
  resourceType: string
  initialName: string
  initialFields: EditorField[]
  /** Faux tant que le type n'a que son modèle de départ. */
  published: boolean
}) {
  const [state, formAction, pending] = useActionState<InspectionFormState, FormData>(
    publishTemplateAction,
    null,
  )
  const nextKey = useRef(initialFields.length)
  const [rows, setRows] = useState<Row[]>(() =>
    initialFields.map((field, index) => ({ ...field, key: index })),
  )
  // Contrôlé : React vide les champs non contrôlés après l'envoi, même refusé.
  const [name, setName] = useState(initialName)
  const [announcement, setAnnouncement] = useState('')
  const errors = state?.fieldErrors ?? {}

  const update = (key: number, patch: Partial<EditorField>) =>
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)))

  const focusLater = (id: string) =>
    requestAnimationFrame(() => document.getElementById(id)?.focus())

  function move(index: number, delta: -1 | 1) {
    const target = index + delta
    if (target < 0 || target >= rows.length) return
    const moved = rows[index]
    const next = [...rows]
    next.splice(index, 1)
    next.splice(target, 0, moved)
    setRows(next)
    setAnnouncement(
      `Champ « ${moved.label || 'sans libellé'} » déplacé en position ${target + 1} sur ${next.length}.`,
    )
    // Le focus reste sur le bouton actionné, dans la nouvelle position ; en
    // bout de liste, sur l'autre bouton de déplacement.
    const edge = (delta === -1 && target === 0) || (delta === 1 && target === next.length - 1)
    focusLater(`${edge ? (delta === -1 ? 'descendre' : 'monter') : delta === -1 ? 'monter' : 'descendre'}-${moved.key}`)
  }

  function remove(index: number) {
    const removed = rows[index]
    const next = rows.filter((_, position) => position !== index)
    setRows(next)
    setAnnouncement(`Champ « ${removed.label || 'sans libellé'} » retiré du modèle.`)
    focusLater(next.length > 0 ? `champ-${Math.min(index, next.length - 1)}` : 'ajouter-champ')
  }

  function add() {
    const key = nextKey.current++
    const position = rows.length
    setRows((current) => [
      ...current,
      { key, id: '', label: '', type: 'condition', required: false, unit: '', options: '', help: '' },
    ])
    setAnnouncement('Champ ajouté en fin de liste.')
    focusLater(`champ-${position}`)
  }

  const summaryLabels: Record<string, string> = { name: 'Nom du modèle' }
  rows.forEach((row, index) => {
    summaryLabels[`champ-${index}`] = `Champ ${index + 1}${row.label ? ` (${row.label})` : ''}`
  })
  const serialized = JSON.stringify(
    rows.map((row) => ({
      id: row.id,
      label: row.label,
      type: row.type,
      required: row.required,
      unit: row.unit,
      options: row.options,
      help: row.help,
    })),
  )

  return (
    <form action={formAction} className="flex flex-col gap-6">
      <input type="hidden" name="resourceType" value={resourceType} />
      <input type="hidden" name="fields" value={serialized} />

      <ErrorSummary errors={state?.fieldErrors} labels={summaryLabels} message={state?.error} />

      <div className="max-w-xl">
        <label className={labelClass} htmlFor="name">
          Nom du modèle
        </label>
        <input
          id="name"
          name="name"
          required
          maxLength={200}
          value={name}
          onChange={(event) => setName(event.target.value)}
          aria-invalid={errors.name ? true : undefined}
          aria-describedby={errors.name ? 'name-error' : undefined}
          className={`${fieldClass} mt-1`}
        />
        {errors.name && (
          <p id="name-error" className={errorClass}>
            {errors.name}
          </p>
        )}
      </div>

      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      <ol className="flex flex-col gap-4">
        {rows.map((row, index) => {
          const error = errors[`champ-${index}`]
          // Le résumé d'erreurs mène au libellé par `#champ-<rang>`.
          const labelId = `champ-${index}`
          return (
            <li key={row.key}>
              <fieldset
                className={`flex flex-col gap-4 rounded-lg border bg-white px-5 py-4 ${
                  error ? 'border-destructive' : 'border-border'
                }`}
              >
                <legend className="px-1 text-sm font-semibold tracking-tight">
                  Champ {index + 1}
                  {row.label && <span className="font-normal text-muted-foreground"> — {row.label}</span>}
                </legend>

                {error && (
                  <p id={`champ-${row.key}-error`} className="-mt-2 text-sm text-destructive">
                    {error}
                  </p>
                )}

                <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
                  <div>
                    <label className={labelClass} htmlFor={labelId}>
                      Libellé
                    </label>
                    <input
                      id={labelId}
                      value={row.label}
                      maxLength={200}
                      onChange={(event) => update(row.key, { label: event.target.value })}
                      aria-invalid={error ? true : undefined}
                      aria-describedby={`${labelId}-hint${error ? ` champ-${row.key}-error` : ''}`}
                      className={`${fieldClass} mt-1`}
                    />
                    <p id={`${labelId}-hint`} className={hintClass}>
                      {row.id
                        ? `Identifiant « ${row.id} » : il relie ce champ d’une version à l’autre, pour comparer une sortie à son entrée.`
                        : 'Identifiant attribué à la publication, à partir du libellé.'}
                    </p>
                  </div>
                  <div>
                    <label className={labelClass} htmlFor={`champ-type-${row.key}`}>
                      Type
                    </label>
                    <select
                      id={`champ-type-${row.key}`}
                      value={row.type}
                      onChange={(event) => update(row.key, { type: event.target.value })}
                      className={`${fieldClass} mt-1`}
                    >
                      {fieldTypeOrder.map((type) => (
                        <option key={type} value={type}>
                          {fieldTypeLabels[type]}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {row.type === 'number' && (
                  <div className="max-w-xs">
                    <label className={labelClass} htmlFor={`champ-unite-${row.key}`}>
                      Unité <span className="font-normal text-muted-foreground">(facultatif)</span>
                    </label>
                    <input
                      id={`champ-unite-${row.key}`}
                      value={row.unit}
                      maxLength={20}
                      onChange={(event) => update(row.key, { unit: event.target.value })}
                      aria-describedby={`champ-unite-${row.key}-hint`}
                      className={`${fieldClass} mt-1`}
                    />
                    <p id={`champ-unite-${row.key}-hint`} className={hintClass}>
                      Par exemple km, clés, kWh.
                    </p>
                  </div>
                )}

                {row.type === 'choice' && (
                  <div className="max-w-md">
                    <label className={labelClass} htmlFor={`champ-options-${row.key}`}>
                      Options
                    </label>
                    <textarea
                      id={`champ-options-${row.key}`}
                      value={row.options}
                      rows={4}
                      onChange={(event) => update(row.key, { options: event.target.value })}
                      aria-describedby={`champ-options-${row.key}-hint`}
                      className={`${fieldClass} mt-1`}
                    />
                    <p id={`champ-options-${row.key}-hint`} className={hintClass}>
                      Une option par ligne, de 2 à 50, dans l’ordre d’affichage.
                    </p>
                  </div>
                )}

                <div>
                  <label className={labelClass} htmlFor={`champ-aide-${row.key}`}>
                    Aide sous le champ <span className="font-normal text-muted-foreground">(facultatif)</span>
                  </label>
                  <input
                    id={`champ-aide-${row.key}`}
                    value={row.help}
                    maxLength={500}
                    onChange={(event) => update(row.key, { help: event.target.value })}
                    className={`${fieldClass} mt-1`}
                  />
                </div>

                <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                  <label className="inline-flex min-h-6 items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={row.required}
                      onChange={(event) => update(row.key, { required: event.target.checked })}
                      className="size-4 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                    />
                    Obligatoire pour clore l’état des lieux
                  </label>
                  <div className="ml-auto flex flex-wrap gap-2">
                    <button
                      id={`monter-${row.key}`}
                      type="button"
                      onClick={() => move(index, -1)}
                      disabled={index === 0}
                      aria-label={`Monter le champ ${index + 1}${row.label ? ` « ${row.label} »` : ''}`}
                      className={smallButton}
                    >
                      Monter
                    </button>
                    <button
                      id={`descendre-${row.key}`}
                      type="button"
                      onClick={() => move(index, 1)}
                      disabled={index === rows.length - 1}
                      aria-label={`Descendre le champ ${index + 1}${row.label ? ` « ${row.label} »` : ''}`}
                      className={smallButton}
                    >
                      Descendre
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(index)}
                      disabled={rows.length === 1}
                      aria-label={`Retirer le champ ${index + 1}${row.label ? ` « ${row.label} »` : ''}`}
                      className={dangerSmallButton}
                    >
                      Retirer
                    </button>
                  </div>
                </div>
              </fieldset>
            </li>
          )
        })}
      </ol>

      <div>
        <button id="ajouter-champ" type="button" onClick={add} className={secondaryButton}>
          Ajouter un champ
        </button>
      </div>

      <div className="flex flex-col gap-2 border-t border-border pt-4">
        <p className="text-sm text-muted-foreground">
          {published
            ? 'Publier crée une nouvelle version si les champs ont changé. Les états des lieux déjà saisis gardent la version avec laquelle ils l’ont été.'
            : 'Ce type n’a pas encore de modèle publié : ces champs sont le modèle de départ. Publier en fait la version 1.'}
        </p>
        <div>
          <button type="submit" disabled={pending} className={primaryButton}>
            {pending ? 'Publication…' : published ? 'Publier une nouvelle version' : 'Publier le modèle'}
          </button>
        </div>
      </div>
    </form>
  )
}
