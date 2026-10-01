import Link from 'next/link'

import { FlashNotice } from '../../../../components/ui/flash-notice.tsx'
import { can } from '../../../../lib/auth/permissions.ts'
import { requirePermission } from '../../../../lib/auth/staff.ts'
import {
  addMonthsToIsoMonth,
  formatDateTime,
  formatIsoMonth,
  isIsoMonth,
  todayIsoDate,
} from '../../../../lib/dates.ts'
import { currentTimeZone } from '../../../../lib/tenant.ts'
import { isUuid } from '../../../../lib/uuid.ts'
import { RunInvoicingForm } from '../../../../modules/facturation/factures-forms.tsx'
import {
  formatBasisPoints,
  invoiceLineKindLabels,
  invoiceRunStatusLabels,
  invoiceStatusLabel,
} from '../../../../modules/facturation/factures-labels.ts'
import {
  clientNamesFor,
  findInvoiceRun,
  listInvoiceRuns,
  previewInvoiceRun,
  type InvoiceRunEntry,
} from '../../../../modules/facturation/lot-queries.ts'
import { lineNetAmountCents } from '../../../../modules/facturation/montants.ts'
import { formatPeriod } from '../../../../modules/facturation/periodes.ts'
import { formatCents } from '../../../../modules/facturation/tarifs.ts'

export const metadata = { title: 'Préparer la facturation' }

const runStatusStyles: Record<InvoiceRunEntry['status'], string> = {
  running: 'border border-dashed border-primary/50 bg-accent/10 text-primary',
  completed: 'bg-primary text-primary-foreground',
  failed: 'border border-destructive/40 bg-white text-destructive',
}

/**
 * Préparer la facturation d'un mois (R13, R14, R15, ADR 026, ADR 028) : ce que
 * le lot facturera, client par client, avant de le lancer ; puis le lancement,
 * son bilan, et le journal des lots.
 */
