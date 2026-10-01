import Link from 'next/link'

import { formatDateTime } from '../../lib/dates.ts'
import { CancelPaymentButton } from './cancel-payment-button.tsx'
import { maskIban } from './iban.ts'
import { amountDueCents } from './montants.ts'
import { formatIsoDateFr } from './paiements-regles.ts'
import { PaymentForm } from './payment-form.tsx'
import type { InvoiceSettlement } from './reglements.ts'
import {
  paymentMethodLabels,
  sepaMandateStatusLabels,
  settlementStatusLabels,
  settlementStatusStyles,
} from './reglements-labels.ts'
import { formatCents } from './tarifs.ts'

/**
 * Règlement d'une facture (R16, ADR 027) : où elle en est, les paiements
 * pointés — annulés compris, avec leur motif —, et le pointage d'un nouveau
 * paiement. Conçu pour la fiche facture : il ne dépend que de
 * `findInvoiceSettlement`.
 */
export function SettlementSection({
  settlement,
  canManage,
  today,
  timeZone,
}: {
  settlement: InvoiceSettlement
  /** Droit `paiements.gerer` : pointer et annuler. */
  canManage: boolean
  today: string
  timeZone: string
}) {
  const { invoice, payments, mandate } = settlement
  const currency = invoice.currency
  const due = amountDueCents(invoice)
  const isCreditNote = invoice.kind === 'credit_note'
  const isDraft = invoice.status === 'draft'

  return (
    <section aria-labelledby="reglement-titre" className="flex flex-col gap-4">
      <h2 id="reglement-titre" className="text-lg font-semibold tracking-tight">
        Règlement
      </h2>

      {isDraft ? (
        <p className="rounded-lg border border-dashed border-border bg-white px-5 py-4 text-sm text-muted-foreground">
          Brouillon : un paiement se pointe sur une facture émise. Émettez-la d’abord.
        </p>
      ) : isCreditNote ? (
        <p className="rounded-lg border border-dashed border-border bg-white px-5 py-4 text-sm text-muted-foreground">
          Un avoir ne se paie pas : il vient en déduction de la facture qu’il corrige. Un
          remboursement au client se pointe sur cette facture, comme « Remboursement au client ».
          {settlement.precedingInvoice && (
            <>
              {' '}
              <Link
                href={`/paiements/factures/${settlement.precedingInvoice.id}`}
                className="font-medium text-primary underline underline-offset-2"
              >
                Règlement de la facture {settlement.precedingInvoice.number}
              </Link>
            </>
          )}
        </p>
      ) : (
        <dl className="grid grid-cols-[minmax(9rem,auto)_1fr] gap-x-6 gap-y-2 rounded-lg border border-border bg-white px-5 py-4 text-sm sm:grid-cols-[minmax(9rem,auto)_1fr_minmax(9rem,auto)_1fr]">
          <dt className="text-muted-foreground">État</dt>
          <dd>
            {/* L'état se lit au libellé ; la teinte l'accompagne. */}
            <span
              className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${settlementStatusStyles[invoice.status]}`}
            >
              {settlementStatusLabels[invoice.status]}
            </span>
          </dd>
          <dt className="text-muted-foreground">Échéance</dt>
          <dd className="tabular">
            {invoice.dueDate ? formatIsoDateFr(invoice.dueDate) : '—'}
            {invoice.dueDate && due > 0 && invoice.dueDate < today && (
              <span className="ml-2 text-xs font-medium text-foreground">(échue)</span>
            )}
          </dd>
          <dt className="text-muted-foreground">Total TTC</dt>
          <dd className="tabular">{formatCents(invoice.totalInclTaxCents, currency)}</dd>
          <dt className="text-muted-foreground">Avoirs</dt>
          <dd className="tabular">{formatCents(invoice.creditedCents, currency)}</dd>
          <dt className="text-muted-foreground">Payé</dt>
          <dd className="tabular">{formatCents(invoice.paidCents, currency)}</dd>
          <dt className="text-muted-foreground">{due < 0 ? 'Trop-perçu' : 'Reste dû'}</dt>
          <dd className="font-semibold tabular">
            {formatCents(Math.abs(due), currency)}
            {due < 0 && (
              <span className="ml-2 text-xs font-normal text-muted-foreground">à rembourser au client</span>
            )}
          </dd>
          <dt className="text-muted-foreground">Mode attendu</dt>
          <dd>
            {paymentMethodLabels[invoice.expectedPaymentMethod]}
            {mandate && (
              <span className="block text-xs text-muted-foreground">
                Mandat {mandate.reference} · {maskIban(mandate.ibanLast4)} ·{' '}
                {sepaMandateStatusLabels[mandate.status].toLowerCase()}
              </span>
            )}
          </dd>
        </dl>
      )}

      {!isDraft && !isCreditNote && (
        <div className="flex flex-col gap-2">
          <h3 id="paiements-titre" className="text-sm font-semibold">
            Paiements pointés <span className="font-normal text-muted-foreground">({payments.length})</span>
          </h3>
          {payments.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Aucun paiement pointé.{' '}
              {canManage
                ? 'Quand le virement ou le prélèvement apparaît sur le relevé, pointez-le ci-dessous.'
                : 'L’exploitant pointe les paiements à leur arrivée sur le relevé.'}
            </p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border bg-white">
              <table aria-labelledby="paiements-titre" className="w-full text-left text-sm">
                <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-4 py-3 font-medium">Date de valeur</th>
                    <th scope="col" className="px-4 py-3 text-right font-medium">Montant</th>
                    <th scope="col" className="px-4 py-3 font-medium">Mode</th>
                    <th scope="col" className="px-4 py-3 font-medium">Référence</th>
                    <th scope="col" className="px-4 py-3 font-medium">Pointé par</th>
                    <th scope="col" className="px-4 py-3 font-medium">État</th>
                    {canManage && (
                      <th scope="col" className="px-4 py-3">
                        <span className="sr-only">Actions</span>
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {payments.map((payment) => {
                    const cancelled = payment.cancelledAt !== null
                    const label = `${payment.amountCents < 0 ? 'remboursement' : 'paiement'} de ${formatCents(Math.abs(payment.amountCents), payment.currency)} du ${formatIsoDateFr(payment.paidOn)}`
                    return (
                      <tr key={payment.id} className={cancelled ? 'text-muted-foreground' : undefined}>
                        <td className="whitespace-nowrap px-4 py-3 tabular">{formatIsoDateFr(payment.paidOn)}</td>
                        <td className={`whitespace-nowrap px-4 py-3 text-right tabular ${cancelled ? 'line-through' : ''}`}>
                          {formatCents(payment.amountCents, payment.currency)}
                          {payment.amountCents < 0 && <span className="block text-xs">remboursement</span>}
                        </td>
                        <td className="px-4 py-3">{paymentMethodLabels[payment.method]}</td>
                        <td className="px-4 py-3">
                          {payment.reference ?? '—'}
                          {payment.notes && (
                            <span className="block whitespace-pre-line text-xs text-muted-foreground">{payment.notes}</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {payment.recordedByName}
                          <span className="block text-xs text-muted-foreground">
                            {formatDateTime(payment.createdAt, timeZone)}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          {cancelled ? (
                            <>
                              <span className="inline-block rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                                Annulé
                              </span>
                              <span className="block text-xs">
                                le {formatDateTime(payment.cancelledAt as Date, timeZone)}
                                {payment.cancelledByName ? ` par ${payment.cancelledByName}` : ''}
                              </span>
                              {payment.cancellationReason && (
                                <span className="block text-xs">Motif : {payment.cancellationReason}</span>
                              )}
                            </>
                          ) : (
                            <span className="inline-block rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground">
                              Pointé
                            </span>
                          )}
                        </td>
                        {canManage && (
                          <td className="px-4 py-3 text-right">
                            {!cancelled && (
                              <CancelPaymentButton invoiceId={invoice.id} paymentId={payment.id} label={label} />
                            )}
                          </td>
                        )}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {canManage && !isDraft && !isCreditNote && (
        <div className="rounded-lg border border-border bg-white px-5 py-4">
          <h3 className="mb-3 text-sm font-semibold">Pointer un paiement</h3>
          <PaymentForm
            invoiceId={invoice.id}
            defaultMethod={invoice.expectedPaymentMethod}
            amountDueCents={due}
            today={today}
          />
        </div>
      )}
    </section>
  )
}
