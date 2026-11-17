'use client'

import { useActionState, useEffect } from 'react'

import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import { RequiredMark, RequiredNotice } from './champs-obligatoires.tsx'
import { MAX_CUSTOM_CATEGORY_LENGTH } from './categories-perso-regles.ts'
import { ArrowDownIcon, ArrowUpIcon, EyeOffIcon } from './icones-client.tsx'

/**
 * Éditeur d'une liste de catégories (ADR 078) : renommer, masquer, ordonner.
 * Le même pour la personne de l'espace client (catégories proposées et les
 * siennes) et pour le centre (catégories proposées, dans Réglages).
 *
 * Un seul formulaire, qui marche sans script : chaque ligne envoie son nom,
 * sa case « Masquer » et sa place ; « Monter » et « Descendre » enregistrent
 * la liste en déplaçant la ligne. Après un déplacement, le focus revient au
 * bouton pressé, à sa nouvelle place, et le résultat est annoncé.
 */
export type CategoryListState = {
  error?: string
  fieldErrors?: Record<string, string>
  /** Saisies rendues au formulaire après un échec : React le réinitialise après l'envoi. */
  values?: Record<string, string>
  /** Confirmation, annoncée dans la zone d'état. */
  done?: string
  /** `id` du bouton à refocaliser après un déplacement. */
  focus?: string
} | null

export type CategoryListRow = {
  key: string
  kind: 'proposee' | 'perso'
  name: string
  /** Nom proposé par le centre ou par le code, que « Rétablir » remet. */
  originName: string | null
  hidden: boolean
  /** Courriers rangés dans la catégorie, pour la personne ; absent côté centre. */
  count?: number
  /** Lien de suppression d'une catégorie personnelle. */
  deleteHref?: string
}

const fieldClass =
  'mt-1 block min-h-11 w-full rounded-sm border border-border bg-white px-3 py-2 text-base outline-none focus:border-accent focus:ring-2 focus:ring-accent/40 aria-[invalid=true]:border-destructive sm:text-sm'
const smallButton =
  'press inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md border border-border bg-white px-3 text-sm font-medium text-primary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40'
const primaryButton =
  'press inline-flex min-h-11 w-full items-center justify-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary-hover disabled:opacity-50 sm:w-auto'

const plural = (count: number, word: string) => `${count} ${word}${count > 1 ? 's' : ''}`

