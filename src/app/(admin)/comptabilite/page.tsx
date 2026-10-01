import Link from 'next/link'

import { FlashNotice } from '../../../components/ui/flash-notice.tsx'
import { requirePermission } from '../../../lib/auth/staff.ts'
import { addMonthsToIsoMonth, formatDateTime, todayIsoDate } from '../../../lib/dates.ts'
import { currentTenant } from '../../../lib/tenant.ts'
import { isUuid } from '../../../lib/uuid.ts'
import { AccountingAccountRow } from '../../../modules/facturation/accounting-account-form.tsx'
import { ClientCodesForm } from '../../../modules/facturation/client-codes-form.tsx'
import {
  lineKindAccountLabels,
  listAccountingAccounts,
  listAccountingExports,
  listInvoicedClientCodes,
} from '../../../modules/facturation/comptabilite.ts'
import { formatRate } from '../../../modules/facturation/fec.ts'
import { FecExportForm } from '../../../modules/facturation/fec-export-form.tsx'
import { formatIsoDateFr } from '../../../modules/facturation/paiements-regles.ts'
import type { AccountingAccount } from '../../../modules/facturation/schema-factures.ts'

export const metadata = { title: 'Export comptable' }

function accountRole(account: AccountingAccount): string {
  switch (account.purpose) {
    case 'customers':
      return 'Clients (collectif)'
    case 'bank':
      return 'Banque'
    case 'revenue':
      return account.lineKind ? lineKindAccountLabels[account.lineKind] : 'Ventes'
    default:
      return `TVA collectée à ${formatRate(account.vatRateBp ?? 0)} %`
  }
}

/**
 * Export comptable (R16, ADR 027, ADR 030) : les écritures d'une période au
 * format du fichier des écritures comptables, le journal des fichiers remis
 * avec leur empreinte, et le plan de comptes du centre.
 */
