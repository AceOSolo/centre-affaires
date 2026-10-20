'use client'

import { useActionState, useMemo, useRef, useState, type KeyboardEvent } from 'react'

import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import type { MailRecipient } from './saisie-groupee.ts'
import { registerMailCountsAction, type MailCountsFormState } from './saisie-groupee-actions.ts'
import { countFieldName, MAX_PER_CELL } from './saisie-groupee-regles.ts'
import { mailKinds, type MailKind } from './schema.ts'

const fieldClass =
  'rounded-sm border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/40 aria-[invalid=true]:border-destructive'
const cellClass =
  'w-14 rounded-sm border border-border bg-white px-2 py-1 text-right text-sm tabular outline-none focus:border-accent focus:ring-2 focus:ring-accent/40 aria-[invalid=true]:border-destructive'

const columnLabels: Record<MailKind, string> = {
  lettre: 'Lettres',
  recommande: 'Recommandés',
  colis: 'Colis',
  autre: 'Autres',
}

const pluralKind: Record<MailKind, [string, string]> = {
  lettre: ['lettre', 'lettres'],
  recommande: ['recommandé', 'recommandés'],
  colis: ['colis', 'colis'],
  autre: ['autre', 'autres'],
}

const fold = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()

const countOf = (value: string | undefined) => {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : 0
}

/**
 * Saisie groupée de la tournée : une ligne par entreprise, une case par type
 * de pli. Pensée pour le clavier : taper le nom ou la boîte, Entrée, le
 * nombre, Entrée — et l'on revient à la recherche pour l'entreprise suivante.
 * Les flèches haut et bas passent d'une ligne à l'autre dans la même colonne.
 */
export function MailCountsForm({
  recipients,
  defaultReceivedAt,
}: {
  recipients: MailRecipient[]
  /** Heure murale du centre, au format `datetime-local`. */
  defaultReceivedAt: string
}) {
  const [state, formAction, pending] = useActionState<MailCountsFormState, FormData>(
    registerMailCountsAction,
    null,
  )
  return (
    // Remonté après un échec pour reprendre la saisie renvoyée par le serveur.
    <MailCountsTable
      key={JSON.stringify(state?.values ?? {})}
      recipients={recipients}
      defaultReceivedAt={defaultReceivedAt}
      state={state}
      formAction={formAction}
      pending={pending}
    />
  )
}

