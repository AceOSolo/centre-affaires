import { formatCents } from '../facturation/tarifs.ts'
import { billingSchedule, scheduleTotalCents, type ScheduledContract } from './echeancier.ts'

const dateFormat = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeZone: 'UTC' })

/** Une date de calendrier s'affiche telle quelle : aucun fuseau ne s'y applique. */
function formatIsoDate(isoDate: string): string {
  return dateFormat.format(new Date(`${isoDate}T00:00:00Z`))
}

/**
 * Échéancier prévisionnel du contrat.
 *
 * Calculé à la volée, jamais stocké : tant que la facturation n'est pas émise
 * (tranche 3), l'échéancier n'est qu'une lecture du contrat. Le figer en base
 * créerait une seconde vérité à tenir à jour à chaque avenant.
 */
export function EcheancierTable({
  contract,
  until,
  currency,
}: {
  contract: ScheduledContract
  until: string
  currency: string
}) {
  const periods = billingSchedule(contract, until)

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
            <th className="px-4 py-3 font-medium">Période</th>
            <th className="px-4 py-3 font-medium">Couverture</th>
            <th className="px-4 py-3 text-right font-medium">Montant HT</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {periods.map((period) => (
            <tr key={period.startsOn}>
              <td className="whitespace-nowrap px-4 py-2.5">
                {formatIsoDate(period.startsOn)} – {formatIsoDate(period.endsOn)}
              </td>
              <td className="px-4 py-2.5 text-muted-foreground">
                {/* Le prorata est écrit, pas seulement déduit du montant. */}
                {period.full ? 'Période entière' : 'Prorata temporis'}
              </td>
              <td className="px-4 py-2.5 text-right tabular-nums">
                {formatCents(period.amountCents, currency)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot className="border-t border-border text-sm font-medium">
          <tr>
            <td className="px-4 py-3" colSpan={2}>
              Total sur {periods.length} échéance{periods.length > 1 ? 's' : ''}
            </td>
            <td className="px-4 py-3 text-right tabular-nums">
              {formatCents(scheduleTotalCents(periods), currency)}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}
