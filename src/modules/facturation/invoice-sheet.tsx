import { formatCalendarDate } from '../../lib/dates.ts'
import {
  formatIban,
  type DocumentBuyer,
  type DocumentSeller,
  type InvoiceDocument,
} from './factures-document.ts'
import {
  formatBasisPoints,
  formatProrata,
  paymentMethodLabels,
  vatCategoryLabels,
} from './factures-labels.ts'
import { rateUnitSuffixes } from './labels.ts'
import { amountDueCents } from './montants.ts'
import { formatPeriod } from './periodes.ts'
import type { Invoice, InvoiceLine } from './schema-factures.ts'
import { formatCents } from './tarifs.ts'

/**
 * Feuille d'une facture ou d'un avoir (R13, R17, ADR 026) : la même vue pour
 * l'équipe (`/factures/[id]/document`) et pour le client (`/compte/factures/[id]`).
 * Le PDF n'est que cette vue, imprimée par le navigateur.
 *
 * Une facture émise se lit dans ses instantanés (`invoiceDocument()`) ; un
 * brouillon, dans les fiches du jour, et le dit — il n'atteint jamais l'espace
 * client.
 *
 * Le document n'utilise ni `<header>` ni `<nav>`, que la feuille d'impression
 * du back-office masque.
 */

/** Règles d'impression de la feuille, communes aux deux espaces. */
export const invoiceSheetPrintStyles = `
@media print {
  @page { size: A4; margin: 14mm 12mm; }
  .invoice-sheet { box-shadow: none !important; border: 0 !important; padding: 0 !important; max-width: none !important; }
  .invoice-sheet tr, .invoice-sheet .keep { break-inside: avoid; }
}
`

const dayLabel = formatCalendarDate

function Address({ party }: { party: DocumentSeller | DocumentBuyer }) {
  return (
    <>
      {party.addressLine1 && <span className="block">{party.addressLine1}</span>}
      {party.addressLine2 && <span className="block">{party.addressLine2}</span>}
      {(party.postalCode || party.city) && (
        <span className="block">
          {party.postalCode} {party.city}
        </span>
      )}
      {party.country !== 'FR' && <span className="block">{party.country}</span>}
    </>
  )
}

