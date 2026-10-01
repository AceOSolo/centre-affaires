import Link from 'next/link'
import { notFound } from 'next/navigation'

import { ConfirmDialog } from '../../../../components/ui/confirm-dialog.tsx'
import { FlashNotice } from '../../../../components/ui/flash-notice.tsx'
import { can } from '../../../../lib/auth/permissions.ts'
import { requirePermission } from '../../../../lib/auth/staff.ts'
import { formatDateTime } from '../../../../lib/dates.ts'
import { currentTenant } from '../../../../lib/tenant.ts'
import { isUuid } from '../../../../lib/uuid.ts'
import {
  abandonDraftAction,
  creditInFullAction,
  issueInvoiceAction,
  prepareCreditNoteAction,
} from '../../../../modules/facturation/factures-actions.ts'
import { missingForIssue, vatBreakdownOf } from '../../../../modules/facturation/factures-document.ts'
import {
  DraftConditionsForm,
  ManualLineForm,
  RemoveLineButton,
} from '../../../../modules/facturation/factures-forms.tsx'
import {
  formatBasisPoints,
  formatProrata,
  invoiceKindLabels,
  invoiceLineKindLabels,
  invoiceStatusLabel,
  invoiceStatusStyles,
  paymentMethodLabels,
  vatCategoryLabels,
} from '../../../../modules/facturation/factures-labels.ts'
import { findInvoice } from '../../../../modules/facturation/factures-queries.ts'
import { maskIban } from '../../../../modules/facturation/iban.ts'
import { dayLabel } from '../../../../modules/facturation/lot.ts'
import { amountDueCents } from '../../../../modules/facturation/montants.ts'
import { formatPeriod } from '../../../../modules/facturation/periodes.ts'
import { formatCents } from '../../../../modules/facturation/tarifs.ts'

export const metadata = { title: 'Facture' }

const notices: Record<string, string> = {
  conditions: 'Conditions du brouillon enregistrées.',
  'ligne-ajoutee': 'Ligne ajoutée : les totaux et la TVA sont recalculés.',
  'ligne-modifiee': 'Ligne modifiée : les totaux et la TVA sont recalculés.',
  'ligne-retiree': 'Ligne retirée : sa source redevient facturable.',
  emise: 'Émise : la facture a reçu son numéro et ne se modifie plus.',
  'avoir-prepare':
    'Brouillon d’avoir préparé : il reprend ce qui reste à créditer. Réduisez-le pour un avoir partiel, puis émettez-le.',
  'avoir-emis': 'Avoir émis : la facture d’origine est créditée.',
}

const dangerTrigger =
  'rounded-md border border-destructive/30 bg-white px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
const primaryTrigger =
  'rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
const secondaryLink =
  'rounded-md border border-border bg-white px-4 py-2 text-sm font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
const fieldClass =
  'mt-1 w-full rounded-sm border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/40'