function MailCountsTable({
  recipients,
  defaultReceivedAt,
  state,
  formAction,
  pending,
}: {
  recipients: MailRecipient[]
  defaultReceivedAt: string
  state: MailCountsFormState
  formAction: (formData: FormData) => void
  pending: boolean
}) {
  const [counts, setCounts] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {}
    for (const [name, value] of Object.entries(state?.values ?? {})) {
      if (name.startsWith('n.')) initial[name] = value
    }
    return initial
  })
  const [query, setQuery] = useState('')
  const formRef = useRef<HTMLFormElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const errors = state?.fieldErrors ?? {}

  const visible = useMemo(() => {
    const terms = fold(query).split(/\s+/).filter(Boolean)
    if (terms.length === 0) return new Set(recipients.map((r) => r.id))
    return new Set(
      recipients
        .filter((r) => {
          const haystack = fold(`${r.name} ${r.mailbox ?? ''}`)
          return terms.every((term) => haystack.includes(term))
        })
        .map((r) => r.id),
    )
  }, [query, recipients])

  const visibleOrder = recipients.filter((r) => visible.has(r.id))

  const entered = recipients
    .map((recipient) => {
      const perKind = mailKinds
        .map((kind) => [kind, countOf(counts[countFieldName(recipient.id, kind)])] as const)
        .filter(([, n]) => n > 0)
      return { recipient, perKind, total: perKind.reduce((sum, [, n]) => sum + n, 0) }
    })
    .filter((entry) => entry.total > 0)
  const total = entered.reduce((sum, entry) => sum + entry.total, 0)

  const labels: Record<string, string> = { receivedAt: 'Reçu le' }
  for (const recipient of recipients) {
    for (const kind of mailKinds) {
      labels[countFieldName(recipient.id, kind)] = `${recipient.name} — ${columnLabels[kind]}`
    }
  }

  const focusCell = (clientId: string, kind: MailKind) => {
    const input = document.getElementById(countFieldName(clientId, kind)) as HTMLInputElement | null
    input?.focus()
    input?.select()
  }

  const backToSearch = () => {
    searchRef.current?.focus()
    searchRef.current?.select()
  }

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || event.ctrlKey || event.metaKey) return
    event.preventDefault()
    const first = visibleOrder[0]
    if (first) focusCell(first.id, 'lettre')
  }

  const onCellKeyDown = (event: KeyboardEvent<HTMLInputElement>, clientId: string, kind: MailKind) => {
    if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey) {
      // Entrée ne soumet pas : elle ramène à la recherche, pour l'entreprise suivante.
      event.preventDefault()
      backToSearch()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const index = visibleOrder.findIndex((r) => r.id === clientId)
      const next = visibleOrder[index + (event.key === 'ArrowDown' ? 1 : -1)]
      if (next) focusCell(next.id, kind)
    }
  }

  const onFormKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      if (!pending) formRef.current?.requestSubmit()
    }
  }

  const showAll = (clientId: string) => {
    setQuery('')
    // Après le rendu sans filtre, la ligne est de nouveau visible.
    requestAnimationFrame(() => focusCell(clientId, 'lettre'))
  }

  const groups = [
    { key: 'domicilies', title: 'Domiciliés', rows: recipients.filter((r) => r.domiciled) },
    { key: 'autres', title: 'Autres entreprises', rows: recipients.filter((r) => !r.domiciled) },
  ].filter((group) => group.rows.length > 0)

  return (
    <form
      ref={formRef}
      action={formAction}
      onKeyDown={onFormKeyDown}
      className="flex flex-col gap-5"
      aria-describedby="saisie-aide"
    >
      <ErrorSummary errors={state?.fieldErrors} labels={labels} message={state?.error} />

      <div className="flex flex-wrap items-end gap-4">
        <div className="min-w-64 flex-1">
          <label htmlFor="recherche" className="block text-sm font-medium text-foreground">
            Trouver une entreprise
          </label>
          <input
            ref={searchRef}
            id="recherche"
            type="search"
            autoFocus
            autoComplete="off"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onSearchKeyDown}
            aria-describedby="saisie-aide"
            aria-controls="saisie-tableau"
            className={`${fieldClass} mt-1 w-full`}
          />
        </div>
        <div>
          <label htmlFor="receivedAt" className="block text-sm font-medium text-foreground">
            Reçu le
          </label>
          <input
            id="receivedAt"
            name="receivedAt"
            type="datetime-local"
            required
            defaultValue={state?.values?.receivedAt ?? defaultReceivedAt}
            aria-invalid={errors.receivedAt ? true : undefined}
            aria-describedby={errors.receivedAt ? 'receivedAt-error' : undefined}
            className={`${fieldClass} mt-1 tabular`}
          />
          {errors.receivedAt && (
            <p id="receivedAt-error" className="mt-1 text-xs text-destructive">
              {errors.receivedAt}
            </p>
          )}
        </div>
      </div>
      <p id="saisie-aide" className="-mt-3 text-xs text-muted-foreground">
        Nom ou numéro de boîte, <kbd>Entrée</kbd>, le nombre de plis, <kbd>Entrée</kbd> : retour à la
        recherche. <kbd>Tab</kbd> passe au type suivant, <kbd>↑</kbd> <kbd>↓</kbd> à l’entreprise voisine,{' '}
        <kbd>Ctrl</kbd>+<kbd>Entrée</kbd> enregistre tout.
      </p>

      <p className="sr-only" aria-live="polite">
        {query ? `${visibleOrder.length} entreprise${visibleOrder.length > 1 ? 's' : ''} affichée${visibleOrder.length > 1 ? 's' : ''}` : ''}
      </p>

      <div className="overflow-x-auto rounded-lg border border-border bg-white">
        <table id="saisie-tableau" className="w-full text-left text-sm">
          <caption className="sr-only">Nombre de plis reçus par entreprise et par type</caption>
          <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">Entreprise</th>
              <th scope="col" className="px-4 py-2 font-medium">Boîte</th>
              {mailKinds.map((kind) => (
                <th key={kind} id={`col-${kind}`} scope="col" className="px-2 py-2 text-right font-medium">
                  {columnLabels[kind]}
                </th>
              ))}
            </tr>
          </thead>
          {groups.map((group) => {
            const shown = group.rows.some((r) => visible.has(r.id))
            return (
              <tbody key={group.key} className="divide-y divide-border" hidden={!shown}>
                {groups.length > 1 && (
                  <tr className="bg-muted">
                    <th
                      scope="colgroup"
                      colSpan={2 + mailKinds.length}
                      className="px-4 py-1.5 text-xs font-semibold text-muted-foreground"
                    >
                      {group.title}
                    </th>
                  </tr>
                )}
                {group.rows.map((recipient) => (
                  // Une ligne filtrée reste dans le formulaire : sa saisie part avec le reste.
                  <tr key={recipient.id} hidden={!visible.has(recipient.id)}>
                    <th scope="row" id={`ligne-${recipient.id}`} className="px-4 py-1.5 font-medium">
                      {recipient.name}
                    </th>
                    <td className="px-4 py-1.5 text-muted-foreground tabular">{recipient.mailbox ?? '—'}</td>
                    {mailKinds.map((kind) => {
                      const name = countFieldName(recipient.id, kind)
                      return (
                        <td key={kind} className="px-2 py-1.5 text-right align-top">
                          <input
                            id={name}
                            name={name}
                            inputMode="numeric"
                            pattern="[0-9]*"
                            maxLength={String(MAX_PER_CELL).length}
                            autoComplete="off"
                            value={counts[name] ?? ''}
                            onChange={(event) =>
                              setCounts((current) => ({ ...current, [name]: event.target.value }))
                            }
                            onKeyDown={(event) => onCellKeyDown(event, recipient.id, kind)}
                            aria-labelledby={`ligne-${recipient.id} col-${kind}`}
                            aria-invalid={errors[name] ? true : undefined}
                            aria-describedby={errors[name] ? `${name}-error` : undefined}
                            className={cellClass}
                          />
                          {errors[name] && (
                            <p id={`${name}-error`} className="mt-1 max-w-32 text-xs text-destructive">
                              {errors[name]}
                            </p>
                          )}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            )
          })}
        </table>
        {visibleOrder.length === 0 && (
          <p className="px-4 py-6 text-sm text-muted-foreground">
            Aucune entreprise ne correspond à « {query} ». Vérifiez l’orthographe, ou cherchez par
            numéro de boîte.
          </p>
        )}
      </div>

      <div className="sticky bottom-0 -mx-1 flex flex-col gap-3 rounded-lg border border-border bg-white px-4 py-3 shadow-sm">
        {entered.length > 0 && (
          <ul aria-label="Saisie en cours" className="flex flex-wrap gap-2 text-xs">
            {entered.map(({ recipient, perKind }) => (
              <li key={recipient.id}>
                <button
                  type="button"
                  onClick={() => showAll(recipient.id)}
                  className="rounded-full bg-muted px-3 py-1 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  <span className="font-medium">{recipient.name}</span> :{' '}
                  {perKind.map(([kind, n]) => `${n} ${pluralKind[kind][n > 1 ? 1 : 0]}`).join(', ')}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm tabular" aria-live="polite">
            {total === 0
              ? 'Aucun pli saisi.'
              : `${total} pli${total > 1 ? 's' : ''} pour ${entered.length} entreprise${entered.length > 1 ? 's' : ''}.`}
          </p>
          <button
            type="submit"
            disabled={pending || total === 0}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50"
          >
            {pending
              ? 'Enregistrement…'
              : total === 0
                ? 'Enregistrer dans la tournée'
                : total === 1
                  ? 'Enregistrer le pli dans la tournée'
                  : `Enregistrer les ${total} plis dans la tournée`}
          </button>
        </div>
      </div>
    </form>
  )
}
