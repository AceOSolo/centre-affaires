import Link from 'next/link'
import { notFound } from 'next/navigation'

import {
  addDaysToIsoDate,
  formatLongDate,
  formatTime,
  todayIsoDate,
} from '../../../../lib/dates.ts'
import { currentTenant } from '../../../../lib/tenant.ts'
import { rateUnitLabels, rateUnitSuffixes } from '../../../../modules/facturation/labels.ts'
import { findDefaultRatePlan } from '../../../../modules/facturation/queries.ts'
import { formatCents, resolveRate } from '../../../../modules/facturation/tarifs.ts'
import { listBookingsBetween } from '../../../../modules/reservations/queries.ts'
import { occupiesResource } from '../../../../modules/reservations/availability.ts'
import { freeMinutes, freeRanges } from '../../../../modules/reservations/slots.ts'
import { findPublishedListing } from '../../../../modules/ressources/annonces-queries.ts'
import { describeAttributes, resourceTypeLabels } from '../../../../modules/ressources/labels.ts'
import { loadOpeningContext } from '../../../../modules/ressources/ouverture-queries.ts'
import { openingWindows } from '../../../../modules/ressources/ouverture.ts'
import { rateUnits } from '../../../../modules/facturation/schema.ts'

/** Sept jours : assez pour décider, assez court pour rester juste. */
const JOURS_AFFICHES = 7

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const listing = await findPublishedListing(slug)
  if (!listing) return { title: 'Annonce introuvable' }
  return {
    title: listing.headline,
    description:
      listing.description?.slice(0, 160) ??
      `${resourceTypeLabels[listing.resource.resourceType]} à louer.`,
  }
}

export default async function AnnoncePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const listing = await findPublishedListing(slug)
  if (!listing) notFound()

  const tenant = await currentTenant()
  const timeZone = tenant.timezone
  const today = todayIsoDate(timeZone)
  const dernierJour = addDaysToIsoDate(today, JOURS_AFFICHES - 1)

  const [plan, bookings, contexte] = await Promise.all([
    findDefaultRatePlan(today),
    listBookingsBetween(today, dernierJour, timeZone),
    loadOpeningContext(today, dernierJour),
  ])

  // Les créneaux libres sont cherchés à l'intérieur des vraies plages
  // d'ouverture : la pause déjeuner n'est pas un créneau libre (ADR 010).
  const occupe = bookings.filter(
    (booking) => booking.resourceId === listing.resourceId && occupiesResource(booking.status),
  )
  const jours = Array.from({ length: JOURS_AFFICHES }, (_, index) =>
    addDaysToIsoDate(today, index),
  ).map((isoDate) => {
    const windows = openingWindows(isoDate, timeZone, {
      rules: contexte.rules,
      closures: contexte.closures,
      resourceId: listing.resourceId,
    })
    const free = windows.flatMap((window) => freeRanges(window, occupe))
    return { isoDate, closed: windows.length === 0, free, minutes: freeMinutes(free) }
  })

  const tarifs = plan
    ? rateUnits
        .map((unit) => ({
          unit,
          rate: resolveRate(plan, {
            resourceId: listing.resourceId,
            resourceType: listing.resource.resourceType,
            unit,
            on: today,
          }),
        }))
        .filter((ligne) => ligne.rate)
    : []

  const details = describeAttributes(listing.resource.attributes ?? {})

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-6 py-10">
      <div>
        <Link href="/annonces" className="text-sm text-muted-foreground hover:underline">
          ← Tous nos espaces
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
            {resourceTypeLabels[listing.resource.resourceType]}
          </span>
          {listing.resource.capacity !== null && (
            <span className="text-sm text-muted-foreground">
              {listing.resource.capacity} personnes
            </span>
          )}
        </div>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">{listing.headline}</h1>
      </div>

      {listing.description && (
        <p className="max-w-2xl whitespace-pre-line text-muted-foreground">
          {listing.description}
        </p>
      )}

      {(listing.highlights.length > 0 || details) && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold tracking-tight">Ce que comprend l’espace</h2>
          <ul className="flex flex-wrap gap-2">
            {listing.highlights.map((point) => (
              <li
                key={point}
                className="rounded-full border border-border px-3 py-1 text-sm text-muted-foreground"
              >
                {point}
              </li>
            ))}
            {details &&
              details.split(' · ').map((detail) => (
                <li
                  key={detail}
                  className="rounded-full border border-border px-3 py-1 text-sm text-muted-foreground"
                >
                  {detail}
                </li>
              ))}
          </ul>
        </section>
      )}

      {tarifs.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold tracking-tight">Tarifs</h2>
          <div className="overflow-x-auto rounded-lg border border-border bg-white">
            <table className="w-full text-left text-sm">
              <tbody className="divide-y divide-border">
                {tarifs.map(({ unit, rate }) => (
                  <tr key={unit}>
                    <th scope="row" className="px-4 py-2.5 text-left font-medium">
                      {rateUnitLabels[unit]}
                    </th>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {formatCents(rate!.amountCents, plan?.currency ?? 'EUR')}{' '}
                      <span className="text-xs text-muted-foreground">
                        {rateUnitSuffixes[unit]} HT
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold tracking-tight">
          Disponibilités des {JOURS_AFFICHES} prochains jours
        </h2>
        <div className="flex flex-col gap-2">
          {jours.map((jour) => (
            <div
              key={jour.isoDate}
              className="flex flex-wrap items-baseline gap-x-4 gap-y-1 rounded-lg border border-border bg-white px-4 py-3"
            >
              <span className="w-56 shrink-0 text-sm font-medium capitalize">
                {formatLongDate(jour.isoDate, timeZone)}
              </span>
              {jour.closed ? (
                <span className="text-sm text-muted-foreground">Fermé</span>
              ) : jour.free.length === 0 ? (
                <span className="text-sm text-muted-foreground">Complet</span>
              ) : (
                <span className="flex flex-wrap gap-2">
                  {jour.free.map((creneau) => (
                    <Link
                      key={creneau.startsAt.toISOString()}
                      href={`/?date=${jour.isoDate}`}
                      className="rounded-full bg-accent/15 px-3 py-0.5 text-sm tabular-nums text-primary hover:bg-accent/25"
                    >
                      {formatTime(creneau.startsAt, timeZone)} –{' '}
                      {formatTime(creneau.endsAt, timeZone)}
                    </Link>
                  ))}
                </span>
              )}
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Heures affichées en {timeZone}. Une demande de créneau est confirmée par le centre
          avant d’être définitive.
        </p>
      </section>

      <div>
        <Link
          href={`/?date=${today}`}
          className="inline-block rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-white hover:bg-primary-hover"
        >
          Demander un créneau
        </Link>
      </div>
    </div>
  )
}
