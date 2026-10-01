import type { BookingQuote, QuoteDisplay } from './devis.ts'
import type { RateUnit } from './schema.ts'
import { formatBasisPoints, formatCents } from './tarifs.ts'

/**
 * Affichage d'un devis de réservation (R11) : le même partout — formulaire du
 * back-office, page publique, fiche de la réservation. Composant sans état ni
 * accès serveur : il s'emploie dans un composant serveur comme client.
 */

const quantityWords: Record<RateUnit, [singular: string, plural: string]> = {
  hour: ['heure', 'heures'],
  half_day: ['demi-journée', 'demi-journées'],
  day: ['journée', 'journées'],
  week: ['semaine', 'semaines'],
  month: ['mois', 'mois'],
  unit: ['prestation', 'prestations'],
}

/** « 1 journée », « 3 demi-journées ». */
export function formatQuoteQuantity(unit: RateUnit, quantity: number): string {
  const [singular, plural] = quantityWords[unit]
  return `${quantity} ${quantity > 1 ? plural : singular}`
}

/** D'où vient le prix, dit au staff : la grille du contrat du client ou celle du centre. */
export function quotePlanLabel(quote: Pick<BookingQuote, 'source' | 'ratePlanName'>): string {
  return quote.source.kind === 'contract'
    ? `Grille « ${quote.ratePlanName} » (contrat ${quote.source.contractReference})`
    : `Grille « ${quote.ratePlanName} » (par défaut du centre)`
}

/** « 1 journée × 130,00 € HT » */
export function describeQuoteLine(quote: QuoteDisplay): string {
  return `${formatQuoteQuantity(quote.unit, quote.quantity)} × ${formatCents(quote.unitPriceCents, quote.currency)} HT`
}

/**
 * Détail du devis : unité et quantité, remise, HT, TVA, TTC. Les montants sont
 * alignés en chiffres tabulaires ; le total se lit en toutes lettres
 * (« Total TTC »), pas à sa seule graisse.
 */
export function QuoteSummary({
  quote,
  planLabel,
  className = '',
}: {
  quote: QuoteDisplay
  /** D'où vient le prix : « Grille par défaut », « Grille du contrat CT-2026-0003 ». */
  planLabel?: string
  className?: string
}) {
  const row = 'flex items-baseline justify-between gap-4'
  return (
    <dl className={`flex flex-col gap-1 text-sm ${className}`}>
      <div className={row}>
        <dt className="text-muted-foreground">Tarif</dt>
        <dd className="tabular text-right">{describeQuoteLine(quote)}</dd>
      </div>
      {planLabel && (
        <div className={row}>
          <dt className="text-muted-foreground">Grille</dt>
          <dd className="text-right">{planLabel}</dd>
        </div>
      )}
      {quote.discountCents > 0 && (
        <div className={row}>
          <dt className="text-muted-foreground">
            Remise{quote.discountBp ? ` de ${formatBasisPoints(quote.discountBp)}` : ''}
          </dt>
          <dd className="tabular text-right">− {formatCents(quote.discountCents, quote.currency)}</dd>
        </div>
      )}
      <div className={row}>
        <dt className="text-muted-foreground">Montant HT</dt>
        <dd className="tabular text-right">{formatCents(quote.netCents, quote.currency)}</dd>
      </div>
      <div className={row}>
        <dt className="text-muted-foreground">TVA {formatBasisPoints(quote.vatRateBp)}</dt>
        <dd className="tabular text-right">{formatCents(quote.vatCents, quote.currency)}</dd>
      </div>
      <div className={`${row} border-t border-border pt-1 font-medium`}>
        <dt>Total TTC</dt>
        <dd className="tabular text-right">{formatCents(quote.totalCents, quote.currency)}</dd>
      </div>
    </dl>
  )
}
