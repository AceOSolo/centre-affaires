import { rateUnitLabels } from '../facturation/labels.ts'
import { formatCents } from '../facturation/tarifs.ts'
import { formatBpAsPercent, linesTotals, targetOf } from './lignes.ts'
import type { ContractLineWithTarget } from './versions.ts'

/**
 * Lignes d'une version de contrat, en lecture (R12, ADR 025) : vrai tableau,
 * montants nets tenus par la base, totaux HT, TVA et TTC par période. Une
 * ligne ponctuelle est dite en toutes lettres.
 */
export function ContractLinesTable({
  lines,
  currency,
  periodSuffix,
  caption,
}: {
  lines: readonly ContractLineWithTarget[]
  currency: string
  periodSuffix: string
  caption: string
}) {
  const money = (cents: number) => formatCents(cents, currency)
  const totals = linesTotals(lines.map((line) => ({ ...line, target: targetOf(line) })))

  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-white">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th scope="col" className="px-4 py-3 font-medium">Désignation</th>
            <th scope="col" className="px-4 py-3 font-medium">Objet</th>
            <th scope="col" className="px-4 py-3 text-right font-medium">Qté</th>
            <th scope="col" className="px-4 py-3 font-medium">Unité</th>
            <th scope="col" className="px-4 py-3 text-right font-medium">PU HT</th>
            <th scope="col" className="px-4 py-3 text-right font-medium">Remise</th>
            <th scope="col" className="px-4 py-3 text-right font-medium">TVA</th>
            <th scope="col" className="px-4 py-3 text-right font-medium">Montant HT</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {lines.map((line) => (
            <tr key={line.id}>
              <td className="px-4 py-2.5">
                {line.description}
                {!line.isRecurring && (
                  <span className="ml-2 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
                    Due une fois
                  </span>
                )}
              </td>
              <td className="px-4 py-2.5 text-muted-foreground">{line.targetLabel ?? '—'}</td>
              <td className="px-4 py-2.5 text-right tabular-nums">{line.quantity}</td>
              <td className="px-4 py-2.5 text-muted-foreground">{rateUnitLabels[line.unit]}</td>
              <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums">
                {money(line.unitPriceCents)}
              </td>
              <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums">
                {line.discountBp !== null
                  ? `${formatBpAsPercent(line.discountBp)} %`
                  : line.discountAmountCents !== null
                    ? money(line.discountAmountCents)
                    : '—'}
              </td>
              <td className="px-4 py-2.5 text-right tabular-nums">
                {formatBpAsPercent(line.vatRateBp)} %
              </td>
              <td className="whitespace-nowrap px-4 py-2.5 text-right tabular-nums">
                {money(line.netAmountCents ?? 0)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot className="border-t border-border text-sm">
          <tr>
            <th scope="row" colSpan={7} className="px-4 py-2 text-right font-medium">
              Récurrent HT {periodSuffix}
            </th>
            <td className="whitespace-nowrap px-4 py-2 text-right font-medium tabular-nums">
              {money(totals.recurringNetCents)}
            </td>
          </tr>
          {totals.recurringVat.map((group) => (
            <tr key={group.vatRateBp}>
              <th scope="row" colSpan={7} className="px-4 py-1 text-right font-normal text-muted-foreground">
                TVA {formatBpAsPercent(group.vatRateBp)} %
              </th>
              <td className="whitespace-nowrap px-4 py-1 text-right tabular-nums">{money(group.vatCents)}</td>
            </tr>
          ))}
          <tr>
            <th scope="row" colSpan={7} className="px-4 py-2 text-right font-medium">
              Récurrent TTC {periodSuffix}
            </th>
            <td className="whitespace-nowrap px-4 py-2 text-right font-medium tabular-nums">
              {money(totals.recurringGrossCents)}
            </td>
          </tr>
          {totals.oneOffNetCents > 0 && (
            <tr>
              <th scope="row" colSpan={7} className="px-4 py-2 text-right font-normal text-muted-foreground">
                Ponctuel HT, dû une fois
              </th>
              <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums">
                {money(totals.oneOffNetCents)}
              </td>
            </tr>
          )}
        </tfoot>
      </table>
    </div>
  )
}
