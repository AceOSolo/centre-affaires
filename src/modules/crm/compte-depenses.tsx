import Link from 'next/link'

import { ChevronLeftIcon, ChevronRightIcon } from '../../components/ui/icons.tsx'
import { formatCalendarDate, formatIsoMonth } from '../../lib/dates.ts'
import { formatCents } from '../facturation/tarifs.ts'
import { expensePricingLabels, type ExpenseLine, type ExpenseMonth, type ExpenseTotal } from './depenses.ts'

/**
 * « Mes dépenses » dans l'espace client (ADR 081) : le mois choisi en détail,
 * puis les mois passés en résumé. Une estimation, dite comme telle : le site
 * ne facture rien, le centre facture par son CRM.
 *
 * Mobile d'abord (R25) : tableaux dans une enveloppe qui défile de côté, liens
 * de 44 px de haut, montants alignés (`tabular`).
 */

const navLink =
  'inline-flex min-h-11 items-center gap-1.5 rounded-md border border-border bg-white px-3 text-sm font-medium text-primary transition-colors duration-150 ease-out hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

const monthLabel = (month: string) => {
  const label = formatIsoMonth(month)
  return label.charAt(0).toUpperCase() + label.slice(1)
}

/** « 245,00 € », « 120,00 € + 15,00 $ » ; « 0,00 € » sans montant connu. */
export function formatTotals(totals: readonly ExpenseTotal[], pick: (total: ExpenseTotal) => number): string {
  if (totals.length === 0) return formatCents(0)
  return totals.map((total) => formatCents(pick(total), total.currency)).join(' + ')
}

function LineAmount({ line }: { line: ExpenseLine }) {
  const money = (cents: number) => formatCents(cents, line.currency ?? 'EUR')
  return (
    <>
      {line.amountCents === null ? (
        <span className="text-muted-foreground">
          —<span className="sr-only"> (chiffré sur la facture)</span>
        </span>
      ) : (
        <span className="font-medium">{money(line.amountCents)}</span>
      )}
      {line.feesCents !== null && line.feesCents > 0 && (
        <span className="block text-xs text-muted-foreground">+ {money(line.feesCents)} d’affranchissement</span>
      )}
    </>
  )
}

