import { Fragment } from 'react'

import Link from 'next/link'
import { notFound } from 'next/navigation'

import { requirePermission } from '../../../../lib/auth/staff.ts'
import { addDaysToIsoDate, formatLongDate, todayIsoDate, toIsoDate } from '../../../../lib/dates.ts'
import { currentTimeZone } from '../../../../lib/tenant.ts'
import {
  bookingHref,
  bookingLabel,
  bookingStateLabel,
  bookingTimeLabel,
  isContractOccupation,
  occupationPeriodLabel,
} from '../../../../modules/reservations/affichage.ts'
import { newBookingHref, planningHref } from '../../../../modules/reservations/filtres.ts'
import { bookingStatusBadgeStyles } from '../../../../modules/reservations/labels.ts'
import { listBookingsBetween } from '../../../../modules/reservations/queries.ts'
import {
  archiveResourceAction,
  updateResourceStatusAction,
} from '../../../../modules/ressources/actions.ts'
import {
  attributeFields,
  formatAttributeValue,
  hasCapacity,
} from '../../../../modules/ressources/attributs.ts'
import { ClientBookingModeForm } from '../../../../modules/ressources/client-booking-mode-form.tsx'
import {
  resourceStatusLabels,
  resourceStatusStyles,
  resourceTypeLabels,
} from '../../../../modules/ressources/labels.ts'
import { findResource } from '../../../../modules/ressources/queries.ts'
import { clientBookingModeLabels } from '../../../../modules/ressources/reservation-client.ts'

export const metadata = { title: 'Ressource' }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Jours d'agenda montrés sur la fiche : deux semaines suffisent à l'accueil. */
const HORIZON_DAYS = 14

/**
 * Fiche d'une ressource (R01) : ce qu'elle est, ce qu'elle porte, et ce qui
 * l'occupe dans les deux semaines à venir. Une ressource archivée reste
 * consultable — ses réservations passées y renvoient (décision 6) — mais ne se
 * modifie plus.
 */
