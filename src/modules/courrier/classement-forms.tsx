'use client'

import { useActionState } from 'react'

import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import {
  classifySelectionAction,
  saveClassificationAction,
  type ClassificationFormState,
} from './classement-actions.ts'
import { MAX_TAG_LENGTH, MAX_TAGS, type MailClassification } from './classement-regles.ts'
import { mailCategoryLabels } from './labels.ts'
import type { MailCategory } from './categories.ts'

/** Identifiant du formulaire de sélection : les cases des cartes s'y rattachent (`form=`). */
export const SELECTION_FORM_ID = 'selection-courrier'

const categories = Object.keys(mailCategoryLabels) as MailCategory[]

const fieldClass =
  'mt-1 block min-h-11 w-full rounded-sm border border-border bg-white px-3 py-2 text-base outline-none focus:border-accent focus:ring-2 focus:ring-accent/40 aria-[invalid=true]:border-destructive sm:text-sm'
const buttonClass =
  'press inline-flex min-h-11 items-center justify-center rounded-md border border-border bg-white px-4 text-sm font-medium text-primary hover:bg-muted disabled:opacity-50'

function FieldError({ id, error }: { id: string; error?: string }) {
  if (!error) return null
  return (
    <p id={id} role="alert" className="mt-1 text-sm text-destructive">
      {error}
    </p>
  )
}

/**
 * Barre d'actions sur les courriers cochés (ADR 044) : lu, traité, catégorie,
 * étiquette — un geste répété ligne à ligne se fait sur une sélection
 * (`CLAUDE.md`). Les cases sont dans les cartes, rattachées à ce formulaire.
 */
export function SelectionBar({ returnQuery, knownTags }: { returnQuery: string; knownTags: string[] }) {
  const [state, formAction, pending] = useActionState<ClassificationFormState, FormData>(
    classifySelectionAction,
    null,
  )
  const errors = state?.fieldErrors ?? {}

  const toggleAll = (checked: boolean) => {
    document
      .querySelectorAll<HTMLInputElement>(`input[type="checkbox"][name="ids"][form="${SELECTION_FORM_ID}"]`)
      .forEach((box) => {
        box.checked = checked
      })
  }

  return (
    <form
      id={SELECTION_FORM_ID}
      action={formAction}
      aria-label="Actions sur les courriers cochés"
      className="flex flex-col gap-3 rounded-lg border border-border bg-white p-4"
    >
      <input type="hidden" name="retour" value={returnQuery} />
      <ErrorSummary
        errors={state?.fieldErrors}
        labels={{ 'selection-categorie': 'Catégorie', 'selection-etiquette': 'Étiquette' }}
        message={state?.error}
      />
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">Pour les courriers cochés :</span>
        <button type="button" onClick={() => toggleAll(true)} className={buttonClass}>
          Tout cocher
        </button>
        <button type="button" onClick={() => toggleAll(false)} className={buttonClass}>
          Tout décocher
        </button>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="submit" name="action" value="lu" disabled={pending} className={buttonClass}>
          Marquer lu
        </button>
        <button type="submit" name="action" value="non-lu" disabled={pending} className={buttonClass}>
          Marquer non lu
        </button>
        <button type="submit" name="action" value="traite" disabled={pending} className={buttonClass}>
          Marquer traité
        </button>
        <button type="submit" name="action" value="a-traiter" disabled={pending} className={buttonClass}>
          Remettre à traiter
        </button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1">
            <label htmlFor="selection-categorie" className="block text-sm font-medium">
              Catégorie
            </label>
            <select
              id="selection-categorie"
              name="categorie"
              defaultValue=""
              aria-invalid={errors['selection-categorie'] ? true : undefined}
              aria-describedby={errors['selection-categorie'] ? 'selection-categorie-error' : undefined}
              className={fieldClass}
            >
              <option value="" disabled>
                Choisir…
              </option>
              {categories.map((category) => (
                <option key={category} value={category}>
                  {mailCategoryLabels[category]}
                </option>
              ))}
              <option value="non-classe">Non classé</option>
            </select>
          </div>
          <button type="submit" name="action" value="classer" disabled={pending} className={buttonClass}>
            Classer
          </button>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1">
            <label htmlFor="selection-etiquette" className="block text-sm font-medium">
              Étiquette
            </label>
            <input
              id="selection-etiquette"
              name="etiquette"
              list="etiquettes-connues"
              maxLength={MAX_TAG_LENGTH}
              autoComplete="off"
              aria-invalid={errors['selection-etiquette'] ? true : undefined}
              aria-describedby={errors['selection-etiquette'] ? 'selection-etiquette-error' : undefined}
              className={fieldClass}
            />
            <datalist id="etiquettes-connues">
              {knownTags.map((tag) => (
                <option key={tag} value={tag} />
              ))}
            </datalist>
          </div>
          <button type="submit" name="action" value="etiqueter" disabled={pending} className={buttonClass}>
            Ajouter l’étiquette
          </button>
        </div>
        <FieldError id="selection-categorie-error" error={errors['selection-categorie']} />
        <FieldError id="selection-etiquette-error" error={errors['selection-etiquette']} />
      </div>
      {pending && (
        <p role="status" className="text-sm text-muted-foreground">
          Enregistrement…
        </p>
      )}
    </form>
  )
}

