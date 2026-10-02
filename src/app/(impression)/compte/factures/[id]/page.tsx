import Link from 'next/link'
import { notFound } from 'next/navigation'

import { currentTenant } from '../../../../../lib/tenant.ts'
import { requireClientAccount } from '../../../../../modules/clients/session.ts'
import { findInvoiceForAccounts } from '../../../../../modules/facturation/compte-queries.ts'
import { invoiceDocument } from '../../../../../modules/facturation/factures-document.ts'
import { InvoiceSheet, invoiceSheetPrintStyles } from '../../../../../modules/facturation/invoice-sheet.tsx'
import { PrintButton } from '../../../../../modules/facturation/print-button.tsx'

export const metadata = { title: 'Facture' }

/** Rien n'est prérendu : la facture dépend de la session (ADR 015). */
export const dynamic = 'force-dynamic'

/**
 * Une facture ou un avoir, vu depuis l'espace client (R17) : la feuille du
 * back-office, à l'identique (`InvoiceSheet`), hors de la coque du site pour
 * que le navigateur l'imprime ou l'enregistre en PDF sans rien d'autre.
 *
 * Même réponse pour « n'existe pas », « brouillon » et « pas à vous » : les
 * distinguer renseignerait sur les factures des autres entreprises.
 */
export default async function ClientInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  // Revérifié ici : cette page n'est pas sous la coque de l'espace client.
  const { accounts } = await requireClientAccount()
  const { id } = await params
  const [detail, tenant] = await Promise.all([findInvoiceForAccounts(id, accounts), currentTenant()])
  if (!detail) notFound()

  const { invoice, lines } = detail
  const sheet = invoiceDocument(invoice, lines, {
    tenant,
    client: detail.client,
    creditedInvoiceNumber: detail.original?.number ?? null,
  })

  return (
    <main
      id="contenu"
      className="min-h-screen bg-muted px-4 py-6 font-sans text-foreground sm:py-8 print:bg-white print:p-0"
    >
      <style>{invoiceSheetPrintStyles}</style>
      <div className="mx-auto mb-6 flex w-full max-w-[210mm] flex-wrap items-center justify-between gap-3 print:hidden">
        <Link
          href="/compte/factures"
          className="inline-flex min-h-11 items-center rounded-md px-1 text-sm font-medium text-primary underline-offset-4 hover:underline"
        >
          ← Mes factures
        </Link>
        <PrintButton
          label="Imprimer ou enregistrer en PDF"
          className="inline-flex min-h-11 items-center justify-center rounded-md border border-border bg-white px-5 text-sm font-medium text-foreground transition-colors hover:bg-background focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent print:hidden"
        />
      </div>
      <InvoiceSheet
        invoice={invoice}
        lines={lines}
        sheet={sheet}
        sellerFallbackName={tenant.name}
        originalIssueDate={detail.original?.issueDate ?? null}
      />
    </main>
  )
}
