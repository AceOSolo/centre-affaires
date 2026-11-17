import Link from 'next/link'
import { notFound } from 'next/navigation'

import { isCalendarDate, formatTime, toIsoDate } from '../../../../../../lib/dates.ts'
import { currentTenant } from '../../../../../../lib/tenant.ts'
import { requireClientAccount } from '../../../../../../modules/clients/session.ts'
import { frozenQuoteDisplay } from '../../../../../../modules/facturation/devis.ts'
import { formatCents } from '../../../../../../modules/facturation/tarifs.ts'
import { formulaOfUnit, formulasOf, rentalFormulaLabels } from '../../../../../../modules/ressources/formules.ts'
import { ModificationForm } from '../../../../../../modules/reservations/compte-modification-form.tsx'
import { changeRefusal, findBookingForChange } from '../../../../../../modules/reservations/compte-modification-queries.ts'
import { clientChangeNotice } from '../../../../../../modules/reservations/compte-regles.ts'
import { emptyChoice, formulaLimitsOf, type PeriodChoice } from '../../../../../../modules/reservations/formules-periode.ts'
import { dayFreeRanges, periodLabel, serializePeriod } from '../../../../../../modules/reservations/periode.ts'
import { loadPortalPeriodAvailability } from '../../../../../../modules/reservations/portail-queries.ts'
import { requestableRanges, requestBounds, requestPolicyMessage } from '../../../../../../modules/reservations/request-policy.ts'

export const metadata = { title: 'Modifier une réservation' }

const focusClass = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary'
const fieldClass =
  'mt-1 w-full min-h-11 rounded-sm border border-border bg-white px-3 py-2 text-base outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-accent/40'
const secondaryClass = `inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-border bg-white px-4 text-sm font-medium transition-colors hover:bg-muted ${focusClass}`

/**
 * Modifier une demande ou une réservation depuis l'espace client (ADR 076) :
 * le jour de l'arrivée se choisit par un formulaire en GET (sans JavaScript,
 * l'adresse se partage), puis la formule, les jours et les heures parmi ce
 * qui est libre — la réservation elle-même ne se gêne pas. Dans le délai du
 * centre seulement ; au-delà, la page dit pourquoi et comment joindre
 * l'accueil.
 */