function ExpenseTable({ lines, caption }: { lines: readonly ExpenseLine[]; caption: string }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-white">
      <table className="w-full text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-muted text-left text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              Date
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Prestation
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              Montant HT
            </th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={line.key} className="border-t border-border align-top">
              <td className="px-3 py-2 whitespace-nowrap tabular">{formatCalendarDate(line.day).slice(0, 5)}</td>
              <td className="px-3 py-2">
                <span className="font-medium">{line.label}</span>
                {line.upcoming && (
                  <span className="ml-2 inline-flex rounded-full border border-primary px-2 py-0.5 text-xs font-medium text-primary">
                    À venir
                  </span>
                )}
                <span className="block text-muted-foreground">{line.detail}</span>
                {line.kind !== 'fixed' && line.pricing !== 'quote' && (
                  <span className="block text-xs text-muted-foreground">{expensePricingLabels[line.pricing]}</span>
                )}
                {line.feesPending && (
                  <span className="block text-xs text-muted-foreground">Affranchissement pas encore relevé.</span>
                )}
              </td>
              <td className="px-3 py-2 text-right whitespace-nowrap tabular">
                <LineAmount line={line} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function ClientExpenses({
  months,
  selected,
  note,
  accounts,
}: {
  /** Les mois montrés, du plus récent au plus ancien, chacun calculé. */
  months: readonly ExpenseMonth[]
  selected: string
  /** La phrase du centre sous le total. */
  note: string
  accounts: readonly { clientId: string; clientName: string }[]
}) {
  const index = Math.max(
    0,
    months.findIndex((month) => month.month === selected),
  )
  const month = months[index]
  if (!month) return null
  const newer = months[index - 1]
  const older = months[index + 1]
  const several = accounts.length > 1
  const groups = several
    ? accounts
        .map((account) => ({ ...account, lines: month.lines.filter((line) => line.clientId === account.clientId) }))
        .filter((group) => group.lines.length > 0)
    : [{ clientId: accounts[0]?.clientId ?? '', clientName: accounts[0]?.clientName ?? '', lines: month.lines }]

  return (
    <section aria-labelledby="depenses" className="flex max-w-3xl flex-col gap-4">
      <div>
        <h2 id="depenses" className="text-xl font-semibold tracking-tight text-primary">
          Mes dépenses
        </h2>
        <p className="mt-1 max-w-prose text-sm text-muted-foreground">
          Les frais fixes de vos contrats et les prestations du mois : réservations, courrier,
          affranchissement. Une estimation : la facture du centre fait foi.
        </p>
      </div>

      <nav aria-label="Choisir le mois" className="flex flex-wrap items-center justify-between gap-2">
        {older ? (
          <Link href={`?mois=${older.month}#depenses`} className={navLink}>
            <ChevronLeftIcon size={20} />
            {monthLabel(older.month)}
          </Link>
        ) : (
          <span />
        )}
        <h3 className="text-base font-semibold" aria-live="polite">
          {monthLabel(month.month)}
          {month.current && <span className="font-normal text-muted-foreground"> (en cours)</span>}
        </h3>
        {newer ? (
          <Link href={`?mois=${newer.month}#depenses`} className={navLink}>
            {monthLabel(newer.month)}
            <ChevronRightIcon size={20} />
          </Link>
        ) : (
          <span />
        )}
      </nav>

      <div className="rounded-lg border border-border bg-muted px-4 py-4 sm:px-5">
        <p className="text-sm text-muted-foreground">Total estimé du mois, hors taxes</p>
        <p className="text-2xl font-semibold tracking-tight text-primary tabular">
          {formatTotals(month.totals, (total) => total.totalCents)} <span className="text-base font-normal">HT</span>
        </p>
        <p className="mt-1 text-sm">{note}</p>
        {(month.unpriced > 0 || month.feesPending > 0 || month.current) && (
          <ul className="mt-2 flex flex-col gap-1 text-sm text-muted-foreground">
            {month.unpriced > 0 && (
              <li>
                {month.unpriced} prestation{month.unpriced > 1 ? 's' : ''} sans tarif connu ici, chiffrée
                {month.unpriced > 1 ? 's' : ''} sur la facture : le total ne {month.unpriced > 1 ? 'les' : 'la'} compte pas.
              </li>
            )}
            {month.feesPending > 0 && (
              <li>
                {month.feesPending} réexpédition{month.feesPending > 1 ? 's' : ''} dont l’affranchissement n’est pas encore
                relevé.
              </li>
            )}
            {month.current && <li>Le courrier du mois s’ajoute jusqu’à sa fin.</li>}
          </ul>
        )}
      </div>

      {month.lines.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          Aucune dépense en {formatIsoMonth(month.month)}.
        </p>
      ) : (
        groups.map((group) => (
          <div key={group.clientId} className="flex flex-col gap-2">
            {several && <h4 className="text-sm font-semibold">{group.clientName}</h4>}
            <ExpenseTable
              lines={group.lines}
              caption={`Dépenses de ${formatIsoMonth(month.month)}${several ? `, ${group.clientName}` : ''}`}
            />
          </div>
        ))
      )}

      {months.length > 1 && (
        <div className="flex flex-col gap-2">
          <h3 className="text-base font-semibold">Mois par mois</h3>
          <div className="overflow-x-auto rounded-lg border border-border bg-white">
            <table className="w-full text-sm">
              <caption className="sr-only">Total estimé de chaque mois, hors taxes</caption>
              <thead className="bg-muted text-left text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">
                    Mois
                  </th>
                  <th scope="col" className="hidden px-3 py-2 text-right font-medium sm:table-cell">
                    Frais fixes
                  </th>
                  <th scope="col" className="hidden px-3 py-2 text-right font-medium sm:table-cell">
                    Prestations
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    Total HT
                  </th>
                  <th scope="col" className="px-3 py-2">
                    <span className="sr-only">Détail</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {months.map((row) => (
                  <tr
                    key={row.month}
                    className={`border-t border-border ${row.month === month.month ? 'bg-accent/10' : ''}`}
                    aria-current={row.month === month.month ? 'true' : undefined}
                  >
                    <th scope="row" className="px-3 py-1 text-left font-medium whitespace-nowrap">
                      {monthLabel(row.month)}
                      {row.current && <span className="font-normal text-muted-foreground"> (en cours)</span>}
                    </th>
                    <td className="hidden px-3 py-1 text-right whitespace-nowrap tabular sm:table-cell">
                      {formatTotals(row.totals, (total) => total.fixedCents)}
                    </td>
                    <td className="hidden px-3 py-1 text-right whitespace-nowrap tabular sm:table-cell">
                      {formatTotals(row.totals, (total) => total.servicesCents)}
                    </td>
                    <td className="px-3 py-1 text-right font-medium whitespace-nowrap tabular">
                      {formatTotals(row.totals, (total) => total.totalCents)}
                      {row.unpriced > 0 && (
                        <>
                          <span aria-hidden="true" className="text-muted-foreground"> +</span>
                          <span className="sr-only">, plus des prestations chiffrées sur la facture</span>
                        </>
                      )}
                    </td>
                    <td className="px-3 py-1 text-right">
                      {row.month === month.month ? (
                        <span className="inline-flex min-h-11 items-center text-xs text-muted-foreground">Affiché</span>
                      ) : (
                        <Link
                          href={`?mois=${row.month}#depenses`}
                         
                          className="inline-flex min-h-11 items-center px-1 text-sm font-medium whitespace-nowrap text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                        >
                          Détail<span className="sr-only"> de {formatIsoMonth(row.month)}</span>
                        </Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">
            « + » : des prestations du mois sont chiffrées sur la facture, en plus de ce total.
          </p>
        </div>
      )}
    </section>
  )
}