export default async function ResourcePage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission('ressources.gerer')
  const { id } = await params
  // Un identifiant mal formé ferait échouer la requête en 22P02 : c'est une
  // page introuvable, pas une erreur serveur.
  if (!UUID.test(id)) notFound()
  const resource = await findResource(id)
  if (!resource) notFound()

  const timeZone = await currentTimeZone()
  const today = todayIsoDate(timeZone)
  const last = addDaysToIsoDate(today, HORIZON_DAYS - 1)
  const upcoming = (await listBookingsBetween(today, last, timeZone)).filter(
    (booking) => booking.resourceId === resource.id && booking.status !== 'cancelled',
  )

  const archived = Boolean(resource.deletedAt)
  const attributes = (resource.attributes ?? {}) as Record<string, unknown>
  const fields = attributeFields[resource.resourceType]

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/ressources" className="text-sm text-muted-foreground hover:underline">
          ← Ressources
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{resource.name}</h1>
          <span
            className={`rounded-full px-2 py-0.5 text-xs font-medium ${resourceStatusStyles[resource.status]}`}
          >
            {resourceStatusLabels[resource.status]}
          </span>
          {archived && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-foreground">
              Archivée
            </span>
          )}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {resource.code} · {resourceTypeLabels[resource.resourceType]}
        </p>
      </div>

      <div className="flex flex-wrap gap-3">
        {!archived && (
          <Link
            href={`/ressources/${resource.id}/modifier`}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white transition-colors duration-150 ease-out hover:bg-primary-hover"
          >
            Modifier
          </Link>
        )}
        <Link
          href={planningHref('semaine', {
            date: today,
            type: resource.resourceType,
            ressource: resource.id,
          })}
          className="rounded-md border border-border bg-white px-4 py-2 text-sm font-medium transition-colors duration-150 ease-out hover:bg-muted"
        >
          Planning de la semaine
        </Link>
        {!archived && resource.status === 'active' && (
          <Link
            href={newBookingHref({ date: today, resourceId: resource.id })}
            className="rounded-md border border-border bg-white px-4 py-2 text-sm font-medium transition-colors duration-150 ease-out hover:bg-muted"
          >
            Réserver
          </Link>
        )}
      </div>

      <dl className="grid grid-cols-[10rem_1fr] gap-y-3 rounded-lg border border-border bg-white px-5 py-4 text-sm">
        <dt className="text-muted-foreground">Type</dt>
        <dd>{resourceTypeLabels[resource.resourceType]}</dd>

        <dt className="text-muted-foreground">Code interne</dt>
        <dd>{resource.code}</dd>

        {hasCapacity(resource.resourceType) && (
          <>
            <dt className="text-muted-foreground">Capacité</dt>
            <dd>
              {resource.capacity
                ? `${resource.capacity} personne${resource.capacity > 1 ? 's' : ''}`
                : 'Non renseignée'}
            </dd>
          </>
        )}

        {fields.map((field) => {
          const value = formatAttributeValue(field, attributes[field.name])
          return (
            <Fragment key={field.name}>
              <dt className="text-muted-foreground">{field.label}</dt>
              <dd className={value ? 'tabular' : 'text-muted-foreground'}>
                {value ?? 'Non renseigné'}
              </dd>
            </Fragment>
          )
        })}

        <dt className="text-muted-foreground">Espace client</dt>
        <dd>{clientBookingModeLabels[resource.clientBookingMode]}</dd>

        <dt className="text-muted-foreground">Description</dt>
        <dd className="whitespace-pre-line">
          {resource.description || <span className="text-muted-foreground">Aucune</span>}
        </dd>

        {archived && resource.deletedAt && (
          <>
            <dt className="text-muted-foreground">Archivée le</dt>
            <dd>{formatLongDate(toIsoDate(resource.deletedAt, timeZone), timeZone)}</dd>
          </>
        )}
      </dl>

      <section className="flex flex-col gap-3" aria-labelledby="a-venir">
        <h2 id="a-venir" className="text-sm font-semibold tracking-tight">
          Les {HORIZON_DAYS} prochains jours{' '}
          <span className="font-normal text-muted-foreground">({upcoming.length})</span>
        </h2>
        {upcoming.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Rien de réservé d’ici au {formatLongDate(last, timeZone)}.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-white">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">Quand</th>
                  <th className="px-4 py-3 font-medium">Objet</th>
                  <th className="px-4 py-3 font-medium">État</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {upcoming.map((booking) => {
                  const jour = toIsoDate(booking.startsAt, timeZone)
                  return (
                    <tr key={booking.id}>
                      <td className="whitespace-nowrap px-4 py-3 tabular">
                        {isContractOccupation(booking) ? (
                          occupationPeriodLabel(booking, timeZone)
                        ) : (
                          <>
                            <span className="capitalize">{formatLongDate(jour, timeZone)}</span>
                            <span className="ml-2 text-muted-foreground">
                              {bookingTimeLabel(booking, jour, timeZone)}
                            </span>
                          </>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <Link
                          href={bookingHref(booking)}
                          className="font-medium underline-offset-2 hover:underline"
                        >
                          {bookingLabel(booking)}
                        </Link>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${bookingStatusBadgeStyles[booking.status]}`}
                        >
                          {bookingStateLabel(booking)}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {!archived && (
        <section
          className="flex flex-col gap-3 rounded-lg border border-border bg-white px-5 py-4"
          aria-labelledby="espace-client"
        >
          <h2 id="espace-client" className="text-sm font-semibold tracking-tight">
            Réservation depuis l’espace client
          </h2>
          <ClientBookingModeForm resourceId={resource.id} mode={resource.clientBookingMode} />
        </section>
      )}

      {!archived && (
        <section
          className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-white px-5 py-4 text-sm"
          aria-labelledby="exploitation"
        >
          <h2 id="exploitation" className="mr-auto text-sm font-semibold tracking-tight">
            Exploitation
          </h2>
          <form action={updateResourceStatusAction}>
            <input type="hidden" name="id" value={resource.id} />
            <input
              type="hidden"
              name="status"
              value={resource.status === 'active' ? 'maintenance' : 'active'}
            />
            <button
              type="submit"
              className="rounded-md border border-border px-4 py-2 font-medium transition-colors duration-150 ease-out hover:bg-muted"
            >
              {resource.status === 'active' ? 'Mettre en maintenance' : 'Remettre en service'}
            </button>
          </form>
          {/* Archivage et non suppression : une ressource retirée reste
              lisible depuis ses réservations (décision 6). */}
          <form action={archiveResourceAction}>
            <input type="hidden" name="id" value={resource.id} />
            <button
              type="submit"
              className="rounded-md border border-destructive/30 px-4 py-2 font-medium text-destructive transition-colors duration-150 ease-out hover:bg-destructive/5"
            >
              Archiver
            </button>
          </form>
        </section>
      )}
    </div>
  )
}
