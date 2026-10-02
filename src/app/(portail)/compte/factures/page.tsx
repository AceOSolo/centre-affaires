import Link from 'next/link'

import {
  CheckIcon,
  ClockIcon,
  CreditCardIcon,
  FileTextIcon,
} from '../../../../components/ui/icons.tsx'
import { formatCalendarDate, todayIsoDate } from '../../../../lib/dates.ts'
import { currentTenant } from '../../../../lib/tenant.ts'
import { requireClientAccount } from '../../../../modules/clients/session.ts'
import {
  CLIENT_INVOICE_LIMIT,
  listInvoicesForAccounts,
} from '../../../../modules/facturation/compte-queries.ts'
import {
  clientInvoiceState,
  clientInvoiceToneStyles,
  outstandingByCurrency,
  type ClientInvoiceTone,
} from '../../../../modules/facturation/compte-regles.ts'
import { formatIban } from '../../../../modules/facturation/factures-document.ts'
import { paymentMethodLabels } from '../../../../modules/facturation/factures-labels.ts'
import { formatPeriod } from '../../../../modules/facturation/periodes.ts'
import { formatCents } from '../../../../modules/facturation/tarifs.ts'

export const metadata = { title: 'Mes factures' }

const toneIcons: Record<ClientInvoiceTone, typeof CheckIcon> = {
  due: ClockIcon,
  overdue: ClockIcon,
  partial: CreditCardIcon,
  settled: CheckIcon,
  cancelled: FileTextIcon,
  credit: FileTextIcon,
}

/**
 * Factures et avoirs émis des entreprises du compte (R17) : montant,
 * échéance, ce qui reste à régler, et la vue imprimable — la même que celle
 * du back-office. Jamais un brouillon, jamais la facture d'une autre
 * entreprise : la portée client en RLS l'interdit, les filtres aussi.
 *
 * Mobile d'abord (R25) : une carte par document, l'action en pleine largeur
 * et à 44 px de haut. Les coordonnées de virement sont en tête, avec la
 * référence à indiquer.
 */
