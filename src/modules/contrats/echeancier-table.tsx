import type { ProrataRule } from '../../db/tenants.ts'
import { formatCents } from '../facturation/tarifs.ts'
import {
  billingSchedule,
  scheduleTotalCents,
  type ScheduleOptions,
  type ScheduledContract,
  type ScheduledPeriod,
} from './echeancier.ts'

const dateFormat = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeZone: 'UTC' })

/** Une date de calendrier s'affiche telle quelle : aucun fuseau ne s'y applique. */
function formatIsoDate(isoDate: string): string {
  return dateFormat.format(new Date(`${isoDate}T00:00:00Z`))
}

/**
 * Ce que couvre une échéance, en toutes lettres : la fraction de prorata est
 * écrite, pas seulement déduite du montant (ADR 023).
 */
function describeCoverage(period: ScheduledPeriod, rule: ProrataRule): string {
  if (period.full) return 'Période entière'
  if (rule === 'none') return 'Période entamée, due en entier'
  const fraction = `${period.prorata.numerator}/${period.prorata.denominator}`
  return rule === 'thirty_day_month' ? `Prorata ${fraction} (base 30)` : `Prorata ${fraction} jours`
}

/**
 * Échéancier prévisionnel du contrat.
 *
 * Calculé à la volée, jamais stocké : il se lit depuis les versions de prix du
 * contrat et la règle de prorata du centre (ADR 023, ADR 025). Ce qui est figé,
 * c'est la facture (ADR 026).
 */
export function EcheancierTable({
  contract,
  until,
  currency,
  options = {},
}: {
  contract: ScheduledContract
  until: string
  currency: string
  /** Règle de prorata du centre et versions de prix (`loadContractScheduleOptions`). */
  options?: ScheduleOptions
}) {
  const periods = billingSchedule(contract, until, options)
  const rule = options.prorataRule ?? 'calendar_days'
  const versioned = periods.some((period) => period.amendmentNumber !== null)

  if (periods.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Aucune échéance avant le {formatIsoDate(until)}.
      </p>
    )
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-white">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">
          Échéancier prévisionnel jusqu’au {formatIsoDate(until)}
        </caption>
        <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th scope="col" className="px-4 py-3 font-medium">Période</th>
            <th scope="col" className="px-4 py-3 font-medium">Couverture</th>
            {versioned && <th scope="col" className="px-4 py-3 font-medium">Prix</th>}
            <th scope="col" className="px-4 py-3 text-right font-medium">Montant HT</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {periods.map((period) => (
            <tr key={`${period.startsOn}-${period.amendmentNumber ?? 0}`}>
              <td className="whitespace-nowrap px-4 py-2.5 tabular">
                {formatIsoDate(period.startsOn)} – {formatIsoDate(period.endsOn)}
              </td>
              <td className="px-4 py-2.5 text-muted-foreground">
                {describeCoverage(period, rule)}
                {period.oneOffCents > 0 && (
                  <span className="block text-xs">
                    dont frais ponctuels : {formatCents(period.oneOffCents, currency)}
                  </span>
                )}
              </td>
              {versioned && (
                <td className="px-4 py-2.5 text-muted-foreground">
                  {period.amendmentNumber === null
                    ? 'Contrat initial'
                    : `Avenant n° ${period.amendmentNumber}`}
                </td>
              )}
              <td className="px-4 py-2.5 text-right tabular">
                {formatCents(period.amountCents, currency)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot className="border-t border-border text-sm font-medium">
          <tr>
            <td className="px-4 py-3" colSpan={versioned ? 3 : 2}>
              Total sur {periods.length} échéance{periods.length > 1 ? 's' : ''}
            </td>
            <td className="px-4 py-3 text-right tabular">
              {formatCents(scheduleTotalCents(periods), currency)}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}
