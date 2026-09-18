import Link from 'next/link'

import {
  ArrowRightIcon,
  BuildingIcon,
  CalendarIcon,
  ClockIcon,
  UsersIcon,
} from '../../components/ui/icons.tsx'
import {
  addDaysToIsoDate,
  formatLongDate,
  formatMinutes,
  formatTime,
  todayIsoDate,
} from '../../lib/dates.ts'
import { currentTenant } from '../../lib/tenant.ts'
import { PublicBookingForm } from '../../modules/reservations/public-booking-form.tsx'
import { listDayAvailability } from '../../modules/reservations/queries.ts'
import { MAX_DAYS_AHEAD } from '../../modules/reservations/requests.ts'
import { describeAttributes, resourceTypeLabels } from '../../modules/ressources/labels.ts'

export const metadata = {
  title: 'Réserver une salle',
  description:
    'Salles de réunion, bureaux et espaces de travail disponibles à la demi-journée ou à la journée. Demande de créneau en ligne.',
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export default async function PortailPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>
}) {
  const tenant = await currentTenant()
  const timeZone = tenant.timezone
  const { date } = await searchParams

  const today = todayIsoDate(timeZone)
  const maxDate = addDaysToIsoDate(today, MAX_DAYS_AHEAD)
  // Une date passée ou illisible ramène à aujourd'hui : l'URL est partagée et
  // survit à la journée pour laquelle elle a été copiée.
  const isoDate = date && ISO_DATE.test(date) && date >= today && date <= maxDate ? date : today

  const availability = await listDayAvailability(isoDate, timeZone)
  const resources = availability.map((entry) => entry.resource)
  const grandeCapacite = Math.max(0, ...resources.map((resource) => resource.capacity ?? 0))

  return (
    <>
      {/* Hero ------------------------------------------------------------ */}
      <section className="border-b border-border bg-gradient-to-b from-muted to-background">
        <div className="mx-auto max-w-[1200px] px-5 py-16 sm:px-8 sm:py-24">
          <div className="max-w-2xl">
            <p className="text-sm font-medium uppercase tracking-wide text-primary">
              {tenant.name}
            </p>
            <h1 className="mt-3 text-4xl font-bold tracking-tight text-secondary sm:text-5xl">
              Une salle de réunion, quand vous en avez besoin.
            </h1>
            <p className="mt-5 text-lg text-muted-foreground">
              Salles équipées, bureaux fermés et espaces de travail au cœur du centre
              d&rsquo;affaires. Réservez à l&rsquo;heure, à la demi-journée ou à la journée, sans
              abonnement.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link
                href="#demande"
                className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-6 py-3.5 font-medium text-primary-foreground transition-colors hover:bg-[#1a97c9]"
              >
                Demander un créneau
                <ArrowRightIcon size={20} />
              </Link>
              <Link
                href="#disponibilites"
                className="inline-flex items-center justify-center rounded-md border border-primary px-6 py-3.5 font-medium text-primary transition-colors hover:bg-muted"
              >
                Voir les disponibilités
              </Link>
            </div>
          </div>

          <dl className="mt-14 grid gap-4 sm:grid-cols-3">
            <Stat
              icon={<BuildingIcon size={24} />}
              value={String(resources.length)}
              label={resources.length > 1 ? 'espaces réservables' : 'espace réservable'}
            />
            <Stat
              icon={<UsersIcon size={24} />}
              value={grandeCapacite > 0 ? `${grandeCapacite}` : '—'}
              label="personnes dans la plus grande salle"
            />
            <Stat
              icon={<ClockIcon size={24} />}
              value="30 min"
              label="durée minimale de réservation"
            />
          </dl>
        </div>
      </section>

      {/* Espaces --------------------------------------------------------- */}
      <section className="mx-auto max-w-[1200px] px-5 py-16 sm:px-8">
        <h2 className="text-3xl font-semibold tracking-tight text-secondary">Nos espaces</h2>
        <p className="mt-2 max-w-2xl text-muted-foreground">
          Chaque espace est équipé et entretenu par l&rsquo;équipe du centre.
        </p>

        {resources.length === 0 ? (
          <p className="mt-8 rounded-lg border border-border bg-muted px-6 py-10 text-center text-muted-foreground">
            Aucun espace n&rsquo;est réservable en ligne pour le moment.
          </p>
        ) : (
          <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {resources.map((resource) => {
              const details = describeAttributes(resource.attributes ?? {})
              return (
                <article
                  key={resource.id}
                  className="flex flex-col rounded-lg border border-border bg-card p-6 transition-shadow hover:shadow-[0_1px_3px_rgba(0,0,0,0.06)]"
                >
                  <p className="text-sm font-medium text-primary">
                    {resourceTypeLabels[resource.resourceType]}
                  </p>
                  <h3 className="mt-1 text-xl font-semibold text-secondary">{resource.name}</h3>
                  {resource.description && (
                    <p className="mt-2 text-sm text-muted-foreground">{resource.description}</p>
                  )}
                  {resource.capacity && (
                    <p className="mt-4 flex items-center gap-2 text-sm">
                      <UsersIcon size={20} className="text-primary" />
                      Jusqu&rsquo;à {resource.capacity} personnes
                    </p>
                  )}
                  {details && (
                    <p className="mt-2 text-sm text-muted-foreground">{details}</p>
                  )}
                </article>
              )
            })}
          </div>
        )}
      </section>

      {/* Disponibilités -------------------------------------------------- */}
      <section id="disponibilites" className="scroll-mt-20 border-y border-border bg-muted">
        <div className="mx-auto max-w-[1200px] px-5 py-16 sm:px-8">
          <div className="flex flex-wrap items-end justify-between gap-6">
            <div>
              <h2 className="text-3xl font-semibold tracking-tight text-secondary">
                Disponibilités
              </h2>
              <p className="mt-2 capitalize text-muted-foreground">
                {formatLongDate(isoDate, timeZone)}
              </p>
            </div>

            {/* Formulaire GET : changer de jour marche sans JavaScript. */}
            <form className="flex flex-wrap items-center gap-3">
              <label
                htmlFor="date"
                className="flex items-center gap-2 text-sm font-medium text-secondary"
              >
                <CalendarIcon size={20} className="text-primary" />
                Choisir un jour
              </label>
              <input
                id="date"
                name="date"
                type="date"
                min={today}
                max={maxDate}
                defaultValue={isoDate}
                className="rounded-sm border border-border bg-background px-3 py-2 outline-none focus:border-primary focus:ring-2 focus:ring-primary/30"
              />
              <button
                type="submit"
                className="rounded-md border border-primary px-4 py-2 text-sm font-medium text-primary transition-colors hover:bg-background"
              >
                Afficher
              </button>
            </form>
          </div>

          <div className="mt-8 flex flex-col gap-4">
            {availability.map(({ resource, free, freeMinutes }) => (
              <div
                key={resource.id}
                className="flex flex-col gap-4 rounded-lg border border-border bg-card p-5 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="sm:w-64 sm:shrink-0">
                  <h3 className="font-semibold text-secondary">{resource.name}</h3>
                  <p className="text-sm text-muted-foreground">
                    {resourceTypeLabels[resource.resourceType]}
                    {resource.capacity ? ` · ${resource.capacity} pers.` : ''}
                  </p>
                </div>

                {free.length === 0 ? (
                  // La couleur ne porte jamais l'information seule : le mot
                  // « Complet » est là, pas seulement un fond gris.
                  <p className="rounded-sm bg-muted px-3 py-2 text-sm font-medium text-muted-foreground">
                    Complet ce jour-là
                  </p>
                ) : (
                  <div className="flex flex-1 flex-wrap items-center gap-2">
                    {free.map((range) => (
                      <span
                        key={range.startsAt.toISOString()}
                        className="rounded-sm border border-primary/40 bg-primary/5 px-3 py-1.5 text-sm font-medium text-secondary tabular"
                      >
                        {formatTime(range.startsAt, timeZone)} –{' '}
                        {formatTime(range.endsAt, timeZone)}
                      </span>
                    ))}
                    <span className="text-sm text-muted-foreground">
                      {formatMinutes(freeMinutes)} libres
                    </span>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Demande --------------------------------------------------------- */}
      <section id="demande" className="scroll-mt-20">
        <div className="mx-auto max-w-[1200px] px-5 py-16 sm:px-8">
          <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_380px]">
            <div>
              <h2 className="text-3xl font-semibold tracking-tight text-secondary">
                Demander un créneau
              </h2>
              <p className="mt-2 max-w-2xl text-muted-foreground">
                Remplissez le formulaire : le créneau est bloqué à votre nom pendant que notre
                équipe confirme.
              </p>
              <div className="mt-8">
                <PublicBookingForm
                  resources={resources}
                  defaultDate={isoDate}
                  minDate={today}
                  maxDate={maxDate}
                />
              </div>
            </div>

            <aside className="h-fit rounded-lg border border-border bg-muted p-6">
              <h3 className="font-semibold text-secondary">Comment ça se passe</h3>
              <ol className="mt-4 flex flex-col gap-4 text-sm">
                <Step number={1} title="Vous demandez un créneau">
                  Le créneau est immédiatement bloqué : personne d&rsquo;autre ne peut le
                  réserver pendant ce temps.
                </Step>
                <Step number={2} title="Nous confirmons">
                  L&rsquo;équipe du centre valide la demande et vous répond, en général sous un
                  jour ouvré.
                </Step>
                <Step number={3} title="Vous venez travailler">
                  L&rsquo;espace est prêt à l&rsquo;heure convenue.
                </Step>
              </ol>
            </aside>
          </div>
        </div>
      </section>
    </>
  )
}

function Stat({ icon, value, label }: { icon: React.ReactNode; value: string; label: string }) {
  return (
    <div className="flex items-center gap-4 rounded-lg border border-border bg-card p-5">
      <span className="flex size-11 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
        {icon}
      </span>
      <div>
        <dt className="text-2xl font-semibold text-secondary tabular">{value}</dt>
        <dd className="text-sm text-muted-foreground">{label}</dd>
      </div>
    </div>
  )
}

function Step({
  number,
  title,
  children,
}: {
  number: number
  title: string
  children: React.ReactNode
}) {
  return (
    <li className="flex gap-3">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-primary text-xs font-semibold text-primary tabular">
        {number}
      </span>
      <span>
        <strong className="block font-medium text-secondary">{title}</strong>
        <span className="text-muted-foreground">{children}</span>
      </span>
    </li>
  )
}
