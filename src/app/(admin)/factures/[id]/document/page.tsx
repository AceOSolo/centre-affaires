import Link from 'next/link'
import { notFound } from 'next/navigation'

import { requirePermission } from '../../../../../lib/auth/staff.ts'
import { currentTenant } from '../../../../../lib/tenant.ts'
import { isUuid } from '../../../../../lib/uuid.ts'
import { invoiceDocument } from '../../../../../modules/facturation/factures-document.ts'
import { findInvoice } from '../../../../../modules/facturation/factures-queries.ts'
import { InvoiceSheet, invoiceSheetPrintStyles } from '../../../../../modules/facturation/invoice-sheet.tsx'
import { PrintButton } from '../../../../../modules/facturation/print-button.tsx'

export const metadata = { title: 'Facture — vue imprimable' }

/*
 * Feuille d'impression : la coque du back-office (en-tête, navigation) et la
 * barre d'outils disparaissent, la facture occupe la page A4. Le document
 * lui-même n'utilise ni <header> ni <nav>, que ces règles masquent. Les règles
 * de la feuille elle-même sont partagées avec l'espace client
 * (`invoice-sheet.tsx`).
 */
const printStyles = `
@media print {
  html, body, body > div { background: #fff !important; }
  body header, body nav, .no-print { display: none !important; }
  main { max-width: none !important; padding: 0 !important; margin: 0 !important; }
}
${invoiceSheetPrintStyles}`

/**
 * Vue imprimable d'une facture ou d'un avoir (R13, ADR 026) : le PDF n'est
 * qu'une vue des données structurées, imprimée par le navigateur. Une facture
 * émise se lit dans ses instantanés, figés à l'émission ; un brouillon, dans
 * les fiches du jour, et le dit. Le client voit la même feuille dans son
 * espace (R17, `/compte/factures/[id]`).
 */
export default async function InvoiceDocumentPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission('facturation.consulter')
  const { id } = await params
  if (!isUuid(id)) notFound()
  const [detail, tenant] = await Promise.all([findInvoice(id), currentTenant()])
  if (!detail || detail.invoice.deletedAt) notFound()

  const { invoice, lines } = detail
  const sheet = invoiceDocument(invoice, lines, {
    tenant,
    client: detail.client,
    creditedInvoiceNumber: detail.original?.number ?? null,
  })

  return (
    <div className="flex flex-col gap-4">
      <style>{printStyles}</style>

      <div className="no-print flex flex-wrap items-center justify-between gap-3">
        <Link href={`/factures/${invoice.id}`} className="text-sm text-muted-foreground hover:underline">
          ← Retour à la fiche
        </Link>
        <PrintButton label="Imprimer ou enregistrer en PDF" />
      </div>

      <InvoiceSheet
        invoice={invoice}
        lines={lines}
        sheet={sheet}
        sellerFallbackName={tenant.name}
        originalIssueDate={detail.original?.issueDate ?? null}
      />
    </div>
  )
}