export default async function MesFacturesPage() {
  // Revérifié ici : la coque ne protège pas une page appelée seule.
  const { accounts } = await requireClientAccount()
  const [tenant, invoices] = await Promise.all([currentTenant(), listInvoicesForAccounts(accounts)])
  const today = todayIsoDate(tenant.timezone)
  const several = accounts.length > 1
  const outstanding = outstandingByCurrency(invoices, today)
  const toPayByTransfer = invoices.find(
    (invoice) =>
      invoice.expectedPaymentMethod === 'transfer' && clientInvoiceState(invoice, today).amountDueCents > 0,
  )

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-primary sm:text-3xl">Mes factures</h1>
        <p className="mt-2 max-w-prose text-muted-foreground">
          Les factures et avoirs émis par le centre, ce qui reste à régler, et chaque document à
          imprimer ou enregistrer en PDF.
        </p>
        {/* Annoncé quand le reste à régler change. */}
        <p aria-live="polite" className="mt-2 text-sm font-medium text-primary">
          {outstanding.length === 0
            ? invoices.length > 0
              ? 'Rien à régler pour l’instant.'
              : ''
            : outstanding
                .map(
                  (total) =>
                    `Reste à régler : ${formatCents(total.dueCents, total.currency)} sur ${total.count} facture${total.count > 1 ? 's' : ''}` +
                    (total.overdueCents > 0
                      ? `, dont ${formatCents(total.overdueCents, total.currency)} à échéance dépassée`
                      : ''),
                )
                .join(' · ') + '.'}
        </p>
      </div>

      {/* Coordonnées de virement : celles du centre aujourd'hui. Chaque facture
          porte aussi celles figées à son émission. */}
      <section
        aria-labelledby="reglement"
        className="max-w-3xl rounded-lg border border-border bg-muted px-4 py-4 text-sm sm:px-5"
      >
        <h2 id="reglement" className="font-semibold text-primary">
          Régler par virement
        </h2>
        {tenant.bankIban ? (
          <dl className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-[auto_1fr]">
            <dt className="text-muted-foreground">Titulaire</dt>
            <dd className="font-medium">{tenant.legalName ?? tenant.name}</dd>
            <dt className="text-muted-foreground">IBAN</dt>
            <dd className="font-medium tabular break-words">{formatIban(tenant.bankIban)}</dd>
            {tenant.bankBic && (
              <>
                <dt className="text-muted-foreground">BIC</dt>
                <dd className="font-medium tabular">{tenant.bankBic}</dd>
              </>
            )}
            <dt className="text-muted-foreground">Référence à indiquer</dt>
            <dd>
              Le numéro de la facture réglée
              {toPayByTransfer?.number && (
                <>
                  {' '}
                  (par exemple <span className="font-medium tabular">{toPayByTransfer.number}</span>)
                </>
              )}
              , une facture par virement.
            </dd>
          </dl>
        ) : (
          <p className="mt-2 text-muted-foreground">
            Les coordonnées de règlement figurent sur chaque facture. Pour toute question,
            contactez le centre
            {tenant.phone ? ` au ${tenant.phone}` : ''}.
          </p>
        )}
        <p className="mt-2 text-muted-foreground">
          Une facture prélevée l’est sur le compte de votre mandat SEPA : vous n’avez rien à faire.
        </p>
      </section>

      {invoices.length === 0 ? (
        <div className="max-w-3xl rounded-lg border border-dashed border-border px-6 py-12 text-center">
          <FileTextIcon size={24} className="mx-auto text-muted-foreground" />
          <p className="mt-3 text-muted-foreground">
            Aucune facture pour l’instant. Chaque facture émise par le centre à votre nom apparaîtra
            ici, avec son document.
          </p>
        </div>
      ) : (
        <ul className="flex max-w-3xl flex-col gap-4">
          {invoices.map((invoice) => {
            const state = clientInvoiceState(invoice, today)
            const Icon = toneIcons[state.tone]
            const money = (cents: number) => formatCents(cents, invoice.currency)
            const isCreditNote = invoice.kind === 'credit_note'
            const noun = isCreditNote ? 'Avoir' : 'Facture'
            return (
              <li key={invoice.id} className="rounded-lg border border-border bg-white p-4 sm:p-5">
                <article aria-labelledby={`facture-${invoice.id}`} className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    {/* L'état se lit à l'icône et au libellé, pas à la seule couleur. */}
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium ${clientInvoiceToneStyles[state.tone]}`}
                    >
                      <Icon size={16} />
                      {state.label}
                    </span>
                    {several && <span className="text-muted-foreground">{invoice.clientName}</span>}
                  </div>

                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <h2 id={`facture-${invoice.id}`} className="text-base font-semibold">
                      {noun} <span className="tabular">{invoice.number}</span>
                    </h2>
                    <p className="text-base font-semibold tabular">
                      {money(invoice.totalInclTaxCents)} <span className="text-sm font-normal text-muted-foreground">TTC</span>
                    </p>
                  </div>

                  <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                    <div>
                      <dt className="text-muted-foreground">Émis{isCreditNote ? '' : 'e'} le</dt>
                      <dd className="tabular">
                        {invoice.issueDate ? formatCalendarDate(invoice.issueDate) : '—'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Période</dt>
                      <dd>{formatPeriod(invoice.periodStart, invoice.periodEnd)}</dd>
                    </div>
                    {isCreditNote ? (
                      invoice.creditedInvoiceNumber && (
                        <div>
                          <dt className="text-muted-foreground">Sur la facture</dt>
                          <dd className="tabular">{invoice.creditedInvoiceNumber}</dd>
                        </div>
                      )
                    ) : (
                      <>
                        <div>
                          <dt className="text-muted-foreground">Échéance</dt>
                          <dd className="tabular">
                            {invoice.dueDate ? formatCalendarDate(invoice.dueDate) : '—'}
                            {state.overdue && ' (dépassée)'}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">Règlement</dt>
                          <dd>{paymentMethodLabels[invoice.expectedPaymentMethod]}</dd>
                        </div>
                        {state.amountDueCents > 0 && (
                          <div>
                            <dt className="text-muted-foreground">Reste à régler</dt>
                            <dd className="font-medium tabular">{money(state.amountDueCents)}</dd>
                          </div>
                        )}
                        {state.amountDueCents > 0 && invoice.expectedPaymentMethod === 'transfer' && (
                          <div>
                            <dt className="text-muted-foreground">Référence du virement</dt>
                            <dd className="font-medium tabular">{invoice.number}</dd>
                          </div>
                        )}
                      </>
                    )}
                  </dl>

                  <Link
                    href={`/compte/factures/${invoice.id}`}
                    className="press inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-border px-5 py-2.5 text-sm font-medium text-primary transition-colors hover:bg-muted sm:self-start"
                  >
                    <FileTextIcon size={20} />
                    Voir et imprimer
                    <span className="sr-only">
                      {' '}
                      {isCreditNote ? 'l’avoir' : 'la facture'} {invoice.number}
                    </span>
                  </Link>
                </article>
              </li>
            )
          })}
        </ul>
      )}

      {invoices.length >= CLIENT_INVOICE_LIMIT && (
        <p className="max-w-prose text-sm text-muted-foreground">
          Seuls les {CLIENT_INVOICE_LIMIT} documents les plus récents sont affichés. Les plus anciens
          restent consultables, année par année, dans l’
          <Link href="/compte/historique?type=factures" className="font-medium text-primary underline-offset-2 hover:underline">
            historique du compte
          </Link>
          .
        </p>
      )}
    </div>
  )
}