export default async function InvoicePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ fait?: string }>
}) {
  const { member } = await requirePermission('facturation.consulter')
  const { id } = await params
  const { fait } = await searchParams
  if (!isUuid(id)) notFound()
  const [detail, tenant] = await Promise.all([findInvoice(id), currentTenant()])
  if (!detail || detail.invoice.deletedAt) notFound()

  const { invoice, client, lines } = detail
  const isDraft = invoice.status === 'draft'
  const isCreditNote = invoice.kind === 'credit_note'
  const canManage = can(member.role, 'facturation.gerer')
  const currency = invoice.currency
  const money = (cents: number) => formatCents(cents, currency)
  const breakdown = vatBreakdownOf(lines)
  const missing = isDraft
    ? missingForIssue(invoice, tenant, client, detail.activeMandate !== null)
    : []
  const openCreditNote = detail.creditNotes.find((note) => note.status === 'draft')
  const title = isDraft
    ? `${isCreditNote ? 'Brouillon d’avoir' : 'Brouillon de facture'}`
    : `${invoiceKindLabels[invoice.kind]} ${invoice.number}`

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <Link href="/factures" className="text-sm text-muted-foreground hover:underline">
          ← Factures
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight tabular">{title}</h1>
          <span
            className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${invoiceStatusStyles[invoice.status]}`}
          >
            {invoiceStatusLabel(invoice.kind, invoice.status)}
          </span>
        </div>
        <p className="text-sm text-muted-foreground">
          <Link href={`/clients/${client.id}`} className="font-medium text-foreground underline-offset-2 hover:underline">
            {client.name}
          </Link>{' '}
          · période {formatPeriod(invoice.periodStart, invoice.periodEnd)}
          {detail.run && ' · préparée par un lot de facturation'}
          {detail.original && (
            <>
              {' '}
              · avoir sur{' '}
              <Link href={`/factures/${detail.original.id}`} className="underline underline-offset-2">
                la facture {detail.original.number}
              </Link>
            </>
          )}
        </p>
      </div>

      {fait && notices[fait] && <FlashNotice key={fait}>{notices[fait]}</FlashNotice>}

      <div className="grid gap-4 lg:grid-cols-3">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-lg border border-border bg-white px-5 py-4 text-sm lg:col-span-2">
          <dt className="text-muted-foreground">Émission</dt>
          <dd>
            {invoice.issueDate
              ? `le ${dayLabel(invoice.issueDate)}${detail.issuedByName ? ` par ${detail.issuedByName}` : ''}`
              : 'Pas encore émise : ni numéro ni date.'}
            {invoice.issuedAt && (
              <span className="text-muted-foreground"> ({formatDateTime(invoice.issuedAt, tenant.timezone)})</span>
            )}
          </dd>
          {!isCreditNote && (
            <>
              <dt className="text-muted-foreground">Échéance</dt>
              <dd>
                {invoice.dueDate
                  ? `le ${dayLabel(invoice.dueDate)} (${invoice.paymentTermsDays} jours)`
                  : `à l’émission + ${invoice.paymentTermsDays ?? tenant.invoicePaymentTermsDays} jours`}
              </dd>
              <dt className="text-muted-foreground">Paiement</dt>
              <dd>
                {paymentMethodLabels[invoice.expectedPaymentMethod]}
                {invoice.expectedPaymentMethod === 'direct_debit' &&
                  (invoice.mandateReference
                    ? ` — mandat ${invoice.mandateReference}`
                    : detail.activeMandate
                      ? ` — mandat ${detail.activeMandate.reference}, IBAN ${maskIban(detail.activeMandate.ibanLast4)}`
                      : ' — aucun mandat actif')}
              </dd>
            </>
          )}
          {invoice.buyerReference && (
            <>
              <dt className="text-muted-foreground">Référence acheteur</dt>
              <dd>{invoice.buyerReference}</dd>
            </>
          )}
          {invoice.notes && (
            <>
              <dt className="text-muted-foreground">{isCreditNote ? 'Motif' : 'Mentions'}</dt>
              <dd className="whitespace-pre-line">{invoice.notes}</dd>
            </>
          )}
        </dl>

        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 rounded-lg border border-border bg-white px-5 py-4 text-sm">
          <dt className="text-muted-foreground">Total HT</dt>
          <dd className="text-right tabular">{money(invoice.totalExclTaxCents)}</dd>
          <dt className="text-muted-foreground">TVA</dt>
          <dd className="text-right tabular">{money(invoice.totalTaxCents)}</dd>
          <dt className="font-medium">Total TTC</dt>
          <dd className="text-right font-semibold tabular">{money(invoice.totalInclTaxCents)}</dd>
          {!isCreditNote && !isDraft && (
            <>
              <dt className="text-muted-foreground">Avoirs</dt>
              <dd className="text-right tabular">{money(invoice.creditedCents)}</dd>
              <dt className="text-muted-foreground">Payé</dt>
              <dd className="text-right tabular">{money(invoice.paidCents)}</dd>
              <dt className="font-medium">Reste dû</dt>
              <dd className="text-right font-semibold tabular">{money(amountDueCents(invoice))}</dd>
            </>
          )}
        </dl>
      </div>

      <div className="flex flex-wrap items-start gap-3">
        <Link href={`/factures/${invoice.id}/document`} className={secondaryLink}>
          {isDraft ? 'Aperçu imprimable' : 'Vue imprimable (PDF)'}
        </Link>

        {canManage && isDraft && (
          <>
            <ConfirmDialog
              triggerLabel={isCreditNote ? 'Émettre l’avoir' : 'Émettre la facture'}
              triggerClassName={primaryTrigger}
              title={isCreditNote ? 'Émettre cet avoir ?' : 'Émettre cette facture ?'}
              confirmLabel="Émettre"
              pendingLabel="Émission…"
              action={issueInvoiceAction}
              fields={{ id: invoice.id }}
            >
              <p>
                La base lui attribue le numéro suivant de la série, la date du jour et
                {isCreditNote ? '' : ' son échéance,'} et y fige les coordonnées du centre et du client.
              </p>
              <p>
                Ensuite, plus rien ne se modifie : une erreur se corrige par un avoir.
                {` Total : ${money(invoice.totalInclTaxCents)} TTC.`}
              </p>
            </ConfirmDialog>
            <ConfirmDialog
              triggerLabel="Abandonner le brouillon"
              triggerClassName={dangerTrigger}
              title="Abandonner ce brouillon ?"
              confirmLabel="Abandonner"
              pendingLabel="Abandon…"
              action={abandonDraftAction}
              fields={{ id: invoice.id }}
            >
              <p>
                Le brouillon sort de la liste, sans numéro. Ses lignes sont retirées : leurs sources
                (loyers, réservations, plis) redeviennent facturables par un prochain lot.
              </p>
            </ConfirmDialog>
          </>
        )}

        {canManage && !isDraft && !isCreditNote && invoice.status !== 'cancelled' && (
          <>
            {openCreditNote ? (
              <Link href={`/factures/${openCreditNote.id}`} className={secondaryLink}>
                Reprendre le brouillon d’avoir
              </Link>
            ) : (
              <ConfirmDialog
                triggerLabel="Préparer un avoir"
                triggerClassName={secondaryLink}
                title="Préparer un avoir"
                confirmLabel="Préparer le brouillon"
                pendingLabel="Préparation…"
                action={prepareCreditNoteAction}
                fields={{ id: invoice.id }}
              >
                <p>
                  Le brouillon reprend tout ce qui reste à créditer. Réduisez une quantité, un
                  montant, ou retirez des lignes pour un avoir partiel, puis émettez-le.
                </p>
                <div>
                  <label htmlFor="reasonPartial" className="block font-medium">
                    Motif
                  </label>
                  <input id="reasonPartial" name="reason" required maxLength={500} className={fieldClass} />
                </div>
              </ConfirmDialog>
            )}
            {!openCreditNote && (
              <ConfirmDialog
                triggerLabel="Annuler par un avoir total"
                triggerClassName={dangerTrigger}
                title="Annuler la facture par un avoir total ?"
                confirmLabel="Émettre l’avoir"
                pendingLabel="Émission…"
                action={creditInFullAction}
                fields={{ id: invoice.id }}
              >
                <p>
                  Un avoir de {money(invoice.totalInclTaxCents - invoice.creditedCents)} TTC est émis
                  aussitôt, avec son numéro. Les sources de la facture redeviennent facturables : un
                  lot rejoué les reprendra sur une nouvelle facture.
                </p>
                <div>
                  <label htmlFor="reasonFull" className="block font-medium">
                    Motif
                  </label>
                  <input id="reasonFull" name="reason" required maxLength={500} className={fieldClass} />
                </div>
              </ConfirmDialog>
            )}
          </>
        )}
      </div>

      {isDraft && missing.length > 0 && (
        <div className="rounded-md border border-border bg-muted px-4 py-3 text-sm">
          <p className="font-medium">Avant d’émettre, il manque :</p>
          <ul className="mt-1 list-disc pl-5">
            {missing.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <p className="mt-2 text-muted-foreground">
            L’adresse du client se complète sur{' '}
            <Link href={`/clients/${client.id}/modifier`} className="underline underline-offset-2">
              sa fiche
            </Link>
            ; l’identité du centre, dans sa configuration.
          </p>
        </div>
      )}

      <section id="lignes" aria-labelledby="lignes-titre" className="flex flex-col gap-4">
        <h2 id="lignes-titre" className="text-lg font-semibold tracking-tight">
          Lignes
        </h2>
        {lines.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border bg-white px-6 py-8 text-center text-sm text-muted-foreground">
            Aucune ligne : {isDraft ? 'ajoutez-en une ci-dessous, ou relancez le lot du mois.' : '—'}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-white">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Lignes, montants hors taxes et TVA</caption>
              <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Désignation</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Qté</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">PU HT</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Remise</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Prorata</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Montant HT</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">TVA</th>
                  {canManage && isDraft && (
                    <th scope="col" className="px-4 py-3 font-medium">
                      <span className="sr-only">Actions</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {lines.map((line) => (
                  <tr key={line.id} className="align-top">
                    <td className="px-4 py-3">
                      <span className="mr-2 text-xs font-medium text-muted-foreground">
                        {invoiceLineKindLabels[line.kind]}
                      </span>
                      {line.description}
                      {line.periodStart && line.periodEnd && (
                        <span className="block text-xs text-muted-foreground">
                          {formatPeriod(line.periodStart, line.periodEnd)}
                        </span>
                      )}
                      {line.creditedLineDescription && (
                        <span className="block text-xs text-muted-foreground">
                          Crédite : {line.creditedLineDescription}
                        </span>
                      )}
                      {line.releasedAt && (
                        <span className="block text-xs text-muted-foreground">
                          Entièrement créditée : sa source est de nouveau facturable.
                        </span>
                      )}
                      {line.vatCategory !== 'S' && (
                        <span className="block text-xs text-muted-foreground">
                          {vatCategoryLabels[line.vatCategory]}
                          {line.vatExemptionReason ? ` — ${line.vatExemptionReason}` : ' — motif à préciser'}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right tabular">{line.quantity}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-right tabular">{money(line.unitPriceCents)}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-right tabular">
                      {line.discountBp !== null
                        ? formatBasisPoints(line.discountBp)
                        : line.discountAmountCents !== null
                          ? money(line.discountAmountCents)
                          : '—'}
                    </td>
                    <td className="px-4 py-3 text-right tabular">
                      {formatProrata(line.prorataNumerator, line.prorataDenominator) ?? '—'}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right tabular">{money(line.netAmountCents ?? 0)}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-right tabular">
                      {money(line.vatAmountCents)}
                      <span className="block text-xs text-muted-foreground">{formatBasisPoints(line.vatRateBp)}</span>
                    </td>
                    {canManage && isDraft && (
                      <td className="whitespace-nowrap px-4 py-3">
                        <Link
                          href={`/factures/${invoice.id}/lignes/${line.id}`}
                          aria-label={`Modifier la ligne « ${line.description} »`}
                          className="rounded-md px-2 py-1 text-xs font-medium text-primary underline-offset-2 hover:underline"
                        >
                          Modifier
                        </Link>
                        <RemoveLineButton invoiceId={invoice.id} lineId={line.id} description={line.description} />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {breakdown.length > 0 && (
          <div className="overflow-x-auto self-end rounded-lg border border-border bg-white">
            <table className="text-left text-sm">
              <caption className="px-4 pt-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Ventilation de la TVA, calculée par taux
              </caption>
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">Taux</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">Base HT</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">TVA</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {breakdown.map((row) => (
                  <tr key={`${row.vatCategory}-${row.vatRateBp}`}>
                    <td className="px-4 py-2">
                      {row.vatCategory === 'S' ? formatBasisPoints(row.vatRateBp) : vatCategoryLabels[row.vatCategory]}
                    </td>
                    <td className="px-4 py-2 text-right tabular">{money(row.taxableAmountCents)}</td>
                    <td className="px-4 py-2 text-right tabular">{money(row.vatAmountCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {canManage && isDraft && (
          <ManualLineForm invoiceId={invoice.id} defaultVatRateBp={tenant.defaultVatRateBp} />
        )}
      </section>

      {canManage && isDraft && (
        <section aria-labelledby="conditions-titre" className="flex flex-col gap-3">
          <h2 id="conditions-titre" className="text-lg font-semibold tracking-tight">
            Conditions
          </h2>
          <DraftConditionsForm
            isCreditNote={isCreditNote}
            defaultTermsDays={tenant.invoicePaymentTermsDays}
            mandateLabel={
              detail.activeMandate
                ? `${detail.activeMandate.reference}, IBAN ${maskIban(detail.activeMandate.ibanLast4)}`
                : null
            }
            invoice={{
              id: invoice.id,
              periodStart: invoice.periodStart,
              periodEnd: invoice.periodEnd,
              paymentTermsDays: invoice.paymentTermsDays === null ? '' : String(invoice.paymentTermsDays),
              expectedPaymentMethod: invoice.expectedPaymentMethod,
              buyerReference: invoice.buyerReference ?? '',
              notes: invoice.notes ?? '',
            }}
          />
        </section>
      )}

      {!isCreditNote && detail.creditNotes.length > 0 && (
        <section aria-labelledby="avoirs-titre" className="flex flex-col gap-3">
          <h2 id="avoirs-titre" className="text-lg font-semibold tracking-tight">
            Avoirs
          </h2>
          <ul className="flex flex-col gap-2 rounded-lg border border-border bg-white px-5 py-4 text-sm">
            {detail.creditNotes.map((note) => (
              <li key={note.id} className="flex flex-wrap items-center gap-3">
                <Link href={`/factures/${note.id}`} className="font-medium tabular underline-offset-2 hover:underline">
                  {note.number ? `Avoir ${note.number}` : 'Brouillon d’avoir'}
                </Link>
                <span className="tabular">{money(note.totalInclTaxCents)} TTC</span>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${invoiceStatusStyles[note.status]}`}>
                  {invoiceStatusLabel(note.kind, note.status)}
                </span>
                {note.notes && <span className="text-muted-foreground">{note.notes}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {!isCreditNote && !isDraft && (
        <section aria-labelledby="paiements-titre" className="flex flex-col gap-3">
          <h2 id="paiements-titre" className="text-lg font-semibold tracking-tight">
            Paiements
          </h2>
          {detail.payments.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border bg-white px-6 py-6 text-center text-sm text-muted-foreground">
              Aucun paiement pointé sur cette facture.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border bg-white">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">Paiements pointés sur la facture</caption>
                <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-4 py-3 font-medium">Date de valeur</th>
                    <th scope="col" className="px-4 py-3 font-medium">Mode</th>
                    <th scope="col" className="px-4 py-3 font-medium">Référence</th>
                    <th scope="col" className="px-4 py-3 font-medium">Pointé par</th>
                    <th scope="col" className="px-4 py-3 text-right font-medium">Montant</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {detail.payments.map((payment) => (
                    <tr key={payment.id} className={payment.cancelledAt ? 'text-muted-foreground' : undefined}>
                      <td className="px-4 py-3 tabular">{dayLabel(payment.paidOn)}</td>
                      <td className="px-4 py-3">{paymentMethodLabels[payment.method]}</td>
                      <td className="px-4 py-3">
                        {payment.reference ?? '—'}
                        {payment.cancelledAt && (
                          <span className="block text-xs">
                            Annulé{payment.cancellationReason ? ` : ${payment.cancellationReason}` : ''}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">{payment.recordedByName}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-right tabular">
                        {payment.cancelledAt ? <s>{money(payment.amountCents)}</s> : money(payment.amountCents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  )
}
