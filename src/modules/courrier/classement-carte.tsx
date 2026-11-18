'use client'

import { useActionState, useState } from 'react'

import { classifyOneAction, ignoreMailAction, toggleReadAction, type QuickActionState } from './classement-actions.ts'
import type { CategoryOption } from './classement-forms.tsx'
import { NEW_CATEGORY_CHOICE, quickButtonClass } from './classement-ui.ts'
import { ArchiveIcon } from './icones-client.tsx'
import { RequiredMark } from '../../components/ui/obligatoire.tsx'
import { MAX_CUSTOM_CATEGORY_LENGTH } from './categories-perso-regles.ts'

/**
 * Gestes de la carte d'un pli, sans ouvrir sa fiche (ADR 078) : le ranger
 * dans une catégorie, le marquer lu ou non lu, l'ignorer. Les boutons ont
 * tous le même rang visuel : aucun geste n'écrase l'autre.
 *
 * Classer et marquer lu se font en place : la carte reste, une phrase dit ce
 * qui a été fait. Ignorer retire la carte de la liste : la page revient avec
 * une confirmation qui dit où retrouver le pli.
 *
 * Mobile d'abord : contrôles à 44 px, 8 px entre deux cibles.
 */

const fieldClass =
  'block min-h-11 w-full rounded-sm border border-border bg-white px-3 py-2 text-base outline-none focus:border-accent focus:ring-2 focus:ring-accent/40 sm:text-sm'

export function MailCardClassify({
  mailItemId,
  clientId,
  current,
  proposed,
  custom,
  pliLabel,
}: {
  mailItemId: string
  /** Entreprise du pli : une catégorie créée depuis la carte est la sienne (ADR 060). */
  clientId: string
  /** Catégorie du pli : clé de départ, identifiant personnel, ou vide (non classé). */
  current: string
  proposed: readonly CategoryOption[]
  custom: readonly CategoryOption[]
  /** « pli de Banque reçu le 12/11 » : précise les noms accessibles. */
  pliLabel: string
}) {
  const [state, formAction, pending] = useActionState<QuickActionState, FormData>(classifyOneAction, null)
  const selectId = `categorie-${mailItemId}`
  const nameId = `nouvelle-categorie-${mailItemId}`
  const chosen = [...proposed, ...custom].find((option) => option.id === state?.value)
  // « Ajouter une catégorie… » choisi : le champ du nom s'ouvre sous la liste.
  // Liste contrôlée : la remise à zéro du formulaire après l'envoi ne la
  // sépare pas du champ ouvert. Elle suit la base quand la catégorie change.
  const [choice, setChoice] = useState(current)
  const [shown, setShown] = useState(current)
  if (shown !== current) {
    setShown(current)
    setChoice(current)
  }
  const creating = choice === NEW_CATEGORY_CHOICE

  return (
    <form action={formAction} className="flex flex-col gap-1">
      <input type="hidden" name="id" value={mailItemId} />
      <input type="hidden" name="entreprise" value={clientId} />
      <label htmlFor={selectId} className="text-sm font-medium">
        Catégorie
      </label>
      <div className="flex gap-2">
        <select
          id={selectId}
          name="categorie"
          value={choice}
          onChange={(event) => setChoice(event.currentTarget.value)}
          className={fieldClass}
        >
          <option value="">Non classé</option>
          {proposed.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
          {custom.length > 0 && (
            <optgroup label="Mes catégories">
              {custom.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </optgroup>
          )}
          <option value={NEW_CATEGORY_CHOICE}>Ajouter une catégorie…</option>
        </select>
        <button
          type="submit"
          disabled={pending}
          aria-label={`Classer le ${pliLabel}`}
          className={`${quickButtonClass} shrink-0`}
        >
          {pending ? 'Classement…' : 'Classer'}
        </button>
      </div>
      {creating && (
        <div className="mt-1">
          <label htmlFor={nameId} className="text-sm font-medium">
            Nom de la nouvelle catégorie
            <RequiredMark />
          </label>
          <input
            id={nameId}
            name="nouvelleCategorie"
            required
            maxLength={MAX_CUSTOM_CATEGORY_LENGTH}
            autoComplete="off"
            aria-invalid={state?.nameError ? true : undefined}
            aria-describedby={state?.nameError ? `${nameId}-erreur` : `${nameId}-aide`}
            className={`mt-1 ${fieldClass}`}
          />
          <p id={`${nameId}-aide`} className="mt-1 text-sm text-muted-foreground">
            Créée pour vous seul, puis le courrier y est rangé.
          </p>
          {state?.nameError && (
            <p id={`${nameId}-erreur`} role="alert" className="mt-1 text-sm text-destructive">
              {state.nameError}
            </p>
          )}
        </div>
      )}
      {/* Toujours présent, pour que le lecteur d'écran annonce le résultat. */}
      <p aria-live="polite" className="min-h-0 text-sm">
        {state?.ok && (
          <span className="text-primary">
            {state.value
              ? `Rangé dans « ${state.label ?? chosen?.name ?? 'la catégorie choisie'} ».`
              : 'Remis dans « Non classé ».'}
          </span>
        )}
        {state?.error && <span className="text-destructive">{state.error}</span>}
      </p>
    </form>
  )
}

/** « Marquer comme lu » ou « Marquer comme non lu », sur la carte. */
export function MailCardReadToggle({ mailItemId, unread, pliLabel }: { mailItemId: string; unread: boolean; pliLabel: string }) {
  const [state, formAction, pending] = useActionState<QuickActionState, FormData>(toggleReadAction, null)
  const label = unread ? 'Marquer comme lu' : 'Marquer comme non lu'
  return (
    <form action={formAction} className="flex flex-col gap-1">
      <input type="hidden" name="id" value={mailItemId} />
      <input type="hidden" name="lu" value={unread ? '1' : '0'} />
      <button type="submit" disabled={pending} aria-label={`${label} — ${pliLabel}`} className={quickButtonClass}>
        {label}
      </button>
      <p aria-live="polite" className="sr-only">
        {state?.ok && (state.value === 'lu' ? 'Marqué comme lu.' : 'Marqué comme non lu.')}
        {state?.error}
      </p>
    </form>
  )
}

/** « Ignorer » ou « Ne plus ignorer », sur la carte ou sur la fiche. */
export function MailIgnoreButton({
  mailItemId,
  ignored,
  pliLabel,
  returnQuery = '',
  from = 'liste',
}: {
  mailItemId: string
  ignored: boolean
  pliLabel: string
  /** Filtres de la boîte aux lettres, gardés au retour. */
  returnQuery?: string
  from?: 'liste' | 'fiche'
}) {
  const label = ignored ? 'Ne plus ignorer' : 'Ignorer'
  return (
    <form action={ignoreMailAction}>
      <input type="hidden" name="id" value={mailItemId} />
      <input type="hidden" name="ignorer" value={ignored ? '0' : '1'} />
      <input type="hidden" name="retour" value={returnQuery} />
      <input type="hidden" name="depuis" value={from} />
      <button type="submit" aria-label={`${label} — ${pliLabel}`} className={`${quickButtonClass} w-full sm:w-auto`}>
        <ArchiveIcon size={20} />
        {label}
      </button>
    </form>
  )
}
