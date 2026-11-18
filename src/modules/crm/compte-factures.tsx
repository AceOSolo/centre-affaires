import { CheckIcon, ClockIcon, CreditCardIcon, FileTextIcon } from '../../components/ui/icons.tsx'
import type { Tenant } from '../../db/tenants.ts'
import { formatCalendarDate } from '../../lib/dates.ts'
import { formatIban } from '../facturation/factures-document.ts'
import { formatCents } from '../facturation/tarifs.ts'
import type { ClientReceivedInvoice } from './factures-queries.ts'
import {
  outstandingReceived,
  receivedInvoiceState,
  receivedInvoiceToneStyles,
  type ReceivedInvoiceTone,
} from './factures.ts'

/**
 * « Mes factures » dans l'espace client (ADR 081) : les factures et avoirs
 * que le CRM a émis pour les entreprises du compte, reçus par le flux
 * « Factures ». Le site n'en émet aucune (ADR 046) : il les montre, avec le
 * lien vers le PDF que le CRM donne.
 *
 * Mobile d'abord (R25) : une carte par document, le lien du PDF en pleine
 * largeur et à 44 px de haut.
 */

const toneIcons: Record<ReceivedInvoiceTone, typeof CheckIcon> = {
  due: ClockIcon,
  overdue: ClockIcon,
  partial: CreditCardIcon,
  paid: CheckIcon,
  cancelled: FileTextIcon,
  credit: FileTextIcon,
}

export function ClientReceivedInvoices({
  invoices,
  today,
  tenant,
  flowEnabled,
  several,
  limit,
}: {
  invoices: readonly ClientReceivedInvoice[]
  /** Jour du centre, `AAAA-MM-JJ` : l'échéance passée se compare à lui. */
  today: string
  tenant: Pick<Tenant, 'name' | 'legalName' | 'phone' | 'bankIban' | 'bankBic'>
  /** Le flux « Factures » est ouvert : sans facture, la liste est vide plutôt qu'absente. */
  flowEnabled: boolean
  several: boolean
  limit: number
}) {
  const outstanding = outstandingReceived(invoices, today)
  const toPay = invoices.find((invoice) => receivedInvoiceState(invoice, today).amountDueCents > 0)

  return (
    <section aria-labelledby="factures" className="flex max-w-3xl flex-col gap-4">
      <div>
        <h2 id="factures" className="text-xl font-semibold tracking-tight text-primary">
          Mes factures
        </h2>
        <p className="mt-1 max-w-prose text-sm text-muted-foreground">
          Les factures et avoirs émis par le centre, leur état et leur document.
        </p>
        {/* Annoncé quand le reste à payer change. */}
        <p aria-live="polite" className="mt-2 text-sm font-medium text-primary empty:hidden">
          {outstanding.length === 0
            ? invoices.length > 0
              ? 'Rien à payer pour l’instant.'
              : ''
            : outstanding
                .map(
                  (total) =>
                    `Reste à payer : ${formatCents(total.dueCents, total.currency)} sur ${total.count} facture${total.count > 1 ? 's' : ''}` +
                    (total.overdueCents > 0
                      ? `, dont ${formatCents(total.overdueCents, total.currency)} à échéance dépassée`
                      : ''),
                )
                .join(' · ') + '.'}
        </p>
      </div>

      {invoices.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-6 py-10 text-center">
          <FileTextIcon size={24} className="mx-auto text-muted-foreground" />
          <p className="mt-3 text-sm text-muted-foreground">
            {flowEnabled
              ? 'Aucune facture pour l’instant. Chaque facture que le centre vous émet apparaîtra ici, avec son document.'
              : `Le centre vous envoie ses factures par courriel.${tenant.phone ? ` Pour toute question, appelez-le au ${tenant.phone}.` : ''}`}
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-4">
          {invoices.map((invoice) => {
            const state = receivedInvoiceState(invoice, today)
            const Icon = toneIcons[state.tone]
            const money = (cents: number) => formatCents(cents, invoice.currency)
            const isCredit = invoice.kind === 'credit_note'
            const noun = isCredit ? 'Avoir' : 'Facture'
            return (
              <li key={invoice.id} className="rounded-lg border border-border bg-white p-4 sm:p-5">
                <article aria-labelledby={`facture-${invoice.id}`} className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    {/* L'état se lit à l'icône et au libellé, pas à la seule couleur. */}
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium ${receivedInvoiceToneStyles[state.tone]}`}
                    >
                      <Icon size={16} />
                      {state.label}
                    </span>
                    {several && <span className="text-muted-foreground">{invoice.clientName}</span>}
                  </div>

                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <h3 id={`facture-${invoice.id}`} className="text-base font-semibold">
                      {noun} <span className="tabular">{invoice.number}</span>
                    </h3>
                    <p className="text-base font-semibold tabular">
                      {money(invoice.totalInclTaxCents)}{' '}
                      <span className="text-sm font-normal text-muted-foreground">TTC</span>
                    </p>
                  </div>

                  <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                    <div>
                      <dt className="text-muted-foreground">{isCredit ? 'Émis le' : 'Émise le'}</dt>
                      <dd className="tabular">{formatCalendarDate(invoice.issuedOn)}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Montant HT</dt>
                      <dd className="tabular">{money(invoice.totalExclTaxCents)}</dd>
                    </div>
                    {!isCredit && invoice.dueOn && (
                      <div>
                        <dt className="text-muted-foreground">Échéance</dt>
                        <dd className="tabular">
                          {formatCalendarDate(invoice.dueOn)}
                          {state.overdue && ' (dépassée)'}
                        </dd>
                      </div>
                    )}
                    {state.amountDueCents > 0 && (
                      <div>
                        <dt className="text-muted-foreground">Reste à payer</dt>
                        <dd className="font-medium tabular">{money(state.amountDueCents)}</dd>
                      </div>
                    )}
                  </dl>

                  {invoice.pdfUrl ? (
                    <a
                      href={invoice.pdfUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="press inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-border px-5 py-2.5 text-sm font-medium text-primary transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:self-start"
                    >
                      <FileTextIcon size={20} />
                      Télécharger le PDF
                      <span className="sr-only">
                        {' '}
                        {isCredit ? 'de l’avoir' : 'de la facture'} {invoice.number} (s’ouvre dans un nouvel onglet)
                      </span>
                    </a>
                  ) : (
                    <p className="text-sm text-muted-foreground">Document envoyé par courriel par le centre.</p>
                  )}
                </article>
              </li>
            )
          })}
        </ul>
      )}

      {invoices.length >= limit && (
        <p className="max-w-prose text-sm text-muted-foreground">
          Seuls les {limit} documents les plus récents sont affichés. Pour un document plus ancien,
          contactez le centre{tenant.phone ? ` au ${tenant.phone}` : ''}.
        </p>
      )}

      {toPay && (
        <section
          aria-labelledby="reglement"
          className="rounded-lg border border-border bg-muted px-4 py-4 text-sm sm:px-5"
        >
          <h3 id="reglement" className="font-semibold text-primary">
            Payer par virement
          </h3>
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
                Le numéro de la facture payée (par exemple{' '}
                <span className="font-medium tabular">{toPay.number}</span>), une facture par virement.
              </dd>
            </dl>
          ) : (
            <p className="mt-2 text-muted-foreground">
              Les coordonnées de paiement figurent sur chaque facture.
            </p>
          )}
          <p className="mt-2 text-muted-foreground">
            Une facture prélevée l’est sur le compte de votre mandat : vous n’avez rien à faire.
          </p>
        </section>
      )}
    </section>
  )
}
