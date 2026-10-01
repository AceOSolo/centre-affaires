import type { ProrataRule } from '../../db/tenants.ts'
import { formatCents } from '../facturation/tarifs.ts'
import {
  contractSchedule,
  scheduleTotalCents,
  type ScheduledContract,
  type SchedulePiece,
  type ScheduleVersion,
} from './echeancier.ts'

const dateFormat = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeZone: 'UTC' })

/** Une date de calendrier s'affiche telle quelle : aucun fuseau ne s'y applique. */
function formatIsoDate(isoDate: string): string {
  return dateFormat.format(new Date(`${isoDate}T00:00:00Z`))
}

/** « version initiale », « avenant n° 2 ». */
function versionLabel(piece: SchedulePiece): string {
  return piece.amendmentNumber === null ? 'version initiale' : `avenant n° ${piece.amendmentNumber}`
}

/** Le prorata est écrit, pas seulement déduit du montant : « prorata 14/30 ». */
function coverageLabel(piece: SchedulePiece): string {
  if (piece.numerator === 0) return 'compté à partir de la période suivante'
  if (piece.numerator === piece.denominator) return 'période commencée, due en entier'
  return `prorata ${piece.numerator}/${piece.denominator}`
}

/**
 * Échéancier prévisionnel du contrat (ADR 006, 023, 025).
 *
 * Calculé à la volée, jamais stocké : ce qui se fige, c'est la facture. Chaque
 * période civile est coupée aux dates d'effet des avenants, chaque morceau
 * proratisé selon la règle du centre ; la colonne « Détail » le dit en toutes
 * lettres.
 */
export function EcheancierTable({
  contract,
  versions = [],
  rule = 'calendar_days',
  until,
  currency,
}: {
  contract: ScheduledContract
  /** Versions de prix (`contract_price_versions`) ; vide : le seul montant du contrat. */
  versions?: readonly ScheduleVersion[]
  rule?: ProrataRule
  until: string
  currency: string
}) {
  const periods = contractSchedule(contract, versions, until, rule)
  const versioned = periods.some((period) => period.pieces.some((piece) => piece.amendmentId !== null))

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
            <th scope="col" className="px-4 py-3 font-medium">Détail</th>
            <th scope="col" className="px-4 py-3 text-right font-medium">Montant HT</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {periods.map((period) => {
            const single = period.pieces.length === 1 ? period.pieces[0] : undefined
            return (
              <tr key={period.startsOn}>
                <td className="whitespace-nowrap px-4 py-2.5 align-top">
                  {formatIsoDate(period.startsOn)} – {formatIsoDate(period.endsOn)}
                </td>
                <td className="px-4 py-2.5 text-muted-foreground">
                  {period.pieces.map((piece) => (
                    <span key={piece.startsOn} className="block">
                      {period.pieces.length > 1 &&
                        `Du ${formatIsoDate(piece.startsOn)} au ${formatIsoDate(piece.endsOn)} : `}
                      {versioned && `${versionLabel(piece)}, `}
                      {single && period.full ? 'période entière' : coverageLabel(piece)}
                      {piece.oneOffCents > 0 &&
                        ` ; frais dus une fois : ${formatCents(piece.oneOffCents, currency)}`}
                    </span>
                  ))}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 text-right align-top tabular-nums">
                  {formatCents(period.amountCents, currency)}
                </td>
              </tr>
            )
          })}
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