export default async function AccountingPage({ searchParams }: { searchParams: Promise<{ export?: string }> }) {
  await requirePermission('comptabilite.exporter')
  const [{ export: exportId }, tenant] = await Promise.all([searchParams, currentTenant()])
  const today = todayIsoDate(tenant.timezone)
  // Par défaut, le mois écoulé : l'expert-comptable reçoit les écritures du mois.
  const defaultStart = `${addMonthsToIsoMonth(today.slice(0, 7), -1)}-01`
  const defaultEnd = endOfPreviousMonth(`${today.slice(0, 7)}-01`)
  const [exports, accounts, clientCodes] = await Promise.all([
    listAccountingExports(),
    listAccountingAccounts(),
    listInvoicedClientCodes(),
  ])
  const generated = isUuid(exportId) ? exports.find((row) => row.id === exportId) : undefined

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <Link href="/paiements" className="text-sm text-muted-foreground hover:underline">
          ← Règlements
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Export comptable</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Les écritures d’une période pour l’expert-comptable, au format du fichier des écritures
          comptables (FEC : 18 colonnes séparées par des tabulations) : journal des ventes{' '}
          <span className="tabular">{tenant.accountingSalesJournal}</span> pour les factures et avoirs
          émis, journal de banque <span className="tabular">{tenant.accountingBankJournal}</span> pour les
          paiements pointés. Le plan de comptes et les journaux sont à valider avec lui.
        </p>
      </div>

      {generated && (
        <FlashNotice key={generated.id}>
          Export généré : {generated.entryCount} lignes d’écriture, débit et crédit équilibrés.{' '}
          <a href={`/comptabilite/exports/${generated.id}`} className="font-medium text-primary underline underline-offset-2">
            Télécharger {generated.fileName}
          </a>
        </FlashNotice>
      )}

      <section aria-labelledby="export-titre" className="flex flex-col gap-3">
        <h2 id="export-titre" className="text-sm font-semibold tracking-tight">
          Nouvel export
        </h2>
        <div className="rounded-lg border border-border bg-white px-5 py-4">
          <FecExportForm defaultStart={defaultStart} defaultEnd={defaultEnd} />
        </div>
      </section>

      <section id="journal" aria-labelledby="journal-titre" className="flex flex-col gap-3">
        <h2 id="journal-titre" className="text-sm font-semibold tracking-tight">
          Journal des exports <span className="font-normal text-muted-foreground">({exports.length})</span>
        </h2>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Chaque fichier remis, avec son empreinte SHA-256. Au téléchargement, le fichier est reconstruit
          et comparé à l’empreinte : si les données de la période ont changé depuis (un paiement annulé,
          un compte corrigé), il faut générer un nouvel export et le signaler à l’expert-comptable.
        </p>
        {exports.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border bg-white px-5 py-4 text-sm text-muted-foreground">
            Aucun export pour l’instant : choisissez une période ci-dessus et générez le premier.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-white">
            <table aria-labelledby="journal-titre" className="w-full text-left text-sm">
              <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Période</th>
                  <th scope="col" className="px-4 py-3 font-medium">Fichier</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Lignes</th>
                  <th scope="col" className="px-4 py-3 font-medium">Empreinte SHA-256</th>
                  <th scope="col" className="px-4 py-3 font-medium">Généré</th>
                  <th scope="col" className="px-4 py-3">
                    <span className="sr-only">Téléchargement</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {exports.map((row) => (
                  <tr key={row.id}>
                    <td className="whitespace-nowrap px-4 py-3 tabular">
                      {formatIsoDateFr(row.periodStart)} → {formatIsoDateFr(row.periodEnd)}
                    </td>
                    <td className="px-4 py-3">{row.fileName}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-right tabular">{row.entryCount}</td>
                    <td className="px-4 py-3">
                      <span className="break-all text-xs tabular" title={row.fileSha256}>
                        {row.fileSha256.slice(0, 16)}…
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {row.generatedByName}
                      <span className="block text-xs text-muted-foreground">
                        {formatDateTime(row.createdAt, tenant.timezone)}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right">
                      <a
                        href={`/comptabilite/exports/${row.id}`}
                        aria-label={`Télécharger ${row.fileName}, généré le ${formatDateTime(row.createdAt, tenant.timezone)}`}
                        className="inline-block rounded-md border border-border px-3 py-1 text-xs font-medium hover:bg-muted"
                      >
                        Télécharger
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="plan-titre" className="flex flex-col gap-3">
        <h2 id="plan-titre" className="text-sm font-semibold tracking-tight">
          Plan de comptes
        </h2>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Les comptes du plan comptable général posés par défaut, à valider par l’expert-comptable. Un
          taux de TVA sans compte fait refuser l’export plutôt que d’improviser.
        </p>
        <div className="overflow-x-auto rounded-lg border border-border bg-white">
          <table aria-labelledby="plan-titre" className="w-full text-left text-sm">
            <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">Rôle</th>
                <th scope="col" className="px-4 py-3 font-medium">Compte</th>
                <th scope="col" className="px-4 py-3 font-medium">Libellé</th>
                <th scope="col" className="px-4 py-3">
                  <span className="sr-only">Enregistrer</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {accounts.map((account) => (
                <AccountingAccountRow
                  key={account.id}
                  id={account.id}
                  role={accountRole(account)}
                  accountNumber={account.accountNumber}
                  label={account.label}
                />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="auxiliaires-titre" className="flex flex-col gap-3">
        <h2 id="auxiliaires-titre" className="text-sm font-semibold tracking-tight">
          Comptes auxiliaires des clients
        </h2>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Le compte de chaque client sous le collectif {accounts.find((a) => a.purpose === 'customers')?.accountNumber ?? '411'}.
          Sans compte fixé, l’export le dérive de la raison sociale ; le fixer évite qu’un changement de
          nom le change chez l’expert-comptable.
        </p>
        <ClientCodesForm rows={clientCodes} />
      </section>
    </div>
  )
}

/** Dernier jour du mois qui précède `firstOfMonth` (« 2026-10-01 » donne « 2026-09-30 »). */
function endOfPreviousMonth(firstOfMonth: string): string {
  const [year, month] = firstOfMonth.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, 0)).toISOString().slice(0, 10)
}
