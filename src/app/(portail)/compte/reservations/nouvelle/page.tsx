import Link from 'next/link'

import { ArrowRightIcon, CheckIcon, ClockIcon, UsersIcon } from '../../../../../components/ui/icons.tsx'
import {
  addDaysToIsoDate,
  formatLongDate,
  formatTime,
  isCalendarDate,
  toIsoDate,
} from '../../../../../lib/dates.ts'
import { currentTenant } from '../../../../../lib/tenant.ts'
import { requireClientAccount } from '../../../../../modules/clients/session.ts'
import { PortalBookingForm } from '../../../../../modules/reservations/portail-booking-form.tsx'
import { listPortalDayAvailability } from '../../../../../modules/reservations/portail-queries.ts'
import { portalModeLabels } from '../../../../../modules/reservations/portail-regles.ts'
import { availableStarts } from '../../../../../modules/reservations/public-selection.ts'
import {
  requestableRanges,
  requestBounds,
  requestPolicyMessage,
} from '../../../../../modules/reservations/request-policy.ts'
import { resourceTypeLabels } from '../../../../../modules/ressources/labels.ts'
import { resourceTypes, type ResourceType } from '../../../../../modules/ressources/schema.ts'

export const metadata = { title: 'Réserver un espace' }

const fieldClass =
  'mt-1 w-full min-h-11 rounded-sm border border-border bg-white px-3 py-2 text-base outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-accent/40'
const focusClass = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary'
const secondaryClass = `inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-border bg-white px-4 text-sm font-medium transition-colors hover:bg-muted ${focusClass}`

/**
 * Réservation depuis l'espace client (R23, ADR 036) : filtrer par type et par
 * date, voir les disponibilités réelles (le moteur de la page publique et du
 * back-office), choisir un espace, voir le montant de son contrat avant de
 * valider, puis réserver — confirmée d'emblée ou soumise à l'accueil selon le
 * réglage de la ressource.
 *
 * Le filtre est un formulaire en GET : il marche sans JavaScript, et l'URL se
 * partage. Mobile d'abord : une colonne, des cibles de 44 px.
 */