/** Mon classement d'un pli : catégorie, étiquettes, traité ou non. */
export function ClassificationForm({
  mailItemId,
  classification,
  knownTags,
}: {
  mailItemId: string
  classification: MailClassification
  knownTags: string[]
}) {
  const [state, formAction, pending] = useActionState<ClassificationFormState, FormData>(
    saveClassificationAction,
    null,
  )
  const errors = state?.fieldErrors ?? {}

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="id" value={mailItemId} />
      <ErrorSummary
        errors={state?.fieldErrors}
        labels={{ categorie: 'Catégorie', etiquettes: 'Étiquettes' }}
        message={state?.error}
      />
      <div>
        <label htmlFor="categorie" className="block text-sm font-medium">
          Catégorie
        </label>
        <select
          id="categorie"
          name="categorie"
          defaultValue={classification.category ?? ''}
          aria-invalid={errors.categorie ? true : undefined}
          aria-describedby={errors.categorie ? 'categorie-error' : undefined}
          className={fieldClass}
        >
          <option value="">Non classé</option>
          {categories.map((category) => (
            <option key={category} value={category}>
              {mailCategoryLabels[category]}
            </option>
          ))}
        </select>
        <FieldError id="categorie-error" error={errors.categorie} />
      </div>
      <div>
        <label htmlFor="etiquettes" className="block text-sm font-medium">
          Étiquettes <span className="font-normal text-muted-foreground">(facultatif)</span>
        </label>
        <input
          id="etiquettes"
          name="etiquettes"
          list="etiquettes-fiche"
          defaultValue={classification.tags.join(', ')}
          autoComplete="off"
          aria-invalid={errors.etiquettes ? true : undefined}
          aria-describedby={`etiquettes-hint${errors.etiquettes ? ' etiquettes-error' : ''}`}
          className={fieldClass}
        />
        <datalist id="etiquettes-fiche">
          {knownTags.map((tag) => (
            <option key={tag} value={tag} />
          ))}
        </datalist>
        <p id="etiquettes-hint" className="mt-1 text-sm text-muted-foreground">
          Séparées par des virgules : « à payer, comptable ». {MAX_TAGS} au plus, visibles de vous seul.
        </p>
        <FieldError id="etiquettes-error" error={errors.etiquettes} />
      </div>
      <div className="flex min-h-11 items-center gap-3">
        <input
          id="traite"
          name="traite"
          type="checkbox"
          defaultChecked={classification.handledAt !== null}
          className="size-5"
        />
        <label htmlFor="traite" className="text-sm font-medium">
          Traité
        </label>
      </div>
      <div>
        <button
          type="submit"
          disabled={pending}
          className="press inline-flex min-h-11 items-center justify-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary-hover disabled:opacity-50"
        >
          {pending ? 'Enregistrement…' : 'Enregistrer mon classement'}
        </button>
      </div>
    </form>
  )
}
