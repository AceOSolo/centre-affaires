'use client'

import { useActionState, useRef, useState } from 'react'

import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import { saveSenderListAction, type SenderListFormState } from './expediteurs-actions.ts'
import { MAX_SENDER_LENGTH, MAX_SUGGESTED_SENDERS, senderKey } from './expediteurs.ts'

type Row = { key: number; value: string }

const inputClass =
  'w-full min-w-0 rounded-sm border border-border bg-white px-3 py-1.5 text-base outline-none focus:border-accent focus:ring-2 focus:ring-accent/40 aria-[invalid=true]:border-destructive sm:text-sm'
const smallButton =
  'min-h-8 rounded-md border border-border bg-white px-2.5 text-xs font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-40'

/**
 * La liste des expéditeurs proposés à la saisie du courrier (ADR 079) :
 * ajouter, renommer, retirer, ordonner, puis enregistrer d'un coup. Chaque
 * ligne est un champ `expediteur`, envoyé dans l'ordre de l'écran ; une ligne
 * vidée est retirée. Sans JavaScript, on renomme, on vide une ligne pour la
 * retirer et on remplit la ligne vide du bas pour ajouter ; l'ordre, lui,
 * demande les boutons.
 */
export function SenderListForm({
  list,
  customized,
  frequent,
}: {
  list: string[]
  customized: boolean
  /** Souvent saisis au centre, absents de la liste : ajoutés d'un clic. */
  frequent: string[]
}) {
  const [state, formAction, pending] = useActionState<SenderListFormState, FormData>(saveSenderListAction, null)
  // Après un refus, l'écran repart de la saisie refusée, à corriger.
  return (
    <Editor
      key={JSON.stringify(state?.values ?? list)}
      initial={state?.values ?? list}
      state={state}
      formAction={formAction}
      pending={pending}
      customized={customized}
      frequent={frequent}
    />
  )
}

