'use client'

import { useActionState, useState } from 'react'

import { formatIsoDateFr } from './paiements-regles.ts'
import { prepareRemittanceAction, type RemittanceFormState } from './prelevements-actions.ts'
import { formatCents } from './tarifs.ts'

export type RemittanceRow = {
  invoiceId: string
  number: string
  clientName: string
  dueDate: string
  amountDueCents: number
  currency: string
  mandateReference: string | null
  ibanLast4: string | null
  blocker: string | null
}

/**
 * Choix des factures d'une remise de prélèvements (R16, ADR 030). Une facture
 * bloquée (mandat révoqué, caduc…) se voit avec son motif, sans case à cocher.
 * La préparation marque les factures cochées ; le fichier se télécharge
 * ensuite.
 */
export function RemittanceForm({ rows, collectionDate }: { rows: RemittanceRow[]; collectionDate: string }) {
  const [state, formAction, pending] = useActionState<RemittanceFormState, FormData>(prepareRemittanceAction, null)
  const ready = rows.filter((row) => !row.blocker)
  const [selected, setSelected] = useState<string[]>(() => ready.map((row) => row.invoiceId))
  // Compté sur les lignes affichées : une sélection d'avant ne compte plus.
  const chosen = ready.filter((row) => selected.includes(row.invoiceId))
  const total = chosen.reduce((sum, row) => sum + row.amountDueCents, 0)
  const allSelected = ready.length > 0 && chosen.length === ready.length

  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border bg-white px-5 py-4 text-sm text-muted-foreground">
        Aucune facture payable par prélèvement n’est échue au {formatIsoDateFr(collectionDate)}. Choisissez
        une date plus lointaine, ou revenez quand les prochaines échéances arriveront.
      </p>
    )
  }

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="collectionDate" value={collectionDate} />
      {state?.error && (
        <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          <p>{state.error}</p>
          {state.problems && (
            <ul className="mt-1 list-disc pl-5">
              {state.problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-border bg-white">
        <table aria-labelledby="a-prelever-titre" className="w-full text-left text-sm">
          <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th scope="col" className="w-10 px-4 py-3">
                <input
                  type="checkbox"
                  aria-label="Cocher toutes les factures prélevables"
                  checked={allSelected}
                  disabled={ready.length === 0}
                  onChange={(event) => setSelected(event.target.checked ? ready.map((row) => row.invoiceId) : [])}
                  className="size-4 accent-primary"
                />
              </th>
              <th scope="col" className="px-4 py-3 font-medium">Facture</th>
              <th scope="col" className="px-4 py-3 font-medium">Client</th>
              <th scope="col" className="px-4 py-3 font-medium">Échéance</th>
              <th scope="col" className="px-4 py-3 font-medium">Mandat</th>
              <th scope="col" className="px-4 py-3 text-right font-medium">Montant</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((row) => (
              <tr key={row.invoiceId} className={row.blocker ? 'text-muted-foreground' : undefined}>
                <td className="px-4 py-3">
                  {!row.blocker && (
                    <input
                      type="checkbox"
                      name="invoiceIds"
                      value={row.invoiceId}
                      aria-label={`Prélever la facture ${row.number}`}
                      checked={selected.includes(row.invoiceId)}
                      onChange={(event) =>
                        setSelected((current) =>
                          event.target.checked
                            ? [...current, row.invoiceId]
                            : current.filter((id) => id !== row.invoiceId),
                        )
                      }
                      className="size-4 accent-primary"
                    />
                  )}
                </td>
                <td className="whitespace-nowrap px-4 py-3 font-medium tabular">{row.number}</td>
                <td className="px-4 py-3">{row.clientName}</td>
                <td className="whitespace-nowrap px-4 py-3 tabular">{formatIsoDateFr(row.dueDate)}</td>
                <td className="px-4 py-3">
                  {row.mandateReference ? (
                    <>
                      <span className="tabular">{row.mandateReference}</span>
                      {row.ibanLast4 && (
                        <span className="block text-xs text-muted-foreground tabular">•••• {row.ibanLast4}</span>
                      )}
                    </>
                  ) : (
                    '—'
                  )}
                  {row.blocker && <span className="block text-xs font-medium text-foreground">Bloquée : {row.blocker}</span>}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-right tabular">
                  {formatCents(row.amountDueCents, row.currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending || chosen.length === 0}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white transition-colors duration-150 ease-out hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
        >
          {pending ? 'Préparation…' : `Préparer la remise du ${formatIsoDateFr(collectionDate)}`}
        </button>
        <span aria-live="polite" className="text-sm tabular text-muted-foreground">
          {pending
            ? 'Préparation en cours'
            : `${chosen.length} prélèvement${chosen.length > 1 ? 's' : ''}, ${formatCents(total, rows[0]?.currency ?? 'EUR')}`}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        Les factures cochées passent « réglées », d’un paiement par prélèvement daté du jour demandé. Un
        prélèvement rejeté par la banque s’annule depuis la fiche de règlement de la facture, avec le
        motif du rejet.
      </p>
    </form>
  )
}