export default async function PrepareInvoicingPage({
  searchParams,
}: {
  searchParams: Promise<{ mois?: string; lot?: string }>
}) {
  const { member } = await requirePermission('facturation.gerer')
  const { mois, lot } = await searchParams
  const timeZone = await currentTimeZone()
  // Le mois du centre par défaut, pas celui du serveur (décision 4).
  const month = isIsoMonth(mois) ? mois : todayIsoDate(timeZone).slice(0, 7)

  const [preview, runs, lastRun] = await Promise.all([
    previewInvoiceRun(month),
    listInvoiceRuns(),
    isUuid(lot) ? findInvoiceRun(lot) : Promise.resolve(undefined),
  ])
  const runClientNames = await clientNamesFor(
    (lastRun?.report.warnings ?? []).map((warning) => warning.clientId ?? ''),
  )

  const recurringLabel = formatIsoMonth(preview.windows.recurring.start.slice(0, 7))
  const consumptionLabel = formatIsoMonth(preview.windows.consumption.start.slice(0, 7))
  const billable = preview.clients.filter((client) => client.lines.length > 0)
  const warned = preview.clients.filter((client) => client.warnings.length > 0)
  const totals = billable.reduce(
    (sum, client) => ({
      exclTaxCents: sum.exclTaxCents + client.totals.exclTaxCents,
      inclTaxCents: sum.inclTaxCents + client.totals.inclTaxCents,
    }),
    { exclTaxCents: 0, inclTaxCents: 0 },
  )

  return (
    <div className="flex flex-col gap-8">
      <div>
        <Link href="/factures" className="text-sm text-muted-foreground hover:underline">
          ← Factures
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          Préparer la facturation — {formatIsoMonth(month)}
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Une facture brouillon par client, qui réunit les loyers et forfaits de{' '}
          <strong className="font-medium text-foreground">{recurringLabel}</strong>{' '}
          ({preview.timing === 'in_advance' ? 'à échoir' : 'à terme échu'}), et les réservations et
          plis ouverts de <strong className="font-medium text-foreground">{consumptionLabel}</strong>.
          Chaque ligne garde sa source : ce qui est déjà facturé ne l’est pas une seconde fois.
        </p>
      </div>

      {lastRun && (
        <FlashNotice key={lastRun.id}>
          <RunReport run={lastRun} clientNames={runClientNames} />
        </FlashNotice>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <Link
          href={`/factures/preparer?mois=${addMonthsToIsoMonth(month, -1)}`}
          className="rounded-md border border-border bg-white px-3 py-2 text-sm hover:bg-muted"
        >
          ← {formatIsoMonth(addMonthsToIsoMonth(month, -1))}
        </Link>
        <Link
          href={`/factures/preparer?mois=${addMonthsToIsoMonth(month, 1)}`}
          className="rounded-md border border-border bg-white px-3 py-2 text-sm hover:bg-muted"
        >
          {formatIsoMonth(addMonthsToIsoMonth(month, 1))} →
        </Link>
        <form className="flex items-end gap-2">
          <div>
            <label htmlFor="mois" className="block text-xs font-medium text-muted-foreground">
              Mois facturé
            </label>
            <input
              id="mois"
              name="mois"
              type="month"
              defaultValue={month}
              className="mt-1 rounded-sm border border-border bg-white px-3 py-1.5 text-sm"
            />
          </div>
          <button
            type="submit"
            className="rounded-md border border-border bg-white px-3 py-1.5 text-sm font-medium hover:bg-muted"
          >
            Afficher
          </button>
        </form>
      </div>

      <section aria-labelledby="apercu-titre" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 id="apercu-titre" className="text-lg font-semibold tracking-tight">
            À facturer
          </h2>
          <p className="text-sm text-muted-foreground">
            {billable.length} client{billable.length > 1 ? 's' : ''} ·{' '}
            <span className="tabular">{formatCents(totals.exclTaxCents, preview.currency)}</span> HT ·{' '}
            <span className="tabular">{formatCents(totals.inclTaxCents, preview.currency)}</span> TTC
            {preview.idleClientCount > 0 &&
              ` · ${preview.idleClientCount} client${preview.idleClientCount > 1 ? 's' : ''} en activité sans rien à facturer`}
          </p>
        </div>

        {billable.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border bg-white px-6 py-10 text-center">
            <p className="text-sm text-muted-foreground">
              Rien de nouveau à facturer pour {formatIsoMonth(month)} : tout ce qui est dû est déjà sur
              une facture, ou aucun contrat, forfait, réservation ou pli ne tombe sur la période.
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              Vérifiez les contrats en cours et les réservations confirmées, ou{' '}
              <Link href="/factures" className="underline underline-offset-2">
                consultez les factures existantes
              </Link>
              .
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-white">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Factures que le lot préparera, par client</caption>
              <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Client</th>
                  <th scope="col" className="px-4 py-3 font-medium">Lignes</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">HT</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">TVA</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">TTC</th>
                  <th scope="col" className="px-4 py-3 font-medium">Facture du lot</th>
                </tr>
              </thead>
              {billable.map((client) => (
                <tbody key={client.clientId} className="border-b border-border last:border-b-0">
                  <tr>
                    <th scope="row" className="px-4 py-3 text-left font-medium">
                      <Link href={`/clients/${client.clientId}`} className="underline-offset-2 hover:underline">
                        {client.clientName}
                      </Link>
                    </th>
                    <td className="px-4 py-3">
                      <details>
                        <summary className="cursor-pointer text-sm text-primary underline-offset-2 hover:underline">
                          {client.lines.length} ligne{client.lines.length > 1 ? 's' : ''}
                        </summary>
                        <ul className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground">
                          {client.lines.map((line, index) => (
                            <li key={index} className="flex flex-wrap gap-x-2">
                              <span className="font-medium text-foreground">
                                {invoiceLineKindLabels[line.kind]}
                              </span>
                              <span>{line.description}</span>
                              {line.periodStart && line.periodEnd && line.kind !== 'booking' && line.kind !== 'act' && (
                                <span>({formatPeriod(line.periodStart, line.periodEnd)})</span>
                              )}
                              {line.prorataNumerator !== null && (
                                <span>
                                  prorata {line.prorataNumerator}/{line.prorataDenominator}
                                </span>
                              )}
                              <span className="tabular text-foreground">
                                {formatCents(lineNetAmountCents(line), preview.currency)} HT
                              </span>
                              <span>TVA {formatBasisPoints(line.vatRateBp)}</span>
                            </li>
                          ))}
                        </ul>
                      </details>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right tabular">
                      {formatCents(client.totals.exclTaxCents, preview.currency)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right tabular">
                      {formatCents(client.totals.taxCents, preview.currency)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right tabular font-medium">
                      {formatCents(client.totals.inclTaxCents, preview.currency)}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      {!client.existing ? (
                        'Nouveau brouillon'
                      ) : client.existing.status === 'draft' ? (
                        <Link href={`/factures/${client.existing.id}`} className="underline underline-offset-2">
                          Complète le brouillon existant
                        </Link>
                      ) : (
                        <span>
                          <Link href={`/factures/${client.existing.id}`} className="underline underline-offset-2">
                            {client.existing.number}
                          </Link>{' '}
                          {invoiceStatusLabel('invoice', client.existing.status).toLowerCase()} : non
                          modifiable, à facturer à part
                        </span>
                      )}
                    </td>
                  </tr>
                </tbody>
              ))}
            </table>
          </div>
        )}

        {billable.length > 0 && <RunInvoicingForm month={month} label={formatIsoMonth(month)} />}
      </section>

      {warned.length > 0 && (
        <section aria-labelledby="avertissements-titre" className="flex flex-col gap-3">
          <h2 id="avertissements-titre" className="text-lg font-semibold tracking-tight">
            À reprendre à la main
          </h2>
          <p className="text-sm text-muted-foreground">
            Ce que le lot ne sait pas valoriser seul. Ces éléments ne seront pas sur les brouillons :
            complétez la source, ou ajoutez une ligne au brouillon du client.
          </p>
          <ul className="flex flex-col gap-2 rounded-lg border border-border bg-white px-5 py-4 text-sm">
            {warned.flatMap((client) =>
              client.warnings.map((warning, index) => (
                <li key={`${client.clientId}-${index}`}>
                  <span className="font-medium">{client.clientName}</span> — {warning.message}
                </li>
              )),
            )}
          </ul>
        </section>
      )}

      <section aria-labelledby="journal-titre" className="flex flex-col gap-3">
        <h2 id="journal-titre" className="text-lg font-semibold tracking-tight">
          Journal des lots
        </h2>
        {runs.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border bg-white px-6 py-8 text-center text-sm text-muted-foreground">
            Aucun lot lancé pour l’instant. Le premier apparaîtra ici, avec son bilan.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-white">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Derniers lots de facturation, le plus récent d’abord</caption>
              <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Mois</th>
                  <th scope="col" className="px-4 py-3 font-medium">Lancé</th>
                  <th scope="col" className="px-4 py-3 font-medium">Par</th>
                  <th scope="col" className="px-4 py-3 font-medium">État</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Brouillons créés</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Complétés</th>
                  <th scope="col" className="px-4 py-3 text-right font-medium">Avertissements</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {runs.map((run) => (
                  <tr key={run.id}>
                    <td className="px-4 py-3">
                      <Link
                        href={`/factures/preparer?mois=${run.periodStart.slice(0, 7)}&lot=${run.id}`}
                        className="underline-offset-2 hover:underline"
                      >
                        {formatIsoMonth(run.periodStart.slice(0, 7))}
                      </Link>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                      {formatDateTime(run.startedAt, timeZone)}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{run.createdByName}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${runStatusStyles[run.status]}`}
                      >
                        {invoiceRunStatusLabels[run.status]}
                      </span>
                      {run.report.error && (
                        <span className="mt-1 block text-xs text-muted-foreground">{run.report.error}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right tabular">{run.report.invoicesCreated ?? 0}</td>
                    <td className="px-4 py-3 text-right tabular">{run.report.invoicesUpdated ?? 0}</td>
                    <td className="px-4 py-3 text-right tabular">{run.report.warnings?.length ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-sm text-muted-foreground">
          Le relevé des ouvertures de courrier reste disponible comme contrôle ; la facture en est
          désormais la source.
          {can(member.role, 'courrier.releve') && (
            <>
              {' '}
              <Link
                href={`/courrier/ouvertures?mois=${preview.windows.consumption.start.slice(0, 7)}`}
                className="underline underline-offset-2"
              >
                Relevé de {consumptionLabel}
              </Link>
            </>
          )}
        </p>
      </section>
    </div>
  )
}

/** Bilan d'un lot, sur la page où il mène. */
function RunReport({ run, clientNames }: { run: InvoiceRunEntry; clientNames: Map<string, string> }) {
  const { report } = run
  if (run.status === 'failed') {
    return <p>Le lot a échoué : {report.error ?? 'cause inconnue'}. Rien n’a été écrit ; relancez-le.</p>
  }
  if (run.status === 'running') return <p>Le lot est en cours.</p>
  const created = report.invoicesCreated ?? 0
  const updated = report.invoicesUpdated ?? 0
  return (
    <div className="flex flex-col gap-1">
      <p>
        Lot terminé : {created} brouillon{created > 1 ? 's' : ''} créé{created > 1 ? 's' : ''}
        {updated > 0 && `, ${updated} complété${updated > 1 ? 's' : ''}`}, {report.linesCreated ?? 0} ligne
        {(report.linesCreated ?? 0) > 1 ? 's' : ''}.{' '}
        <Link
          href={`/factures?statut=draft&mois=${run.periodStart.slice(0, 7)}`}
          className="font-medium underline underline-offset-2"
        >
          Relire les brouillons
        </Link>
      </p>
      {(report.warnings?.length ?? 0) > 0 && (
        <>
          <p className="font-medium">À reprendre à la main :</p>
          <ul className="list-disc pl-5">
            {report.warnings?.map((warning, index) => (
              <li key={index}>
                {warning.clientId && clientNames.get(warning.clientId)
                  ? `${clientNames.get(warning.clientId)} — `
                  : ''}
                {warning.message}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
