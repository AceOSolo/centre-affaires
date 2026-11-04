'use client'

import { useActionState } from 'react'

import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import {
  createCategoryAction,
  renameCategoryAction,
  type CategoryFormState,
} from './categories-perso-actions.ts'
import { MAX_CUSTOM_CATEGORY_LENGTH } from './categories-perso-regles.ts'

const fieldClass =
  'mt-1 block min-h-11 w-full rounded-sm border border-border bg-white px-3 py-2 text-base outline-none focus:border-accent focus:ring-2 focus:ring-accent/40 aria-[invalid=true]:border-destructive sm:text-sm'
const primaryButton =
  'press inline-flex min-h-11 items-center justify-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary-hover disabled:opacity-50'
const secondaryButton =
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
 * Nouvelle catégorie personnelle (ADR 060). Mobile d'abord : champ et bouton
 * en pleine largeur au téléphone, 44 px de haut.
 */
export function CreateCategoryForm({
  accounts,
  limitReached,
}: {
  /** Entreprises du compte : le choix n'apparaît que s'il y en a plusieurs. */
  accounts: { clientId: string; clientName: string }[]
  limitReached: boolean
}) {
  const [state, formAction, pending] = useActionState<CategoryFormState, FormData>(createCategoryAction, null)
  const error = state?.fieldErrors?.nom

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <ErrorSummary errors={state?.fieldErrors} labels={{ nom: 'Nom de la catégorie' }} message={state?.error} />
      {accounts.length > 1 && (
        <div>
          <label htmlFor="entreprise" className="block text-sm font-medium">
            Pour l’entreprise
          </label>
          <select id="entreprise" name="entreprise" defaultValue={accounts[0]?.clientId} className={fieldClass}>
            {accounts.map((account) => (
              <option key={account.clientId} value={account.clientId}>
                {account.clientName}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex-1">
          <label htmlFor="nom" className="block text-sm font-medium">
            Nom de la catégorie
          </label>
          <input
            id="nom"
            name="nom"
            maxLength={MAX_CUSTOM_CATEGORY_LENGTH}
            autoComplete="off"
            disabled={limitReached}
            aria-invalid={error ? true : undefined}
            aria-describedby={`nom-hint${error ? ' nom-error' : ''}`}
            className={fieldClass}
          />
        </div>
        <button type="submit" disabled={pending || limitReached} className={primaryButton}>
          {pending ? 'Création…' : 'Créer la catégorie'}
        </button>
      </div>
      <p id="nom-hint" className="text-sm text-muted-foreground">
        {MAX_CUSTOM_CATEGORY_LENGTH} caractères au plus : « Comptable », « Contrats en cours »…
      </p>
      <FieldError id="nom-error" error={error} />
    </form>
  )
}

/** Renommer une catégorie : ses courriers y restent rangés. */
export function RenameCategoryForm({ id, name }: { id: string; name: string }) {
  const [state, formAction, pending] = useActionState<CategoryFormState, FormData>(renameCategoryAction, null)
  const field = `nom-${id}`
  const error = state?.fieldErrors?.[field]

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <ErrorSummary errors={state?.fieldErrors} labels={{ [field]: `Nouveau nom de « ${name} »` }} />
      <input type="hidden" name="id" value={id} />
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex-1">
          <label htmlFor={field} className="block text-sm font-medium">
            Nouveau nom
          </label>
          <input
            id={field}
            name="nom"
            defaultValue={name}
            maxLength={MAX_CUSTOM_CATEGORY_LENGTH}
            autoComplete="off"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${field}-error` : undefined}
            className={fieldClass}
          />
        </div>
        <button type="submit" disabled={pending} className={secondaryButton}>
          {pending ? 'Enregistrement…' : 'Renommer'}
        </button>
      </div>
      <FieldError id={`${field}-error`} error={error} />
    </form>
  )
}
