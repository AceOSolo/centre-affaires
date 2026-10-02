'use client'

import Link from 'next/link'
import { useActionState, useMemo, useState } from 'react'

import { FlashNotice } from '../../components/ui/flash-notice.tsx'
import { dunningLevelLabels, formatIsoDateFr, type DunningLevel } from './paiements-regles.ts'
import { sendRemindersAction, type ReminderState } from './reglements-actions.ts'
import { paymentMethodLabels } from './reglements-labels.ts'
import { formatCents } from './tarifs.ts'
import type { PaymentMethod } from '../../db/tenants.ts'

export type OverdueRow = {
  id: string
  number: string
  clientName: string
  dueDate: string
  daysOverdue: number
  amountDueCents: number
  currency: string
  expectedPaymentMethod: PaymentMethod
  level: DunningLevel
  /** Dernière relance inscrite au journal (ADR 034), déjà mise en mots ; nulle : aucune. */
  lastReminder: string | null
}

/**
 * Factures échues non payées (R16, ADR 030), la plus ancienne d'abord, avec
 * leur palier de relance. La relance se lit et s'imprime depuis chaque ligne ;
 * l'envoi par courriel se fait par lot, sur les factures cochées, et
 * seulement par un geste de l'équipe.
 */
export function OverdueTable({
  rows,
  canSend,
  emailOn,
}: {
  rows: OverdueRow[]
  /** Droit `paiements.gerer`. */
  canSend: boolean
  /** Le SMTP est configuré : sinon, rien ne partirait. */
  emailOn: boolean
}) {
  const [state, formAction, pending] = useActionState<ReminderState, FormData>(sendRemindersAction, null)
  const [selected, setSelected] = useState<string[]>([])
  const selectable = canSend && emailOn
  const allSelected = selected.length > 0 && selected.length === rows.length
  const selectedTotal = useMemo(
    () => rows.filter((row) => selected.includes(row.id)).reduce((total, row) => total + row.amountDueCents, 0),
    [rows, selected],
  )

  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border bg-white px-5 py-4 text-sm text-muted-foreground">
        Aucune facture échue n’attend de règlement. Les factures à échoir sont listées plus bas ; une
        facture en retard apparaîtra ici dès le lendemain de son échéance.
      </p>
    )
  }

  return (
    <form action={formAction} className="flex flex-col gap-3">
      {state?.error && (
        <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {state.error}
        </p>
      )}
      {state?.sent !== undefined && (
        <FlashNotice key={`${state.sent}-${(state.skipped ?? []).join('|')}`}>
          <p>
            {state.sent === 0
              ? 'Aucune relance n’est partie.'
              : `${state.sent} relance${state.sent > 1 ? 's' : ''} envoyée${state.sent > 1 ? 's' : ''} par courriel.`}
          </p>
          {state.skipped && state.skipped.length > 0 && (
            <ul className="mt-1 list-disc pl-5">
              {state.skipped.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
        </FlashNotice>
      )}

      {canSend && !emailOn && (
        <p className="text-sm text-muted-foreground">
          L’envoi de courriels n’est pas configuré sur ce serveur : ouvrez la relance d’une facture pour
          l’imprimer.
        </p>
      )}

      <div className="overflow-x-auto rounded-lg border border-border bg-white">
        <table aria-labelledby="echues-titre" className="w-full text-left text-sm">
          <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              {selectable && (
                <th scope="col" className="w-10 px-4 py-3">
                  <input
                    type="checkbox"
                    aria-label="Cocher toutes les factures échues"
                    checked={allSelected}
                    onChange={(event) => setSelected(event.target.checked ? rows.map((row) => row.id) : [])}
                    className="size-4 accent-primary"
                  />
                </th>
              )}
              <th scope="col" className="px-4 py-3 font-medium">Facture</th>
              <th scope="col" className="px-4 py-3 font-medium">Client</th>
              <th scope="col" className="px-4 py-3 font-medium">Échéance</th>
              <th scope="col" className="px-4 py-3 text-right font-medium">Retard</th>
              <th scope="col" className="px-4 py-3 text-right font-medium">Reste dû</th>
              <th scope="col" className="px-4 py-3 font-medium">Mode</th>
              <th scope="col" className="px-4 py-3 font-medium">Palier</th>
              <th scope="col" className="px-4 py-3 font-medium">Dernière relance</th>
              <th scope="col" className="px-4 py-3">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((row) => (
              <tr key={row.id}>
                {selectable && (
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      name="invoiceIds"
                      value={row.id}
                      aria-label={`Relancer la facture ${row.number}`}
                      checked={selected.includes(row.id)}
                      onChange={(event) =>
                        setSelected((current) =>
                          event.target.checked ? [...current, row.id] : current.filter((id) => id !== row.id),
                        )
                      }
                      className="size-4 accent-primary"
                    />
                  </td>
                )}
                <td className="whitespace-nowrap px-4 py-3">
                  <Link
                    href={`/paiements/factures/${row.id}`}
                    className="font-medium tabular underline-offset-2 hover:underline"
                  >
                    {row.number}
                  </Link>
                </td>
                <td className="px-4 py-3">{row.clientName}</td>
                <td className="whitespace-nowrap px-4 py-3 tabular">{formatIsoDateFr(row.dueDate)}</td>
                <td className="whitespace-nowrap px-4 py-3 text-right tabular">
                  {row.daysOverdue} j
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-right font-medium tabular">
                  {formatCents(row.amountDueCents, row.currency)}
                </td>
                <td className="px-4 py-3">{paymentMethodLabels[row.expectedPaymentMethod]}</td>
                <td className="px-4 py-3">{dunningLevelLabels[row.level]}</td>
                <td className="px-4 py-3 text-muted-foreground">{row.lastReminder ?? 'Aucune'}</td>
                <td className="whitespace-nowrap px-4 py-3 text-right">
                  <Link
                    href={`/paiements/factures/${row.id}/relance`}
                    aria-label={`Lettre de relance de la facture ${row.number}`}
                    className="inline-block rounded-md border border-border px-3 py-1 text-xs font-medium hover:bg-muted"
                  >
                    Relance
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selectable && (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={pending || selected.length === 0}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white transition-colors duration-150 ease-out hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
          >
            {pending
              ? 'Envoi…'
              : selected.length === 0
                ? 'Envoyer les relances cochées'
                : `Envoyer ${selected.length} relance${selected.length > 1 ? 's' : ''} par courriel`}
          </button>
          <span aria-live="polite" className="text-sm text-muted-foreground tabular">
            {pending
              ? 'Envoi en cours'
              : selected.length > 0
                ? `${formatCents(selectedTotal, rows[0]?.currency ?? 'EUR')} restant dus sur la sélection`
                : ''}
          </span>
        </div>
      )}
    </form>
  )
}
