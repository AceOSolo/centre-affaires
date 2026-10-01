import Link from 'next/link'

import { can } from '../../../lib/auth/permissions.ts'
import { requirePermission } from '../../../lib/auth/staff.ts'
import { emailEnabled } from '../../../lib/courriel.ts'
import { formatDateTime, todayIsoDate } from '../../../lib/dates.ts'
import { currentTimeZone } from '../../../lib/tenant.ts'
import { OpenInvoiceForm } from '../../../modules/facturation/open-invoice-form.tsx'
import { OverdueTable } from '../../../modules/facturation/overdue-table.tsx'
import { formatIsoDateFr } from '../../../modules/facturation/paiements-regles.ts'
import { listOpenInvoices, listRecentPayments } from '../../../modules/facturation/reglements.ts'
import { paymentMethodLabels } from '../../../modules/facturation/reglements-labels.ts'
import { formatCents } from '../../../modules/facturation/tarifs.ts'

export const metadata = { title: 'Règlements' }

/**
 * Suivi des règlements (R16, ADR 027, ADR 030) : factures échues à relancer,
 * factures à échoir, derniers paiements pointés. L'accueil consulte ;
 * l'exploitant pointe, relance et prépare les prélèvements.
 */
export default async function PaymentsPage() {
  const { member } = await requirePermission('facturation.consulter')
  const timeZone = await currentTimeZone()
  const today = todayIsoDate(timeZone)
  const [overdue, upcoming, recent] = await Promise.all([
    listOpenInvoices({ today, overdue: true }),
    listOpenInvoices({ today, overdue: false }),
    listRecentPayments(20),
  ])
  const canManage = can(member.role, 'paiements.gerer')
  const overdueTotal = overdue.reduce((total, row) => total + row.amountDueCents, 0)

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Règlements</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Les paiements se pointent à la main, à leur arrivée sur le relevé : virement, prélèvement ou
          autre. Une facture se règle en une ou plusieurs fois ; son état suit.
        </p>
        <div className="flex flex-wrap gap-3 pt-1">
          {canManage && (
            <Link
              href="/paiements/prelevements"
              className="rounded-md border border-border bg-white px-4 py-2 text-sm font-medium hover:bg-muted"
            >
              Prélèvements SEPA
            </Link>
          )}
          {can(member.role, 'comptabilite.exporter') && (
            <Link
              href="/comptabilite"
              className="rounded-md border border-border bg-white px-4 py-2 text-sm font-medium hover:bg-muted"
            >
              Export comptable
            </Link>
          )}
        </div>
      </div>

      <section aria-labelledby="ouvrir-titre" className="flex flex-col gap-2">
        <h2 id="ouvrir-titre" className="text-sm font-semibold tracking-tight">
          Ouvrir une facture
        </h2>
        <OpenInvoiceForm />
      </section>

      <section aria-labelledby="echues-titre" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 id="echues-titre" className="text-sm font-semibold tracking-tight">
            Échues non payées <span className="font-normal text-muted-foreground">({overdue.length})</span>
          </h2>
          {overdue.length > 0 && (
            <p className="text-sm tabular text-muted-foreground">
              {formatCents(overdueTotal, overdue[0].currency)} restant dus
            </p>
          )}
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Palier de relance selon le retard : relance amiable dès le lendemain de l’échéance, seconde
          relance à 15 jours, mise en demeure à 30 jours. Aucune relance ne part seule.
        </p>
        <OverdueTable
          rows={overdue.map((row) => ({
            id: row.id,
            number: row.number,
            clientName: row.clientName,
            dueDate: row.dueDate,
            daysOverdue: row.daysOverdue,
            amountDueCents: row.amountDueCents,
            currency: row.currency,
            expectedPaymentMethod: row.expectedPaymentMethod,
            level: row.level,
          }))}
          canSend={canManage}
          emailOn={emailEnabled()}
        />
      </section>

      <section aria-labelledby="a-echoir-titre" className="flex flex-col gap-3">
        <h2 id="a-echoir-titre" className="text-sm font-semibold tracking-tight">
          À échoir <span className="font-normal text-muted-foreground">({upcoming.length})</span>
        </h2>
        {upcoming.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Aucune facture émise n’attend de règlement avant son échéance.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-white">
            <table aria-labelledby="a-echoir-titre" className="w-full text-left text-sm">
              <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Facture</th>
                  <th scope="col" className="px-4 py-3 font-medium">Client</th>
                  <th scope="col" className="px-4 py-3 font-medium">Émise le</th>
                  <th scope="col" className="px-4 py-3 font-medium">Échéance</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Reste dû</th>
                  <th scope="col" className="px-4 py-3 font-medium">Mode</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {upcoming.map((row) => (
                  <tr key={row.id}>
                    <td className="whitespace-nowrap px-4 py-3">
                      <Link
                        href={`/paiements/factures/${row.id}`}
                        className="font-medium tabular underline-offset-2 hover:underline"
                      >
                        {row.number}
                      </Link>
                    </td>
                    <td className="px-4 py-3">{row.clientName}</td>
                    <td className="whitespace-nowrap px-4 py-3 tabular">{formatIsoDateFr(row.issueDate)}</td>
                    <td className="whitespace-nowrap px-4 py-3 tabular">{formatIsoDateFr(row.dueDate)}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-right tabular">
                      {formatCents(row.amountDueCents, row.currency)}
                    </td>
                    <td className="px-4 py-3">{paymentMethodLabels[row.expectedPaymentMethod]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="recents-titre" className="flex flex-col gap-3">
        <h2 id="recents-titre" className="text-sm font-semibold tracking-tight">
          Derniers pointages
        </h2>
        {recent.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Aucun paiement pointé pour l’instant. Ouvrez une facture par son numéro pour pointer le
            premier.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-white">
            <table aria-labelledby="recents-titre" className="w-full text-left text-sm">
              <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Pointé le</th>
                  <th scope="col" className="px-4 py-3 font-medium">Facture</th>
                  <th scope="col" className="px-4 py-3 font-medium">Client</th>
                  <th scope="col" className="px-4 py-3 font-medium">Valeur</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Montant</th>
                  <th scope="col" className="px-4 py-3 font-medium">Mode</th>
                  <th scope="col" className="px-4 py-3 font-medium">État</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {recent.map((payment) => (
                  <tr key={payment.id} className={payment.cancelledAt ? 'text-muted-foreground' : undefined}>
                    <td className="whitespace-nowrap px-4 py-3 tabular">{formatDateTime(payment.createdAt, timeZone)}</td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <Link
                        href={`/paiements/factures/${payment.invoiceId}`}
                        className="font-medium tabular underline-offset-2 hover:underline"
                      >
                        {payment.invoiceNumber}
                      </Link>
                    </td>
                    <td className="px-4 py-3">{payment.clientName}</td>
                    <td className="whitespace-nowrap px-4 py-3 tabular">{formatIsoDateFr(payment.paidOn)}</td>
                    <td className={`whitespace-nowrap px-4 py-3 text-right tabular ${payment.cancelledAt ? 'line-through' : ''}`}>
                      {formatCents(payment.amountCents, payment.currency)}
                    </td>
                    <td className="px-4 py-3">{paymentMethodLabels[payment.method]}</td>
                    <td className="px-4 py-3">{payment.cancelledAt ? 'Annulé' : 'Pointé'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