export default async function NouvelleReservationPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string; date?: string; ressource?: string }>
}) {
  const { accounts } = await requireClientAccount()
  const tenant = await currentTenant()
  const timeZone = tenant.timezone
  const now = new Date()
  const { earliest, latest } = requestBounds(tenant, now)
  const minDate = toIsoDate(earliest, timeZone)
  const maxDate = toIsoDate(latest, timeZone)
  const params = await searchParams

  const requestedDate = isCalendarDate(params.date) ? params.date : undefined
  const outOfRange = Boolean(requestedDate && (requestedDate < minDate || requestedDate > maxDate))
  const date = requestedDate && !outOfRange ? requestedDate : minDate

  const day = await listPortalDayAvailability(accounts, date, timeZone)
  const types = resourceTypes.filter((type) => day.some(({ resource }) => resource.resourceType === type))
  const type = types.find((candidate) => candidate === params.type) as ResourceType | undefined
  const shown = day
    .filter(({ resource }) => !type || resource.resourceType === type)
    .map((availability) => {
      const free = requestableRanges(availability.free, tenant, now)
      return { ...availability, free, starts: availableStarts(free, now, latest) }
    })
  const selected = params.ressource ? shown.find(({ resource }) => resource.id === params.ressource) : undefined

  const dateLabel = formatLongDate(date, timeZone)
  const href = (changes: { date?: string; ressource?: string }) => {
    const query = new URLSearchParams()
    if (type) query.set('type', type)
    query.set('date', changes.date ?? date)
    if (changes.ressource) query.set('ressource', changes.ressource)
    return `/compte/reservations/nouvelle?${query.toString()}${changes.ressource ? '#reserver' : ''}`
  }
  const previous = addDaysToIsoDate(date, -1)
  const next = addDaysToIsoDate(date, 1)

  return (
    <div className="flex flex-col gap-8">
      <div>
        <Link
          href="/compte/reservations"
          className={`inline-flex min-h-11 items-center text-sm text-muted-foreground underline-offset-2 hover:underline ${focusClass}`}
        >
          ← Mes réservations
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight text-primary sm:text-3xl">
          Réserver un espace
        </h1>
        <p className="mt-2 max-w-prose text-muted-foreground">
          Choisissez un type d’espace et une date : seuls les créneaux libres sont proposés, avec le
          tarif de votre contrat. {requestPolicyMessage(tenant)}
        </p>
      </div>

      {day.length === 0 ? (
        <div className="max-w-prose rounded-lg border border-dashed border-border px-6 py-8 text-center">
          <p className="font-medium text-primary">Aucun espace ne se réserve en ligne pour le moment.</p>
          <p className="mt-2 text-sm text-muted-foreground">
            Contactez le centre{tenant.phone ? ` au ${tenant.phone}` : ''}
            {tenant.email ? ` ou à ${tenant.email}` : ''} : l’accueil réserve pour vous.
          </p>
        </div>
      ) : (
        <>
          <form
            method="get"
            className="grid gap-4 rounded-lg border border-border bg-white p-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end sm:p-5"
          >
            <div>
              <label htmlFor="type" className="block text-sm font-medium">
                Type d’espace
              </label>
              <select id="type" name="type" defaultValue={type ?? ''} className={fieldClass}>
                <option value="">Tous les types</option>
                {types.map((candidate) => (
                  <option key={candidate} value={candidate}>
                    {resourceTypeLabels[candidate]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="date" className="block text-sm font-medium">
                Date
              </label>
              <input
                id="date"
                name="date"
                type="date"
                required
                min={minDate}
                max={maxDate}
                defaultValue={date}
                aria-invalid={outOfRange ? true : undefined}
                aria-describedby={outOfRange ? 'date-error' : undefined}
                className={fieldClass}
              />
            </div>
            <button
              type="submit"
              className={`inline-flex min-h-11 items-center justify-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover ${focusClass}`}
            >
              Voir les disponibilités
            </button>
            {outOfRange && (
              <p id="date-error" role="alert" className="text-sm text-destructive sm:col-span-3">
                Cette date est hors de la période ouverte à la réservation : {requestPolicyMessage(tenant)}{' '}
                Disponibilités du {dateLabel}.
              </p>
            )}
          </form>

          {selected && (
            <section
              id="reserver"
              aria-labelledby="reserver-titre"
              className="scroll-mt-6 rounded-lg border-2 border-primary bg-white p-4 sm:p-6"
            >
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                <h2 id="reserver-titre" className="text-lg font-semibold">
                  Votre réservation
                </h2>
                <Link href={href({})} className={secondaryClass}>
                  Changer d’espace
                </Link>
              </div>
              <PortalBookingForm
                key={`${selected.resource.id}/${date}`}
                resource={{
                  id: selected.resource.id,
                  name: selected.resource.name,
                  typeLabel: resourceTypeLabels[selected.resource.resourceType],
                  mode: selected.resource.clientBookingMode,
                }}
                date={date}
                dateLabel={dateLabel}
                timeZone={timeZone}
                free={selected.free.map((range) => ({
                  startsAt: range.startsAt.toISOString(),
                  endsAt: range.endsAt.toISOString(),
                }))}
                now={now.toISOString()}
                latestStart={latest.toISOString()}
                accounts={accounts.map(({ clientId, clientName }) => ({ clientId, clientName }))}
              />
            </section>
          )}

          <section aria-labelledby="disponibilites" className="flex flex-col gap-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <h2 id="disponibilites" className="text-lg font-semibold">
                Disponibilités du <span className="capitalize">{dateLabel}</span>
              </h2>
              <div className="flex gap-2">
                {previous >= minDate && (
                  <Link href={href({ date: previous })} className={secondaryClass}>
                    <ArrowRightIcon size={20} className="rotate-180" />
                    Jour précédent
                  </Link>
                )}
                {next <= maxDate && (
                  <Link href={href({ date: next })} className={secondaryClass}>
                    Jour suivant
                    <ArrowRightIcon size={20} />
                  </Link>
                )}
              </div>
            </div>

            {shown.length === 0 ? (
              <p className="max-w-prose rounded-lg border border-dashed border-border px-6 py-8 text-center text-muted-foreground">
                Aucun espace de ce type ne se réserve en ligne. Choisissez « Tous les types ».
              </p>
            ) : (
              <ul className="grid gap-4 sm:grid-cols-2">
                {shown.map(({ resource, free, closed, starts }) => {
                  const isSelected = selected?.resource.id === resource.id
                  const ModeIcon = resource.clientBookingMode === 'instant' ? CheckIcon : ClockIcon
                  return (
                    <li
                      key={resource.id}
                      className={`flex flex-col gap-3 rounded-lg border bg-white p-4 ${isSelected ? 'border-primary' : 'border-border'}`}
                    >
                      <div>
                        <p className="text-xs text-muted-foreground">
                          {resourceTypeLabels[resource.resourceType]}
                        </p>
                        <h3 id={`espace-${resource.id}`} className="text-base font-semibold text-primary">
                          {resource.name}
                        </h3>
                        {resource.capacity ? (
                          <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
                            <UsersIcon size={20} />
                            Jusqu’à {resource.capacity} personne{resource.capacity > 1 ? 's' : ''}
                          </p>
                        ) : null}
                      </div>
                      <p className="inline-flex items-center gap-1.5 text-sm font-medium text-primary">
                        <ModeIcon size={20} />
                        {portalModeLabels[resource.clientBookingMode]}
                      </p>
                      <p className="text-sm tabular">
                        {closed
                          ? 'Fermé ce jour-là.'
                          : starts.length === 0
                            ? 'Complet ce jour-là.'
                            : `Libre : ${free
                                .map((range) => `${formatTime(range.startsAt, timeZone)}–${formatTime(range.endsAt, timeZone)}`)
                                .join(', ')}`}
                      </p>
                      {starts.length > 0 && (
                        <Link
                          href={href({ ressource: resource.id })}
                          aria-describedby={`espace-${resource.id}`}
                          aria-current={isSelected ? 'true' : undefined}
                          className={`mt-auto inline-flex min-h-11 items-center justify-center rounded-md px-4 text-sm font-medium transition-colors ${focusClass} ${
                            isSelected
                              ? 'bg-primary text-primary-foreground hover:bg-primary-hover'
                              : 'border border-primary text-primary hover:bg-accent/10'
                          }`}
                        >
                          {isSelected ? 'Espace choisi' : 'Choisir cet espace'}
                        </Link>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  )
}