export function InvoiceSheet({
  invoice,
  lines,
  sheet,
  sellerFallbackName,
  originalIssueDate,
}: {
  invoice: Invoice
  lines: readonly InvoiceLine[]
  sheet: InvoiceDocument
  /** Nom affiché quand le vendeur n'a pas de raison sociale (brouillon d'un centre incomplet). */
  sellerFallbackName: string
  /** Pour un avoir : la date d'émission de la facture corrigée. */
  originalIssueDate: string | null
}) {
  const { seller, buyer, mentions } = sheet
  const isCreditNote = invoice.kind === 'credit_note'
  const money = (cents: number) => formatCents(cents, invoice.currency)
  const kindTitle = isCreditNote ? 'Avoir' : 'Facture'
  const hasDiscount = lines.some((line) => line.discountBp !== null || line.discountAmountCents !== null)
  const hasProrata = lines.some((line) => line.prorataNumerator !== null)

  return (
    <article
      aria-label={`${kindTitle} ${invoice.number ?? 'brouillon'}`}
      className="invoice-sheet mx-auto w-full max-w-[210mm] rounded-lg border border-border bg-white px-4 py-6 text-sm text-foreground shadow-sm sm:px-10 sm:py-10"
    >
      {sheet.isDraft && (
        <p className="keep mb-6 rounded-md border-2 border-dashed border-primary px-4 py-2 text-center font-semibold text-primary">
          Brouillon — sans valeur de facture : ni numéro ni date d’émission.
        </p>
      )}

      <div className="keep flex flex-wrap items-start justify-between gap-6">
        <div className="sm:max-w-[55%]">
          <p className="text-base font-semibold text-primary">{seller.legalName ?? sellerFallbackName}</p>
          <p className="mt-1 text-muted-foreground">
            <Address party={seller} />
            {seller.phone && <span className="block">{seller.phone}</span>}
            {seller.email && <span className="block break-words">{seller.email}</span>}
          </p>
        </div>
        <div className="sm:text-right">
          <h1 className="text-2xl font-semibold tracking-tight text-primary">{kindTitle}</h1>
          <dl className="mt-2 grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 sm:justify-end">
            <dt className="text-muted-foreground">Numéro</dt>
            <dd className="font-medium tabular">{invoice.number ?? '—'}</dd>
            <dt className="text-muted-foreground">Date d’émission</dt>
            <dd className="tabular">{invoice.issueDate ? dayLabel(invoice.issueDate) : '—'}</dd>
            {!isCreditNote && (
              <>
                <dt className="text-muted-foreground">Échéance</dt>
                <dd className="tabular">
                  {invoice.dueDate ? dayLabel(invoice.dueDate) : `${mentions.paymentTermsDays} jours après émission`}
                </dd>
              </>
            )}
            {invoice.buyerReference && (
              <>
                <dt className="text-muted-foreground">Votre référence</dt>
                <dd>{invoice.buyerReference}</dd>
              </>
            )}
          </dl>
        </div>
      </div>

      <div className="keep mt-8 flex flex-wrap justify-between gap-6">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Période</p>
          <p className="mt-1">Prestations {formatPeriod(invoice.periodStart, invoice.periodEnd)}</p>
          {isCreditNote && mentions.creditedInvoiceNumber && (
            <p className="mt-2">
              Avoir sur la facture <span className="font-medium tabular">{mentions.creditedInvoiceNumber}</span>
              {originalIssueDate && ` du ${dayLabel(originalIssueDate)}`}
            </p>
          )}
          {invoice.notes && (
            <p className="mt-2 whitespace-pre-line">
              {isCreditNote ? 'Motif : ' : ''}
              {invoice.notes}
            </p>
          )}
        </div>
        <div className="w-full rounded-md border border-border px-4 py-3 sm:w-auto sm:min-w-[45%]">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Client</p>
          <p className="mt-1 font-medium">
            {buyer.name}
            {buyer.legalForm && ` (${buyer.legalForm})`}
          </p>
          <p>
            <Address party={buyer} />
          </p>
          {(buyer.siren || buyer.siret) && (
            <p className="mt-1 text-xs text-muted-foreground">
              {buyer.siren && `SIREN ${buyer.siren}`}
              {buyer.siret && ` · SIRET ${buyer.siret}`}
            </p>
          )}
          {buyer.vatNumber && <p className="text-xs text-muted-foreground">TVA intracommunautaire {buyer.vatNumber}</p>}
        </div>
      </div>

      {/* Sur un téléphone, le tableau défile seul : la page, jamais. */}
      <div className="mt-8 overflow-x-auto">
        <table className="w-full text-left">
          <caption className="sr-only">Détail des prestations</caption>
          <thead className="border-b-2 border-primary text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th scope="col" className="py-2 pr-2 font-medium">Désignation</th>
              <th scope="col" className="px-2 py-2 text-right font-medium">Qté</th>
              <th scope="col" className="px-2 py-2 text-right font-medium">PU HT</th>
              {hasDiscount && <th scope="col" className="px-2 py-2 text-right font-medium">Remise</th>}
              {hasProrata && <th scope="col" className="px-2 py-2 text-right font-medium">Prorata</th>}
              <th scope="col" className="px-2 py-2 text-right font-medium">TVA</th>
              <th scope="col" className="py-2 pl-2 text-right font-medium">Montant HT</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {lines.map((line) => (
              <tr key={line.id} className="align-top">
                <td className="min-w-40 py-2 pr-2">
                  {line.description}
                  {line.periodStart && line.periodEnd && (
                    <span className="block text-xs text-muted-foreground">
                      {formatPeriod(line.periodStart, line.periodEnd)}
                    </span>
                  )}
                </td>
                <td className="whitespace-nowrap px-2 py-2 text-right tabular">
                  {line.quantity}
                  {line.unit && line.unit !== 'unit' && (
                    <span className="block text-xs text-muted-foreground">{rateUnitSuffixes[line.unit]}</span>
                  )}
                </td>
                <td className="whitespace-nowrap px-2 py-2 text-right tabular">{money(line.unitPriceCents)}</td>
                {hasDiscount && (
                  <td className="whitespace-nowrap px-2 py-2 text-right tabular">
                    {line.discountBp !== null
                      ? formatBasisPoints(line.discountBp)
                      : line.discountAmountCents !== null
                        ? money(line.discountAmountCents)
                        : ''}
                  </td>
                )}
                {hasProrata && (
                  <td className="px-2 py-2 text-right tabular">
                    {formatProrata(line.prorataNumerator, line.prorataDenominator) ?? ''}
                  </td>
                )}
                <td className="whitespace-nowrap px-2 py-2 text-right tabular">
                  {line.vatCategory === 'S' ? formatBasisPoints(line.vatRateBp) : line.vatCategory}
                </td>
                <td className="whitespace-nowrap py-2 pl-2 text-right tabular">{money(line.netAmountCents ?? 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="keep mt-6 flex flex-wrap items-start justify-between gap-6">
        <table className="text-left text-xs">
          <caption className="pb-1 text-left font-medium uppercase tracking-wide text-muted-foreground">
            TVA par taux
          </caption>
          <thead className="text-muted-foreground">
            <tr>
              <th scope="col" className="py-1 pr-4 font-medium">Taux</th>
              <th scope="col" className="py-1 pr-4 text-right font-medium">Base HT</th>
              <th scope="col" className="py-1 text-right font-medium">TVA</th>
            </tr>
          </thead>
          <tbody>
            {sheet.vatBreakdown.map((row) => (
              <tr key={`${row.vatCategory}-${row.vatRateBp}`}>
                <td className="py-0.5 pr-4">
                  {row.vatCategory === 'S'
                    ? formatBasisPoints(row.vatRateBp)
                    : `${vatCategoryLabels[row.vatCategory]}${row.exemptionReason ? ` — ${row.exemptionReason}` : ''}`}
                </td>
                <td className="py-0.5 pr-4 text-right tabular">{money(row.taxableAmountCents)}</td>
                <td className="py-0.5 text-right tabular">{money(row.vatAmountCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <dl className="grid w-full grid-cols-[1fr_auto] gap-x-6 gap-y-1 sm:w-auto sm:min-w-[40%]">
          <dt>Total HT</dt>
          <dd className="text-right tabular">{money(invoice.totalExclTaxCents)}</dd>
          <dt>Total TVA</dt>
          <dd className="text-right tabular">{money(invoice.totalTaxCents)}</dd>
          <dt className="border-t border-primary pt-1 font-semibold">Total TTC</dt>
          <dd className="border-t border-primary pt-1 text-right font-semibold tabular">
            {money(invoice.totalInclTaxCents)}
          </dd>
          {!isCreditNote && !sheet.isDraft && (invoice.paidCents !== 0 || invoice.creditedCents !== 0) && (
            <>
              {invoice.creditedCents !== 0 && (
                <>
                  <dt className="text-muted-foreground">Avoirs</dt>
                  <dd className="text-right tabular text-muted-foreground">− {money(invoice.creditedCents)}</dd>
                </>
              )}
              {invoice.paidCents !== 0 && (
                <>
                  <dt className="text-muted-foreground">Déjà réglé</dt>
                  <dd className="text-right tabular text-muted-foreground">− {money(invoice.paidCents)}</dd>
                </>
              )}
              <dt className="font-semibold">Net à payer</dt>
              <dd className="text-right font-semibold tabular">{money(amountDueCents(invoice))}</dd>
            </>
          )}
        </dl>
      </div>

      {!isCreditNote && (
        <div className="keep mt-8 rounded-md border border-border px-4 py-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Règlement</p>
          <p className="mt-1">
            {paymentMethodLabels[sheet.paymentMethod]}
            {invoice.dueDate ? `, au plus tard le ${dayLabel(invoice.dueDate)}` : ''}.
          </p>
          {sheet.paymentMethod === 'transfer' && seller.bankIban && (
            <p className="mt-1 tabular">
              IBAN {formatIban(seller.bankIban)}
              {seller.bankBic && ` · BIC ${seller.bankBic}`}
              {invoice.number && ` · Libellé : ${invoice.number}`}
            </p>
          )}
          {sheet.paymentMethod === 'direct_debit' && (
            <p className="mt-1">
              Prélèvement SEPA{sheet.mandateReference && ` sur le mandat ${sheet.mandateReference}`}
              {seller.sepaCreditorId && `, créancier ${seller.sepaCreditorId}`}.
            </p>
          )}
        </div>
      )}

      <div className="keep mt-6 flex flex-col gap-1 text-xs text-muted-foreground">
        {!isCreditNote && (
          <>
            <p>{mentions.latePaymentPenaltyText}</p>
            <p>
              Indemnité forfaitaire pour frais de recouvrement en cas de retard de paiement :{' '}
              {formatCents(mentions.recoveryIndemnityCents, 'EUR')} (art. L. 441-10 et D. 441-5 du Code de
              commerce).
            </p>
            <p>{mentions.earlyPaymentDiscountText}</p>
          </>
        )}
        <p>Opération : prestations de services.</p>
        {mentions.vatOnDebits && <p>TVA acquittée d’après les débits.</p>}
        {mentions.footerText && <p className="whitespace-pre-line">{mentions.footerText}</p>}
      </div>

      <p className="keep mt-8 border-t border-border pt-3 text-center text-xs text-muted-foreground">
        {[
          seller.legalName,
          seller.legalForm &&
            `${seller.legalForm}${seller.shareCapitalCents !== null ? ` au capital de ${formatCents(seller.shareCapitalCents, 'EUR')}` : ''}`,
          seller.rcsCity && seller.siren && `RCS ${seller.rcsCity} ${seller.siren}`,
          seller.siren && !seller.rcsCity && `SIREN ${seller.siren}`,
          seller.siret && `SIRET ${seller.siret}`,
          seller.vatNumber && `TVA intracommunautaire ${seller.vatNumber}`,
        ]
          .filter(Boolean)
          .join(' · ')}
      </p>
    </article>
  )
}
