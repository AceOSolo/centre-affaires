import Link from 'next/link'

import { requirePermission } from '../../../lib/auth/staff.ts'
import { rateUnitSuffixes } from '../../../modules/facturation/labels.ts'
import { formatBp } from '../../../modules/facturation/saisie.ts'
import { missingExpectedServices } from '../../../modules/facturation/services-attendus.ts'
import {
  serviceNatureLabels,
  serviceState,
  serviceStateLabels,
  serviceStateStyles,
} from '../../../modules/facturation/services-labels.ts'
import { listServices } from '../../../modules/facturation/services-queries.ts'
import { formatCents } from '../../../modules/facturation/tarifs.ts'

export const metadata = { title: 'Services' }

/**
 * Catalogue de services (R18, ADR 024) : forfaits et actes que le centre vend
 * en dehors des ressources réservables.
 */
export default async function ServicesPage({
  searchParams,
}: {
  searchParams: Promise<{ archives?: string }>
}) {
  await requirePermission('services.gerer')
  const { archives } = await searchParams
  const showArchived = archives === '1'
  const [shown, living] = await Promise.all([
    listServices({ archived: showArchived }),
    showArchived ? listServices() : Promise.resolve(null),
  ])
  const missing = missingExpectedServices((living ?? shown).map((service) => service.code))

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Services</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Forfaits et actes vendus en plus des ressources : standard, assistante, numérisation du
            courrier. Les clients y souscrivent depuis leur fiche ; les{' '}
            <Link href="/offres" className="underline underline-offset-2">
              offres groupées
            </Link>{' '}
            les combinent avec des ressources.
          </p>
        </div>
        <Link
          href="/services/nouveau"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover"
        >
          Nouveau service
        </Link>
      </div>

      {missing.length > 0 && (
        <section
          aria-labelledby="attendus-titre"
          className="rounded-lg border border-accent/40 bg-accent/5 px-5 py-4"
        >
          <h2 id="attendus-titre" className="text-sm font-semibold text-primary">
            Service attendu par l’application
          </h2>
          <ul className="mt-2 flex flex-col gap-3">
            {missing.map((service) => (
              <li key={service.code} className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-sm">
                  <p className="font-medium text-foreground">
                    {service.name}{' '}
                    <span className="text-xs font-normal text-muted-foreground">{service.code}</span>
                  </p>
                  <p className="text-muted-foreground">
                    {service.purpose} Tant qu’il n’existe pas, ces actes ne sont pas valorisés : le
                    lot de facturation les signale.
                  </p>
                </div>
                <Link
                  href={`/services/nouveau?code=${encodeURIComponent(service.code)}`}
                  className="rounded-md border border-border bg-white px-3 py-1.5 text-sm font-medium hover:bg-muted"
                >
                  Créer ce service
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <nav aria-label="Filtrer les services" className="flex gap-4 text-sm">
        <Link
          href="/services"
          aria-current={showArchived ? undefined : 'page'}
          className="underline-offset-2 hover:underline aria-[current=page]:font-semibold aria-[current=page]:text-primary"
        >
          Catalogue
        </Link>
        <Link
          href="/services?archives=1"
          aria-current={showArchived ? 'page' : undefined}
          className="underline-offset-2 hover:underline aria-[current=page]:font-semibold aria-[current=page]:text-primary"
        >
          Archivés
        </Link>
      </nav>

      {shown.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-white px-6 py-12 text-center">
          <p className="text-sm text-muted-foreground">
            {showArchived
              ? 'Aucun service archivé.'
              : 'Aucun service au catalogue. Créez-en un pour le proposer à la souscription ou dans une offre.'}
          </p>
          {!showArchived && (
            <Link
              href="/services/nouveau"
              className="mt-4 inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover"
            >
              Créer un service
            </Link>
          )}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-white">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">
              {showArchived ? 'Services archivés' : 'Services du catalogue'}
            </caption>
            <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">Service</th>
                <th scope="col" className="px-4 py-3 font-medium">Nature</th>
                <th scope="col" className="px-4 py-3 text-right font-medium">Prix HT</th>
                <th scope="col" className="px-4 py-3 text-right font-medium">TVA</th>
                <th scope="col" className="px-4 py-3 font-medium">État</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {shown.map((service) => {
                const state = serviceState(service)
                return (
                  <tr key={service.id}>
                    <td className="px-4 py-3">
                      <Link
                        href={`/services/${service.id}`}
                        className="font-medium underline-offset-2 hover:underline"
                      >
                        {service.name}
                      </Link>
                      {service.code && (
                        <span className="block text-xs text-muted-foreground">{service.code}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {serviceNatureLabels[service.nature]}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right tabular">
                      {formatCents(service.unitPriceCents, service.currency)}{' '}
                      <span className="text-xs text-muted-foreground">
                        {rateUnitSuffixes[service.unit]}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right tabular text-muted-foreground">
                      {formatBp(service.vatRateBp)}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${serviceStateStyles[state]}`}
                      >
                        {serviceStateLabels[state]}
                      </span>
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