function Editor({
  initial,
  state,
  formAction,
  pending,
  customized,
  frequent,
}: {
  initial: string[]
  state: SenderListFormState
  formAction: (formData: FormData) => void
  pending: boolean
  customized: boolean
  frequent: string[]
}) {
  // Une ligne vide au bas : de quoi ajouter, même sans JavaScript.
  const [rows, setRows] = useState<Row[]>(() => [...initial, ''].map((value, index) => ({ key: index + 1, value })))
  const lastKey = useRef(initial.length + 1)
  const nextKey = () => (lastKey.current += 1)
  const [status, setStatus] = useState('')
  const errors = state?.fieldErrors ?? {}
  const listed = new Set(rows.map((row) => senderKey(row.value)).filter(Boolean))
  const toAdd = frequent.filter((sender) => !listed.has(senderKey(sender)))
  const filled = rows.filter((row) => row.value.trim() !== '').length

  const focusRow = (key: number) =>
    requestAnimationFrame(() => document.querySelector<HTMLInputElement>(`[data-ligne="${key}"]`)?.focus())

  function move(index: number, offset: -1 | 1) {
    const target = index + offset
    if (target < 0 || target >= rows.length) return
    const next = [...rows]
    ;[next[index], next[target]] = [next[target], next[index]]
    setRows(next)
    setStatus(`${rows[index].value || 'Ligne vide'} : ${offset < 0 ? 'montée' : 'descendue'} au rang ${target + 1}.`)
  }

  function remove(index: number) {
    const removed = rows[index]
    const next = rows.filter((_, position) => position !== index)
    setRows(next.length > 0 ? next : [{ key: nextKey(), value: '' }])
    setStatus(`${removed.value || 'Ligne vide'} : retiré de la liste. Enregistrez pour confirmer.`)
    const neighbour = next[Math.min(index, next.length - 1)]
    if (neighbour) focusRow(neighbour.key)
  }

  function add(value = '') {
    const row = { key: nextKey(), value }
    // Avant la ligne vide du bas, s'il y en a une.
    const last = rows.at(-1)
    setRows(last && last.value === '' && value !== '' ? [...rows.slice(0, -1), row, last] : [...rows, row])
    setStatus(value ? `${value} : ajouté à la fin de la liste. Enregistrez pour confirmer.` : '')
    if (!value) focusRow(row.key)
  }

  const labels = Object.fromEntries(rows.map((row, index) => [`expediteur-${index}`, `Ligne ${index + 1}`]))

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <ErrorSummary errors={state?.fieldErrors} labels={labels} message={state?.error} />

      {toAdd.length > 0 && (
        <section aria-labelledby="frequents" className="flex flex-col gap-2 rounded-lg border border-border bg-white px-4 py-3">
          <h2 id="frequents" className="text-sm font-semibold tracking-tight">
            Souvent saisis, absents de la liste
          </h2>
          <ul className="flex flex-wrap gap-2">
            {toAdd.map((sender) => (
              <li key={sender}>
                <button type="button" onClick={() => add(sender)} className={smallButton} aria-label={`Ajouter ${sender} à la liste`}>
                  + {sender}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="relative overflow-x-auto rounded-lg border border-border bg-white">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Expéditeurs proposés, dans l’ordre</caption>
          <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th scope="col" className="w-14 px-3 py-2 font-medium">
                Rang
              </th>
              <th scope="col" id="col-expediteur" className="px-3 py-2 font-medium">
                Expéditeur
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((row, index) => {
              const id = `expediteur-${index}`
              const name = row.value.trim() || 'ligne vide'
              return (
                <tr key={row.key} className="align-top">
                  <th scope="row" id={`rang-${row.key}`} className="px-3 py-2 font-normal text-muted-foreground tabular">
                    {index + 1}
                  </th>
                  <td className="px-3 py-2">
                    <input
                      id={id}
                      data-ligne={row.key}
                      name="expediteur"
                      value={row.value}
                      onChange={(event) =>
                        setRows(rows.map((other) => (other.key === row.key ? { ...other, value: event.target.value } : other)))
                      }
                      autoComplete="off"
                      maxLength={MAX_SENDER_LENGTH}
                      aria-labelledby={`col-expediteur rang-${row.key}`}
                      aria-invalid={errors[id] ? true : undefined}
                      aria-describedby={errors[id] ? `${id}-erreur` : undefined}
                      className={inputClass}
                    />
                    {errors[id] && (
                      <p id={`${id}-erreur`} className="mt-1 text-xs text-destructive">
                        {errors[id]}
                      </p>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-2">
                      <button type="button" onClick={() => move(index, -1)} disabled={index === 0} className={smallButton} aria-label={`Monter ${name}`}>
                        Monter
                      </button>
                      <button
                        type="button"
                        onClick={() => move(index, 1)}
                        disabled={index === rows.length - 1}
                        className={smallButton}
                        aria-label={`Descendre ${name}`}
                      >
                        Descendre
                      </button>
                      <button type="button" onClick={() => remove(index)} className={smallButton} aria-label={`Retirer ${name}`}>
                        Retirer
                      </button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <p aria-live="polite" className="min-h-5 text-sm">
        {status}
      </p>

      <div className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-white px-4 py-3">
        <p className="text-sm tabular">
          {filled} expéditeur{filled > 1 ? 's' : ''} sur {MAX_SUGGESTED_SENDERS} au plus.
        </p>
        {/* « Enregistrer » d'abord : Entrée dans un champ envoie le premier bouton du formulaire. */}
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => add()} className="min-h-10 rounded-md border border-border bg-white px-4 text-sm font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            Ajouter un expéditeur
          </button>
          <button
            type="submit"
            name="intent"
            value="enregistrer"
            disabled={pending}
            className="min-h-10 rounded-md bg-primary px-5 text-sm font-medium text-white hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50"
          >
            {pending ? 'Enregistrement…' : 'Enregistrer la liste'}
          </button>
          {customized && (
            <button
              type="submit"
              name="intent"
              value="retablir"
              disabled={pending}
              className="min-h-10 rounded-md border border-border bg-white px-4 text-sm font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50"
            >
              Revenir à la liste par défaut
            </button>
          )}
        </div>
      </div>
    </form>
  )
}
