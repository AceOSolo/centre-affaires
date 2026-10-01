'use client'

import { useActionState } from 'react'

import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import { FlashNotice } from '../../components/ui/flash-notice.tsx'
import { saveClientCodesAction, type ClientCodesState } from './comptabilite-actions.ts'

export type ClientCodeRow = { id: string; name: string; accountingCode: string | null; proposedCode: string }

/**
 * Comptes auxiliaires des clients facturés (ADR 027) : celui de la fiche, ou
 * celui que l'export dérive de la raison sociale. Le fixer évite qu'un
 * changement de nom change le compte chez l'expert-comptable.
 */
export function ClientCodesForm({ rows }: { rows: ClientCodeRow[] }) {
  const [state, formAction, pending] = useActionState<ClientCodesState, FormData>(saveClientCodesAction, null)
  const errors = state?.errors ?? {}
  // Le résumé d'erreurs mène à chaque champ par son `id`, `code-<client>`.
  const fieldErrors = Object.fromEntries(
    Object.entries(errors)
      .filter(([clientId]) => clientId)
      .map(([clientId, message]) => [`code-${clientId}`, message]),
  )
  const fieldLabels = Object.fromEntries(rows.map((row) => [`code-${row.id}`, row.name]))

  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border bg-white px-5 py-4 text-sm text-muted-foreground">
        Aucun client n’a encore de facture émise : les comptes auxiliaires se fixent une fois la première
        facture émise.
      </p>
    )
  }

  return (
    <form key={JSON.stringify(state ?? '')} action={formAction} noValidate className="flex flex-col gap-3">
      {state?.saved && <FlashNotice>Comptes auxiliaires enregistrés.</FlashNotice>}
      <ErrorSummary
        errors={state?.errors ? fieldErrors : undefined}
        labels={fieldLabels}
        message={errors[''] ?? (state?.errors ? 'Rien n’a été enregistré.' : undefined)}
      />
      <div className="overflow-x-auto rounded-lg border border-border bg-white">
        <table aria-labelledby="auxiliaires-titre" className="w-full text-left text-sm">
          <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th scope="col" className="px-4 py-3 font-medium">Client</th>
              <th scope="col" className="px-4 py-3 font-medium">Compte auxiliaire</th>
              <th scope="col" className="px-4 py-3 font-medium">Origine</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((row) => {
              const fieldId = `code-${row.id}`
              const error = errors[row.id]
              return (
                <tr key={row.id}>
                  <th scope="row" className="px-4 py-2 text-left font-normal">
                    <label htmlFor={fieldId}>{row.name}</label>
                  </th>
                  <td className="px-4 py-2">
                    <input
                      id={fieldId}
                      name={fieldId}
                      defaultValue={state?.values?.[row.id] ?? row.accountingCode ?? row.proposedCode}
                      maxLength={17}
                      spellCheck={false}
                      autoCapitalize="characters"
                      aria-invalid={error ? true : undefined}
                      aria-describedby={error ? `${fieldId}-error` : undefined}
                      className="w-48 rounded-sm border border-border bg-white px-2 py-1.5 text-sm uppercase tabular outline-none focus:border-accent focus:ring-2 focus:ring-accent/40 aria-[invalid=true]:border-destructive"
                    />
                    {error && (
                      <p id={`${fieldId}-error`} className="mt-1 text-xs text-destructive">
                        {error}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">
                    {row.accountingCode ? 'Fixé sur la fiche' : 'Proposé (dérivé du nom)'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md border border-border bg-white px-4 py-2 text-sm font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
        >
          {pending ? 'Enregistrement…' : 'Fixer les comptes auxiliaires'}
        </button>
        <span aria-live="polite" className="sr-only">
          {pending ? 'Enregistrement en cours' : ''}
        </span>
      </div>
    </form>
  )
}