export function CategoryListForm({
  action,
  rows,
  hiddenFields = {},
  submitLabel,
  audience,
  idPrefix = '',
}: {
  action: (previous: CategoryListState, formData: FormData) => Promise<CategoryListState>
  rows: readonly CategoryListRow[]
  /** Champs cachés propres à l'écran : l'entreprise, côté client. */
  hiddenFields?: Record<string, string>
  submitLabel: string
  /** Qui règle : le texte de l'aide en dépend. */
  audience: 'client' | 'centre'
  /** Préfixe des `id` : une liste par entreprise sur la même page. */
  idPrefix?: string
}) {
  const [state, formAction, pending] = useActionState<CategoryListState, FormData>(action, null)
  const errors = state?.fieldErrors ?? {}
  const values = state?.values
  const id = (name: string) => `${idPrefix}${name}`

  useEffect(() => {
    if (!state?.focus) return
    const target = document.getElementById(`${idPrefix}${state.focus}`) as HTMLButtonElement | null
    // Arrivé en bout de liste, le bouton pressé est désactivé : l'autre sens prend le focus.
    if (target && !target.disabled) target.focus()
    else {
      const other = state.focus.replace(/-(haut|bas)$/, (_, way) => (way === 'haut' ? '-bas' : '-haut'))
      document.getElementById(`${idPrefix}${other}`)?.focus()
    }
  }, [state, idPrefix])

  // Les erreurs portent le nom du champ ; le résumé mène à son `id`, préfixé.
  const labels = Object.fromEntries(rows.map((row) => [id(`nom-${row.key}`), `Nom de « ${row.name} »`]))
  const summaryErrors = state?.fieldErrors
    ? Object.fromEntries(Object.entries(state.fieldErrors).map(([name, error]) => [id(name), error]))
    : undefined

  return (
    <form key={JSON.stringify(values ?? {})} action={formAction} className="flex flex-col gap-4">
      {/* Bouton par défaut : la touche Entrée dans un champ enregistre, sans déplacer. */}
      <button type="submit" className="hidden" tabIndex={-1} aria-hidden="true">
        {submitLabel}
      </button>
      {Object.entries(hiddenFields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <ErrorSummary errors={summaryErrors} labels={labels} message={state?.error} />
      <RequiredNotice />
      <ol className="flex flex-col gap-3">
        {rows.map((row, index) => {
          const nameField = `nom-${row.key}`
          const error = errors[nameField]
          const name = values?.[nameField] ?? row.name
          const hidden = values ? values[`masquee-${row.key}`] === 'on' : row.hidden
          const renamed = row.originName !== null && row.name !== row.originName
          return (
            <li key={row.key} className="flex flex-col gap-2 rounded-lg border border-border bg-white p-3 sm:p-4">
              <input type="hidden" name="ordre" value={row.key} />
              {row.originName !== null && <input type="hidden" name={`origine-${row.key}`} value={row.originName} />}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label htmlFor={id(nameField)} className="text-sm font-medium">
                  <span className="tabular text-muted-foreground">{index + 1}. </span>
                  {row.kind === 'perso'
                    ? 'Ma catégorie'
                    : audience === 'client'
                      ? 'Catégorie proposée par le centre'
                      : 'Catégorie proposée'}
                  {renamed && (
                    <span className="font-normal text-muted-foreground"> — nom d’origine « {row.originName} »</span>
                  )}
                  <RequiredMark />
                </label>
                <span className="flex flex-wrap items-center gap-2 text-xs">
                  {/* Masquée : dit par le libellé et l'icône, pas par la couleur seule. */}
                  {row.hidden && (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 font-medium text-foreground">
                      <EyeOffIcon size={16} />
                      Masquée
                    </span>
                  )}
                  {row.count !== undefined && (
                    <span className="text-muted-foreground tabular">{plural(row.count, 'courrier')}</span>
                  )}
                </span>
              </div>
              <input
                id={id(nameField)}
                name={nameField}
                defaultValue={name}
                required
                aria-required
                maxLength={MAX_CUSTOM_CATEGORY_LENGTH}
                autoComplete="off"
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? id(`${nameField}-error`) : undefined}
                className={fieldClass}
              />
              {error && (
                <p id={id(`${nameField}-error`)} className="text-sm text-destructive">
                  {error}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 pr-2 text-sm">
                  <input type="checkbox" name={`masquee-${row.key}`} defaultChecked={hidden} className="size-5" />
                  Masquer
                </label>
                <button
                  id={id(`deplacer-${row.key}-haut`)}
                  type="submit"
                  name="deplacer"
                  value={`${row.key}:haut`}
                  disabled={pending || index === 0}
                  aria-label={`Monter « ${row.name} »`}
                  className={smallButton}
                >
                  <ArrowUpIcon size={20} />
                  Monter
                </button>
                <button
                  id={id(`deplacer-${row.key}-bas`)}
                  type="submit"
                  name="deplacer"
                  value={`${row.key}:bas`}
                  disabled={pending || index === rows.length - 1}
                  aria-label={`Descendre « ${row.name} »`}
                  className={smallButton}
                >
                  <ArrowDownIcon size={20} />
                  Descendre
                </button>
                {renamed && (
                  <button type="submit" name="retablir" value={row.key} disabled={pending} className={smallButton}>
                    Rétablir « {row.originName} »
                  </button>
                )}
                {row.deleteHref && (
                  <a
                    href={row.deleteHref}
                    className="inline-flex min-h-11 items-center px-2 text-sm font-medium text-destructive underline-offset-2 hover:underline"
                  >
                    Supprimer « {row.name} »
                  </a>
                )}
              </div>
            </li>
          )
        })}
      </ol>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <button type="submit" disabled={pending} className={primaryButton}>
          {pending ? 'Enregistrement…' : submitLabel}
        </button>
        {/* Toujours présent, pour que le lecteur d'écran annonce le résultat. */}
        <p role="status" className="text-sm text-primary">
          {!pending && state?.done}
        </p>
      </div>
      <p className="text-sm text-muted-foreground">
        {audience === 'client'
          ? 'Une catégorie masquée n’est plus proposée pour ranger vos courriers ; ceux qui y sont rangés y restent.'
          : 'Une catégorie masquée n’est plus proposée aux clients pour ranger leurs courriers ; ceux qui y sont rangés y restent. Chaque client peut aussi renommer, masquer et ordonner ces catégories pour lui seul.'}
      </p>
    </form>
  )
}
