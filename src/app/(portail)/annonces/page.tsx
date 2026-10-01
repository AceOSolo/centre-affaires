import Link from 'next/link'

import { todayIsoDate } from '../../../lib/dates.ts'
import { currentTenant } from '../../../lib/tenant.ts'
import { findDefaultRatePlan } from '../../../modules/facturation/queries.ts'
import { rateUnitSuffixes } from '../../../modules/facturation/labels.ts'
import { formatCents, resolveRate } from '../../../modules/facturation/tarifs.ts'
import { listDayAvailability } from '../../../modules/reservations/queries.ts'
import { listPublishedListings } from '../../../modules/ressources/annonces-queries.ts'
import { describeAttributes, resourceTypeLabels } from '../../../modules/ressources/labels.ts'
import type { RateUnit } from '../../../modules/facturation/schema.ts'

export const metadata = {
  title: 'Salles, bureaux et véhicules à louer',
  description:
    'Le catalogue du centre : salles de réunion, bureaux privatifs et véhicules, avec leurs tarifs et leurs disponibilités du jour.',
}

/**
 * Rendu à chaque visite.
 *
 * La page annonce les disponibilités du jour : prérendue au build, elle
 * afficherait éternellement celles du jour de compilation. La revalidation par
 * chemin ne suffirait pas non plus — une réservation posée en back-office change
 * ce qui est libre, et elle ne passe pas par cette page.
 */
export const dynamic = 'force-dynamic'

/** Unités cherchées dans la grille, de la plus fine à la plus large. */
const UNITES: RateUnit[] = ['hour', 'half_day', 'day', 'week', 'month', 'unit']

export default async function CataloguePage() {
  const tenant = await currentTenant()
  const timeZone = tenant.timezone
  const today = todayIsoDate(timeZone)

  const [listings, plan, availability] = await Promise.all([
    listPublishedListings(),
    findDefaultRatePlan(),
    listDayAvailability(today, timeZone),
  ])

  const dispoParRessource = new Map(availability.map((entry) => [entry.resource.id, entry]))

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 py-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">Nos espaces à louer</h1>
        <p className="max-w-2xl text-muted-foreground">
          Salles de réunion, bureaux privatifs et véhicules du {tenant.name}. Les
          disponibilités affichées sont celles d’aujourd’hui.
        </p>
      </header>

      {listings.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border bg-white px-6 py-12 text-center text-muted-foreground">
          Le catalogue est en cours de préparation.{' '}
          <Link href="/" className="underline underline-offset-2">
            Voir les créneaux du jour
          </Link>
        </p>
      ) : (
        <div className="grid gap-5 sm:grid-cols-2">
          {listings.map((listing) => {
            const dispo = dispoParRessource.get(listing.resourceId)
            // Le prix affiché est le plus fin que la grille propose : un
            // visiteur veut savoir à partir de combien, pas le tarif mensuel.
            const tarif = plan
              ? UNITES.map((unit) =>
                  resolveRate(plan.items, {
                    resourceId: listing.resourceId,
                    resourceType: listing.resource.resourceType,
                    unit,
                  }),
                ).find(Boolean)
              : undefined
            const details = describeAttributes(listing.resource.attributes ?? {})

            return (
              <article
                key={listing.id}
                className="flex flex-col gap-3 rounded-lg border border-border bg-white p-5"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                    {resourceTypeLabels[listing.resource.resourceType]}
                  </span>
                  {/* « Fermé » et « complet » ne veulent pas dire la même
                      chose : un visiteur qui lit « complet » revient demain. */}
                  <span className="text-xs font-medium">
                    {!dispo ? (
                      <span className="text-muted-foreground">Sur demande</span>
                    ) : dispo.closed ? (
                      <span className="text-muted-foreground">Fermé aujourd’hui</span>
                    ) : dispo.free.length === 0 ? (
                      <span className="text-muted-foreground">Complet aujourd’hui</span>
                    ) : (
                      <span className="text-primary">Disponible aujourd’hui</span>
                    )}
                  </span>
                </div>

                <h2 className="text-lg font-semibold tracking-tight">
                  <Link href={`/annonces/${listing.slug}`} className="hover:underline">
                    {listing.headline}
                  </Link>
                </h2>

                {listing.description && (
                  <p className="line-clamp-3 text-sm text-muted-foreground">
                    {listing.description}
                  </p>
                )}

                <dl className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                  {listing.resource.capacity !== null && (
                    <div>
                      <dt className="sr-only">Capacité</dt>
                      <dd>{listing.resource.capacity} personnes</dd>
                    </div>
                  )}
                  {details && (
                    <div>
                      <dt className="sr-only">Équipements</dt>
                      <dd>{details}</dd>
                    </div>
                  )}
                </dl>

                <div className="mt-auto flex items-end justify-between gap-3 pt-2">
                  <p className="text-sm">
                    {tarif ? (
                      <>
                        <span className="text-muted-foreground">à partir de </span>
                        <span className="font-semibold tabular-nums">
                          {formatCents(tarif.amountCents, plan?.currency ?? 'EUR')}
                        </span>{' '}
                        <span className="text-muted-foreground">
                          {rateUnitSuffixes[tarif.unit]} HT
                        </span>
                      </>
                    ) : (
                      <span className="text-muted-foreground">Tarif sur demande</span>
                    )}
                  </p>
                  <Link
                    href={`/annonces/${listing.slug}`}
                    className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover"
                  >
                    Voir
                  </Link>
                </div>
              </article>
            )
          })}
        </div>
      )}
    </div>
  )
}
