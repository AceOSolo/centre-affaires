import Link from 'next/link'

import { requirePermission } from '../../../lib/auth/staff.ts'
import { todayIsoDate } from '../../../lib/dates.ts'
import { currentTenant } from '../../../lib/tenant.ts'
import { billingPeriodLabels, billingPeriodSuffixes } from '../../../modules/contrats/labels.ts'
import { priceOffer } from '../../../modules/facturation/offres-prix.ts'
import {
  listOffers,
  loadOfferCatalogue,
  toOfferInput,
} from '../../../modules/facturation/offres-queries.ts'
import { formatCents } from '../../../modules/facturation/tarifs.ts'

export const metadata = { title: 'Offres groupées' }

/**
 * Offres groupées (R09, ADR 024) : des ressources et des services réunis sous
 * un prix, modèles des contrats qui en seront tirés.
 */
export default async function OffersPage({
  searchParams,
}: {
  searchParams: Promise<{ archives?: string }>
}) {
  await requirePermission('services.gerer')
  const [{ archives }, tenant] = await Promise.all([searchParams, currentTenant()])
  const showArchived = archives === '1'
  const [offers, catalogue] = await Promise.all([
    listOffers({ archived: showArchived }),
    loadOfferCatalogue(todayIsoDate(tenant.timezone)),
  ])

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Offres groupées</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Ressources et{' '}
            <Link href="/services" className="underline underline-offset-2">
              services
            </Link>{' '}
            réunis sous un prix : « Domiciliation Premium », « Bureau tout compris ». Un contrat
            tiré d’une offre en copie les lignes.
          </p>
        </div>
        <Link
          href="/offres/nouvelle"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover"
        >
          Nouvelle offre
        </Link>
      </div>

      <nav aria-label="Filtrer les offres" className="flex gap-4 text-sm">
        <Link
          href="/offres"
          aria-current={showArchived ? undefined : 'page'}
          className="underline-offset-2 hover:underline aria-[current=page]:font-semibold aria-[current=page]:text-primary"
        >
          Proposées
        </Link>
        <Link
          href="/offres?archives=1"
          aria-current={showArchived ? 'page' : undefined}
          className="underline-offset-2 hover:underline aria-[current=page]:font-semibold aria-[current=page]:text-primary"
        >
          Archivées
        </Link>
      </nav>

      {offers.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-white px-6 py-12 text-center">
          <p className="text-sm text-muted-foreground">
            {showArchived
              ? 'Aucune offre archivée.'
              : 'Aucune offre. Créez-en une, puis ajoutez-lui ses ressources et ses services.'}
          </p>
          {!showArchived && (
            <Link
              href="/offres/nouvelle"
              className="mt-4 inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover"
            >
              Créer une offre
            </Link>
          )}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-white">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">
              {showArchived ? 'Offres archivées' : 'Offres proposées'}
            </caption>
            <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">Offre</th>
                <th scope="col" className="px-4 py-3 text-right font-medium">Lignes</th>
                <th scope="col" className="px-4 py-3 font-medium">Facturation</th>
                <th scope="col" className="px-4 py-3 font-medium">Engagement</th>
                <th scope="col" className="px-4 py-3 text-right font-medium">Prix HT</th>
                <th scope="col" className="px-4 py-3 text-right font-medium">Prix TTC</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {offers.map((offer) => {
                const quote = priceOffer(toOfferInput(offer), catalogue)
                return (
                  <tr key={offer.id}>
                    <td className="px-4 py-3">
                      <Link
                        href={`/offres/${offer.id}`}
                        className="font-medium underline-offset-2 hover:underline"
                      >
                        {offer.name}
                      </Link>
                      {offer.description && (
                        <span className="block max-w-prose text-xs text-muted-foreground">
                          {offer.description}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right tabular">{offer.items.length}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {billingPeriodLabels[offer.billingPeriod]}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">
                      {offer.commitmentMonths ? `${offer.commitmentMonths} mois` : 'Sans engagement'}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right tabular">
                      {offer.items.length === 0 ? (
                        <span className="text-muted-foreground">Aucune ligne</span>
                      ) : (
                        <>
                          {formatCents(quote.totalExclTaxCents, quote.currency)}{' '}
                          <span className="text-xs text-muted-foreground">
                            {billingPeriodSuffixes[offer.billingPeriod]}
                          </span>
                          {!quote.complete && (
                            <span className="block text-xs font-medium text-destructive">
                              Prix incomplet
                            </span>
                          )}
                        </>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right tabular text-muted-foreground">
                      {offer.items.length === 0
                        ? '—'
                        : formatCents(quote.totalInclTaxCents, quote.currency)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
