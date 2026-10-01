import type { ReactNode } from 'react'

import { billingPeriodSuffixes } from '../contrats/labels.ts'
import type { OfferQuote, PricedOfferLine } from './offres-prix.ts'
import { formatBp } from './saisie.ts'
import type { BillingPeriod } from './schema.ts'
import { formatQuantity } from './services-labels.ts'
import { formatCents } from './tarifs.ts'

/**
 * Lignes chiffrées d'une offre et son prix total (R09) : sur la page de
 * l'offre, et dans l'aperçu du formulaire de ligne.
 *
 * Sans état ni effet : rendu sur le serveur dans la page, dans le navigateur
 * dans l'aperçu. Un défaut se lit au texte (« Prix manquant »), jamais à la
 * seule couleur.
 */

/** « −12,5 % », « −50,00 € », « prix de l'offre » : comment la ligne s'écarte du catalogue. */
export function describeAdjustment(line: PricedOfferLine, currency: string): string {
  if (line.discountBp !== null) return `−${formatBp(line.discountBp)}`
  if (line.discountAmountCents !== null) return `−${formatCents(line.discountAmountCents, currency)}`
  if (line.priceSource === 'offer') return 'Prix de l’offre'
  return '—'
}

export function OfferQuoteTable({
  quote,
  caption,
  actions,
  highlightId,
}: {
  quote: OfferQuote
  caption: string
  /** Boutons d'une ligne (modifier, retirer), sur la page de l'offre. */
  actions?: (line: PricedOfferLine) => ReactNode
  /** Ligne mise en avant : celle de l'aperçu. */
  highlightId?: string
}) {
  const { currency } = quote
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-white">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th scope="col" className="px-4 py-3 font-medium">Désignation</th>
            <th scope="col" className="px-4 py-3 text-right font-medium">Quantité</th>
            <th scope="col" className="px-4 py-3 text-right font-medium">Prix unitaire HT</th>
            <th scope="col" className="px-4 py-3 font-medium">Remise</th>
            <th scope="col" className="px-4 py-3 text-right font-medium">Montant HT</th>
            <th scope="col" className="px-4 py-3 text-right font-medium">TVA</th>
            {actions && (
              <th scope="col" className="px-4 py-3">
                <span className="sr-only">Actions</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {quote.lines.map((line) => (
            <tr key={line.id} className={line.id === highlightId ? 'bg-accent/5' : undefined}>
              <td className="px-4 py-3">
                <span className="font-medium">{line.label}</span>
                {line.id === highlightId && (
                  <span className="ml-2 rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium text-primary">
                    Aperçu
                  </span>
                )}
                {line.includedActs !== null && line.problem === null && (
                  <span className="block text-xs text-muted-foreground">
                    {line.includedActs} inclus par période, puis{' '}
                    {line.extraActNetCents !== null
                      ? `${formatCents(line.extraActNetCents, currency)} HT l’acte`
                      : 'prix à fixer'}
                  </span>
                )}
                {line.problem && (
                  <span className="block text-xs font-medium text-destructive">
                    À corriger : {line.problem}
                  </span>
                )}
                {line.notice && (
                  <span className="block text-xs text-muted-foreground">Remarque : {line.notice}</span>
                )}
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-right tabular">
                {formatQuantity(line.quantity, line.unit)}
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-right tabular">
                {line.unitPriceCents !== null ? (
                  <>
                    {formatCents(line.unitPriceCents, currency)}
                    <span className="block text-xs text-muted-foreground">
                      {line.priceSource === 'offer' ? 'prix de l’offre' : 'catalogue'}
                    </span>
                  </>
                ) : (
                  <span className="text-xs font-medium text-destructive">Prix manquant</span>
                )}
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                {describeAdjustment(line, currency)}
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-right tabular">
                {line.netAmountCents === null
                  ? '—'
                  : line.kind === 'act'
                    ? 'Inclus'
                    : formatCents(line.netAmountCents, currency)}
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-right tabular text-muted-foreground">
                {line.vatAmountCents === null || line.kind === 'act' ? (
                  '—'
                ) : (
                  <>
                    {formatCents(line.vatAmountCents, currency)}
                    <span className="block text-xs">{formatBp(line.vatRateBp)}</span>
                  </>
                )}
              </td>
              {actions && <td className="whitespace-nowrap px-4 py-3 text-right">{actions(line)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Totaux d'une période de facturation, et sur la durée d'engagement. */
export function OfferQuoteTotals({
  quote,
  billingPeriod,
}: {
  quote: OfferQuote
  billingPeriod: BillingPeriod
}) {
  const { currency } = quote
  const suffix = billingPeriodSuffixes[billingPeriod]
  return (
    <div className="flex flex-col gap-3">
      <dl className="ml-auto grid w-full max-w-md grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm">
        {quote.listAmountCents !== null && quote.savingsCents !== null && quote.savingsCents !== 0 && (
          <>
            <dt className="text-muted-foreground">Prix catalogue de l’ensemble</dt>
            <dd className="text-right tabular text-muted-foreground">
              {formatCents(quote.listAmountCents, currency)}
            </dd>
            <dt className="text-muted-foreground">
              {quote.savingsCents > 0 ? 'Remise de l’offre' : 'Supplément de l’offre'}
            </dt>
            <dd className="text-right tabular text-muted-foreground">
              {quote.savingsCents > 0 ? '−' : '+'}
              {formatCents(Math.abs(quote.savingsCents), currency)}
            </dd>
          </>
        )}
        <dt className="font-medium">Total HT {suffix}</dt>
        <dd className="text-right font-medium tabular">
          {formatCents(quote.totalExclTaxCents, currency)}
        </dd>
        {quote.vatBreakdown.map((group) => (
          <FragmentRow
            key={group.vatRateBp}
            label={`TVA ${formatBp(group.vatRateBp)} sur ${formatCents(group.taxableAmountCents, currency)}`}
            value={formatCents(group.vatAmountCents, currency)}
          />
        ))}
        <dt className="font-semibold text-primary">Total TTC {suffix}</dt>
        <dd className="text-right font-semibold tabular text-primary">
          {formatCents(quote.totalInclTaxCents, currency)}
        </dd>
        {quote.commitment && (
          <>
            <dt className="pt-2 text-muted-foreground">
              Sur l’engagement de {quote.commitment.months} mois ({quote.commitment.periods}{' '}
              période{quote.commitment.periods > 1 ? 's' : ''})
            </dt>
            <dd className="pt-2 text-right tabular text-muted-foreground">
              {formatCents(quote.commitment.totalExclTaxCents, currency)} HT
              <span className="block">{formatCents(quote.commitment.totalInclTaxCents, currency)} TTC</span>
            </dd>
          </>
        )}
      </dl>
      {!quote.complete && quote.lines.length > 0 && (
        <p className="text-sm text-destructive">
          Prix incomplet : {quote.problems.length} ligne{quote.problems.length > 1 ? 's' : ''} à
          corriger, hors du total.
        </p>
      )}
    </div>
  )
}

function FragmentRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right tabular text-muted-foreground">{value}</dd>
    </>
  )
}
