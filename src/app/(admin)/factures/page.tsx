import Link from 'next/link'

import { FlashNotice } from '../../../components/ui/flash-notice.tsx'
import { can } from '../../../lib/auth/permissions.ts'
import { requirePermission } from '../../../lib/auth/staff.ts'
import { isIsoMonth } from '../../../lib/dates.ts'
import { isUuid } from '../../../lib/uuid.ts'
import { listClients } from '../../../modules/clients/queries.ts'
import { BulkIssueForm } from '../../../modules/facturation/factures-forms.tsx'
import {
  invoiceKindLabels,
  invoiceStatusLabel,
  invoiceStatusLabels,
  invoiceStatusStyles,
} from '../../../modules/facturation/factures-labels.ts'
import { INVOICE_LIST_LIMIT, listInvoices } from '../../../modules/facturation/factures-queries.ts'
import { dayLabel } from '../../../modules/facturation/lot.ts'
import { amountDueCents } from '../../../modules/facturation/montants.ts'
import { formatPeriod } from '../../../modules/facturation/periodes.ts'
import {
  invoiceKinds,
  invoiceStatuses,
  type InvoiceKind,
  type InvoiceStatus,
} from '../../../modules/facturation/schema-factures.ts'
import { formatCents } from '../../../modules/facturation/tarifs.ts'

export const metadata = { title: 'Factures' }

const notices: Record<string, string> = {
  abandonne: 'Brouillon abandonné : ses lignes sont retirées, leurs sources redeviennent facturables.',
}

const fieldClass =
  'mt-1 w-full rounded-sm border border-border bg-white px-3 py-1.5 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/40'

