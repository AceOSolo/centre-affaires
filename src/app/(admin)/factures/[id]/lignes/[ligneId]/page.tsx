import Link from 'next/link'
import { notFound } from 'next/navigation'

import { requirePermission } from '../../../../../../lib/auth/staff.ts'
import { isUuid } from '../../../../../../lib/uuid.ts'
import { centsToAmountInput } from '../../../../../../modules/facturation/factures-formulaire.ts'
import { LineEditForm } from '../../../../../../modules/facturation/factures-forms.tsx'
import { invoiceLineKindLabels } from '../../../../../../modules/facturation/factures-labels.ts'
import { findInvoiceLine, linePriceEditable } from '../../../../../../modules/facturation/factures-queries.ts'
import { formatPeriod } from '../../../../../../modules/facturation/periodes.ts'

export const metadata = { title: 'Modifier une ligne' }

/**
 * Modification d'une ligne de brouillon (R13) : désignation et quantité ; le
 * prix d'une ligne saisie à la main ou d'une ligne d'avoir. Une ligne tirée
 * d'une source garde le prix de sa source.
 */
export default async function InvoiceLinePage({
  params,
}: {
  params: Promise<{ id: string; ligneId: string }>
}) {
  await requirePermission('facturation.gerer')
  const { id, ligneId } = await params
  if (!isUuid(id) || !isUuid(ligneId)) notFound()
  const found = await findInvoiceLine(id, ligneId)
  if (!found || found.invoice.deletedAt) notFound()
  const { invoice, line } = found
  const isCreditNote = invoice.kind === 'credit_note'
  const priceEditable = linePriceEditable(invoice, line)

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href={`/factures/${invoice.id}#lignes`} className="text-sm text-muted-foreground hover:underline">
          ← {isCreditNote ? 'Brouillon d’avoir' : 'Brouillon de facture'}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Modifier une ligne</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          {invoiceLineKindLabels[line.kind]}
          {line.periodStart && line.periodEnd && ` · ${formatPeriod(line.periodStart, line.periodEnd)}`}
          {line.creditedLineDescription && ` · crédite « ${line.creditedLineDescription} »`}.{' '}
          {priceEditable
            ? isCreditNote
              ? 'Réduisez la quantité ou le prix pour un avoir partiel : une ligne ne se crédite pas au-delà de son montant.'
              : 'Ligne saisie à la main : son prix se modifie.'
            : 'Le prix vient de la source (contrat, réservation, forfait, acte) : pour ne pas la facturer, retirez la ligne.'}
        </p>
      </div>

      {invoice.status !== 'draft' ? (
        <p className="rounded-md border border-border bg-muted px-4 py-3 text-sm">
          {isCreditNote ? 'Cet avoir est émis' : `La facture ${invoice.number} est émise`} : ses lignes ne
          se modifient plus.{' '}
          {!isCreditNote && 'Toute correction passe par un avoir.'}{' '}
          <Link href={`/factures/${invoice.id}`} className="underline underline-offset-2">
            Revenir à la fiche
          </Link>
        </p>
      ) : (
        <LineEditForm
          priceEditable={priceEditable}
          exemptionEditable={line.vatCategory !== 'S'}
          line={{
            id: invoice.id,
            lineId: line.id,
            description: line.description,
            quantity: String(line.quantity),
            unitPrice: centsToAmountInput(line.unitPriceCents),
            vatExemptionReason: line.vatExemptionReason ?? '',
          }}
        />
      )}
    </div>
  )
}