export default async function ModifierReservationPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ date?: string }>
}) {
  const { accounts } = await requireClientAccount()
  const [{ id }, query, tenant] = await Promise.all([params, searchParams, currentTenant()])
  const booking = await findBookingForChange(accounts, id)
  if (!booking) notFound()

  const timeZone = tenant.timezone
  const now = new Date()
  const refusal = changeRefusal(booking, now)
  const notice = clientChangeNotice(booking, now, booking.policy)
  const quote = frozenQuoteDisplay(booking)
  const formulas = formulasOf(booking.resource)
  const currentFormula = formulaOfUnit(booking.quoteUnit, formulas)

  const contact = (
    <p className="max-w-prose text-sm text-muted-foreground">
      Contactez l’accueil
      {tenant.phone && (
        <>
          {' '}au{' '}
          <a href={`tel:${tenant.phone.replace(/\s/g, '')}`} className="font-medium text-primary underline-offset-2 hover:underline">
            {tenant.phone}
          </a>
        </>
      )}
      {tenant.email && (
        <>
          {tenant.phone ? ' ou ' : ' '}à{' '}
          <a href={`mailto:${tenant.email}`} className="font-medium text-primary underline-offset-2 hover:underline">
            {tenant.email}
          </a>
        </>
      )}
      .
    </p>
  )

  const header = (
    <div>
      <Link
        href="/compte/reservations"
        className={`inline-flex min-h-11 items-center text-sm text-muted-foreground underline-offset-2 hover:underline ${focusClass}`}
      >
        ← Mes réservations
      </Link>
      <h1 className="text-2xl font-semibold tracking-tight text-primary sm:text-3xl">Modifier une réservation</h1>
      <div className="mt-4 rounded-lg border border-border bg-white p-4 text-sm">
        <p className="font-semibold text-primary">{booking.resource.name}</p>
        {currentFormula && <p className="text-muted-foreground">{rentalFormulaLabels[currentFormula]}</p>}
        <p className="mt-1 first-letter:uppercase">{periodLabel(booking, timeZone)}</p>
        <p className="mt-1 text-muted-foreground">
          {booking.status === 'confirmed' ? 'Confirmée' : 'En attente de validation'}
          {quote ? ` · ${formatCents(quote.totalCents, quote.currency)} TTC` : ''}
          {accounts.length > 1 ? ` · ${booking.clientName}` : ''}
        </p>
        {notice && <p className="mt-2 text-muted-foreground">{notice}</p>}
      </div>
    </div>
  )

  if (refusal) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <div role="status" className="max-w-prose rounded-lg border border-dashed border-border px-5 py-6">
          <p className="font-medium text-primary">{refusal}</p>
        </div>
        {contact}
      </div>
    )
  }

  const { earliest, latest } = requestBounds(tenant, now)
  const minDate = toIsoDate(earliest, timeZone)
  const maxDate = toIsoDate(latest, timeZone)
  const currentDate = toIsoDate(booking.startsAt, timeZone)
  const requested = isCalendarDate(query.date) ? query.date : undefined
  const outOfRange = Boolean(requested && (requested < minDate || requested > maxDate))
  const fallback = currentDate >= minDate && currentDate <= maxDate ? currentDate : minDate
  const date = requested && !outOfRange ? requested : fallback

  const limits = formulaLimitsOf(tenant)
  const availability = await loadPortalPeriodAvailability(accounts, {
    resourceId: booking.resource.id,
    firstDate: date,
    timeZone,
    maxDaysSettings: tenant.bookingMaxDays,
    limits,
    excludeBookingId: booking.id,
  })
  if (!availability) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <p className="max-w-prose font-medium text-primary">
          « {booking.resource.name} » ne se réserve plus depuis l’espace client.
        </p>
        {contact}
      </div>
    )
  }
  const free = requestableRanges(dayFreeRanges(availability.period, date), tenant, now)

  // La réservation telle qu'elle est, quand le jour affiché est le sien : on
  // ne change que ce qu'on veut.
  const formula = currentFormula ?? availability.formulas[0] ?? 'libre'
  const sameDay = date === currentDate
  const initialChoice: PeriodChoice = sameDay
    ? {
        formula,
        startTime: formatTime(booking.startsAt, timeZone),
        endDate: toIsoDate(new Date(booking.endsAt.getTime() - 1), timeZone),
        endTime: formatTime(booking.endsAt, timeZone),
        count: (formula === 'semaine' || formula === 'mois') && booking.quoteQuantity ? booking.quoteQuantity : 1,
      }
    : emptyChoice(formula, date)

  return (
    <div className="flex flex-col gap-6">
      {header}

      <form method="get" className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-white p-4">
        <div>
          <label htmlFor="date" className="block text-sm font-medium">
            Jour de l’arrivée
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
            aria-describedby={outOfRange ? 'date-error' : 'date-hint'}
            className={fieldClass}
          />
        </div>
        <button type="submit" className={secondaryClass}>
          Afficher les horaires
        </button>
        <p id="date-hint" className="w-full text-xs text-muted-foreground">
          {requestPolicyMessage(tenant)}
        </p>
        {outOfRange && (
          <p id="date-error" role="alert" className="w-full text-sm text-destructive">
            Cette date est hors de la période ouverte à la réservation. Horaires du jour proposé ci-dessous.
          </p>
        )}
      </form>

      <section aria-labelledby="nouvelles-dates" className="rounded-lg border-2 border-primary bg-white p-4 sm:p-6">
        <h2 id="nouvelles-dates" className="mb-4 text-lg font-semibold">
          Nouvelles dates
        </h2>
        <ModificationForm
          key={`${booking.id}/${date}`}
          bookingId={booking.id}
          date={date}
          timeZone={timeZone}
          initialChoice={initialChoice}
          free={free.map((range) => ({ startsAt: range.startsAt.toISOString(), endsAt: range.endsAt.toISOString() }))}
          period={serializePeriod(availability.period)}
          maxDays={availability.maxDays}
          formulas={availability.formulas}
          limits={limits}
          now={now.toISOString()}
          earliest={earliest.toISOString()}
          latestStart={latest.toISOString()}
        />
      </section>

      {contact}
    </div>
  )
}