export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{ statut?: string; nature?: string; client?: string; mois?: string; fait?: string }>
}) {
  const { member } = await requirePermission('facturation.consulter')
  const params = await searchParams
  const status = invoiceStatuses.includes(params.statut as InvoiceStatus)
    ? (params.statut as InvoiceStatus)
    : undefined
  const kind = invoiceKinds.includes(params.nature as InvoiceKind) ? (params.nature as InvoiceKind) : undefined
  const clientId = isUuid(params.client) ? params.client : undefined
  const month = isIsoMonth(params.mois) ? params.mois : undefined
  const canManage = can(member.role, 'facturation.gerer')

  const [rows, clients] = await Promise.all([
    listInvoices({ status, kind, clientId, month }),
    listClients(),
  ])
  const filtered = Boolean(status || kind || clientId || month)
  // L'émission groupée vise les factures du lot ; un avoir se relit et s'émet depuis sa fiche.
  const draftCount = rows.filter((row) => row.status === 'draft' && row.kind === 'invoice').length

  const table = (
    <div className="overflow-x-auto rounded-lg border border-border bg-white">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">
          Factures et avoirs{filtered ? ' filtrés' : ''}, brouillons en tête
        </caption>
        <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            {canManage && draftCount > 0 && (
              <th scope="col" className="px-3 py-3 font-medium">
                <span className="sr-only">Sélection</span>
              </th>
            )}
            <th scope="col" className="px-4 py-3 font-medium">Numéro</th>
            <th scope="col" className="px-4 py-3 font-medium">Client</th>
            <th scope="col" className="px-4 py-3 font-medium">Période</th>
            <th scope="col" className="px-4 py-3 font-medium">Émise le</th>
            <th scope="col" className="px-4 py-3 text-right font-medium">Total TTC</th>
            <th scope="col" className="px-4 py-3 text-right font-medium">Reste dû</th>
            <th scope="col" className="px-4 py-3 font-medium">État</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row) => {
            const label = `${invoiceKindLabels[row.kind]} ${row.number ?? 'brouillon'} — ${row.clientName}`
            return (
              <tr key={row.id}>
                {canManage && draftCount > 0 && (
                  <td className="px-3 py-3">
                    {row.status === 'draft' && row.kind === 'invoice' && (
                      <input
                        type="checkbox"
                        name="ids"
                        value={row.id}
                        aria-label={`Sélectionner le brouillon de ${row.clientName}`}
                        className="size-4 accent-primary"
                      />
                    )}
                  </td>
                )}
                <td className="whitespace-nowrap px-4 py-3">
                  <Link
                    href={`/factures/${row.id}`}
                    aria-label={label}
                    className="font-medium tabular underline-offset-2 hover:underline"
                  >
                    {row.number ?? 'Brouillon'}
                  </Link>
                  {row.kind === 'credit_note' && (
                    <span className="ml-2 text-xs text-muted-foreground">Avoir</span>
                  )}
                </td>
                <td className="px-4 py-3">{row.clientName}</td>
                <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                  {formatPeriod(row.periodStart, row.periodEnd)}
                </td>
                <td className="whitespace-nowrap px-4 py-3 tabular text-muted-foreground">
                  {row.issueDate ? dayLabel(row.issueDate) : '—'}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-right tabular">
                  {row.kind === 'credit_note' && row.totalInclTaxCents > 0 ? '− ' : ''}
                  {formatCents(row.totalInclTaxCents, row.currency)}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-right tabular">
                  {row.kind === 'invoice' && row.status !== 'draft' && row.status !== 'cancelled'
                    ? formatCents(amountDueCents(row), row.currency)
                    : '—'}
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${invoiceStatusStyles[row.status]}`}
                  >
                    {invoiceStatusLabel(row.kind, row.status)}
                  </span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Factures</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Factures et avoirs du centre. Un brouillon se relit et se corrige ; une facture émise ne
            se modifie plus, elle se corrige par un avoir.
          </p>
        </div>
        {canManage && (
          <Link
            href="/factures/preparer"
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover"
          >
            Préparer la facturation
          </Link>
        )}
      </div>

      {params.fait && notices[params.fait] && (
        <FlashNotice key={params.fait}>{notices[params.fait]}</FlashNotice>
      )}

      {/* Formulaire GET : les filtres restent dans l'URL, la liste se partage. */}
      <form className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-white px-4 py-3">
        <div>
          <label htmlFor="statut" className="block text-xs font-medium text-muted-foreground">
            État
          </label>
          <select id="statut" name="statut" defaultValue={status ?? ''} className={fieldClass}>
            <option value="">Tous</option>
            {invoiceStatuses.map((value) => (
              <option key={value} value={value}>
                {invoiceStatusLabels[value]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="nature" className="block text-xs font-medium text-muted-foreground">
            Nature
          </label>
          <select id="nature" name="nature" defaultValue={kind ?? ''} className={fieldClass}>
            <option value="">Factures et avoirs</option>
            {invoiceKinds.map((value) => (
              <option key={value} value={value}>
                {invoiceKindLabels[value]}
              </option>
            ))}
          </select>
        </div>
        <div className="min-w-48">
          <label htmlFor="client" className="block text-xs font-medium text-muted-foreground">
            Client
          </label>
          <select id="client" name="client" defaultValue={clientId ?? ''} className={fieldClass}>
            <option value="">Tous les clients</option>
            {clients.map((client) => (
              <option key={client.id} value={client.id}>
                {client.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="mois" className="block text-xs font-medium text-muted-foreground">
            Période facturée
          </label>
          <input id="mois" name="mois" type="month" defaultValue={month ?? ''} className={fieldClass} />
        </div>
        <button
          type="submit"
          className="rounded-md border border-border bg-white px-3 py-1.5 text-sm font-medium hover:bg-muted"
        >
          Filtrer
        </button>
        {filtered && (
          <Link href="/factures" className="px-1 py-1.5 text-sm text-muted-foreground underline underline-offset-2">
            Tout afficher
          </Link>
        )}
      </form>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-white px-6 py-12 text-center">
          <p className="text-sm text-muted-foreground">
            {filtered ? 'Aucune facture ne correspond à ces filtres.' : 'Aucune facture pour l’instant.'}
          </p>
          {canManage ? (
            <Link
              href="/factures/preparer"
              className="mt-4 inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover"
            >
              Préparer la facturation du mois
            </Link>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">
              La préparation et l’émission des factures sont réservées à l’exploitant.
            </p>
          )}
        </div>
      ) : canManage && draftCount > 0 ? (
        <BulkIssueForm draftCount={draftCount}>{table}</BulkIssueForm>
      ) : (
        table
      )}

      {rows.length >= INVOICE_LIST_LIMIT && (
        <p className="text-sm text-muted-foreground">
          Seules les {INVOICE_LIST_LIMIT} premières factures sont affichées : filtrez par client ou
          par période pour voir les autres.
        </p>
      )}
    </div>
  )
}
