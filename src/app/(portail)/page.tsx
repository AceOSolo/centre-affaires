import Image from 'next/image'
import Link from 'next/link'

import {
  ArrowRightIcon,
  BuildingIcon,
  CalendarIcon,
  CarIcon,
  CheckIcon,
  ClockIcon,
  MapPinIcon,
  PhoneIcon,
  UsersIcon,
} from '../../components/ui/icons.tsx'
import { Reveal } from '../../components/ui/reveal.tsx'
import {
  addDaysToIsoDate,
  formatLongDate,
  formatMinutes,
  formatTime,
  todayIsoDate,
} from '../../lib/dates.ts'
import { currentTenant } from '../../lib/tenant.ts'
import { findDefaultRatePlan } from '../../modules/facturation/queries.ts'
import { formatCents, resolveRate } from '../../modules/facturation/tarifs.ts'
import { loadWeekCalendar } from '../../modules/reservations/calendar-data.ts'
import { PublicBookingForm } from '../../modules/reservations/public-booking-form.tsx'
import { listDayAvailability } from '../../modules/reservations/queries.ts'
import { formatOpeningSummary } from '../../modules/ressources/ouverture.ts'
import { listOpeningHours } from '../../modules/ressources/ouverture-queries.ts'
import { MAX_DAYS_AHEAD } from '../../modules/reservations/requests.ts'
import { describeAttributes, resourceTypeLabels } from '../../modules/ressources/labels.ts'

export const metadata = {
  title: 'Réserver une salle',
  description:
    'Salles de réunion, bureaux et espaces de travail disponibles à la demi-journée ou à la journée. Demande de créneau en ligne.',
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const WALL_TIME = /^\d{2}:\d{2}$/

export default async function PortailPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; espace?: string; debut?: string; fin?: string }>
}) {
  const tenant = await currentTenant()
  const timeZone = tenant.timezone
  const { date, espace, debut, fin } = await searchParams

  const today = todayIsoDate(timeZone)
  const maxDate = addDaysToIsoDate(today, MAX_DAYS_AHEAD)
  // Une date passée ou illisible ramène à aujourd'hui : l'URL est partagée et
  // survit à la journée pour laquelle elle a été copiée.
  const isoDate = date && ISO_DATE.test(date) && date >= today && date <= maxDate ? date : today

  const [availability, tarifs, regles] = await Promise.all([
    listDayAvailability(isoDate, timeZone),
    // Les prix affichés viennent de la grille par défaut : la page vitrine et la
    // facturation ne peuvent pas diverger.
    findDefaultRatePlan(),
    listOpeningHours(),
  ])
  const ouverture = formatOpeningSummary(regles)
  const resources = availability.map((entry) => entry.resource)
  const grandeCapacite = Math.max(0, ...resources.map((resource) => resource.capacity ?? 0))

  // Chaque espace a son propre emploi du temps : le calendrier en montre un à la
  // fois, désigné par l'URL. Un identifiant inconnu retombe sur le premier
  // espace plutôt que de rendre une page vide.
  const espaceChoisi = resources.find((resource) => resource.id === espace) ?? resources[0]
  // Sept jours glissants à partir du jour affiché, et non du lundi : un
  // visiteur qui arrive un vendredi n'a que faire des quatre jours révolus.
  const jours = espaceChoisi
    ? Array.from({ length: 7 }, (_, index) => addDaysToIsoDate(isoDate, index))
    : []
  const semaine = espaceChoisi
    ? await loadWeekCalendar({
        resourceId: espaceChoisi.id,
        anchor: isoDate,
        timeZone,
        mode: 'rolling',
      })
    : []

  return (
    <>
      {/* Hero ------------------------------------------------------------ */}
      <section className="border-b border-border bg-gradient-to-b from-muted to-background">
        <div className="mx-auto max-w-[1200px] px-5 py-16 sm:px-8 sm:py-20">
          <div className="grid items-center gap-12 lg:grid-cols-2">
            <div className="max-w-2xl">
            {tenant.tagline && (
              <p className="text-sm font-medium uppercase tracking-wide text-primary">
                {tenant.tagline}
              </p>
            )}
            <h1 className="mt-3 text-4xl font-bold tracking-tight text-primary sm:text-5xl">
              Une salle de réunion, quand vous en avez besoin.
            </h1>
            <p className="mt-5 text-lg text-muted-foreground">
              Salles équipées, bureaux fermés et domiciliation à
              {tenant.city ? ` ${tenant.city}` : ''}. Réservez à la demi-journée ou à la
              journée, sans abonnement.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link
                href="#demande"
                className="press inline-flex items-center justify-center gap-2 rounded-md bg-primary px-6 py-3.5 font-medium text-primary-foreground transition-colors hover:bg-primary-hover"
              >
                Demander un créneau
                <ArrowRightIcon size={20} />
              </Link>
              {tenant.phone && (
                <a
                  href={`tel:${tenant.phone.replace(/\s/g, '')}`}
                  className="press inline-flex items-center justify-center gap-2 rounded-md border border-primary px-6 py-3.5 font-medium text-primary transition-colors hover:bg-muted"
                >
                  <PhoneIcon size={20} />
                  {tenant.phone}
                </a>
              )}
            </div>
          </div>

          {tenant.heroImagePath && (
            <div className="relative aspect-[4/3] overflow-hidden rounded-xl lg:aspect-[5/4]">
              <Image
                src={tenant.heroImagePath}
                alt={`Le centre d'affaires ${tenant.name}`}
                fill
                sizes="(max-width: 1024px) 100vw, 560px"
                priority
                className="object-cover"
              />
            </div>
            )}
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

      {/* Services -------------------------------------------------------- */}
      <section className="border-b border-border">
        <div className="mx-auto max-w-[1200px] px-5 py-12 sm:px-8">
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ['Location de salles', 'Réunion, formation, séminaire — à la demi-journée ou à la journée.'],
              ['Location de bureaux', 'Bureaux fermés, au mois, prêts à l’emploi.'],
              ['Domiciliation', 'Adresse commerciale et réception de votre courrier.'],
              ['Événementiel', 'Espaces modulables et services sur mesure pour vos temps forts.'],
            ].map(([titre, texte], index) => (
              <Reveal key={titre} delayMs={index * 60}>
                <h2 className="font-semibold text-primary">{titre}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{texte}</p>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* Espaces --------------------------------------------------------- */}
      <section id="espaces" className="mx-auto max-w-[1200px] scroll-mt-24 px-5 py-16 sm:px-8">
        <h2 className="text-3xl font-semibold tracking-tight text-primary">Nos espaces</h2>
        <p className="mt-2 max-w-2xl text-muted-foreground">
          Chaque espace est équipé et entretenu par l&rsquo;équipe du centre.
        </p>

        {resources.length === 0 ? (
          <p className="mt-8 rounded-lg border border-border bg-muted px-6 py-10 text-center text-muted-foreground">
            Aucun espace n&rsquo;est réservable en ligne pour le moment.
          </p>
        ) : (
          <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {resources.map((resource, index) => {
              const details = describeAttributes(resource.attributes ?? {})
              return (
                <Reveal
                  as="article"
                  key={resource.id}
                  delayMs={index * 70}
                  className="group flex flex-col overflow-hidden rounded-lg border border-border bg-card transition-shadow hover:shadow-[0_1px_3px_rgba(0,0,0,0.06)]"
                >
                  {resource.photoPath && (
                    <div className="relative aspect-[4/3] bg-muted">
                      <Image
                        src={resource.photoPath}
                        alt={resource.name}
                        fill
                        sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 360px"
                        className="object-cover transition-transform duration-[250ms] ease-out group-hover:scale-[1.03]"
                      />
                    </div>
                  )}
                  <div className="flex flex-1 flex-col p-6">
                  <p className="text-sm font-medium text-primary">
                    {resourceTypeLabels[resource.resourceType]}
                  </p>
                  <h3 className="mt-1 text-xl font-semibold text-primary">{resource.name}</h3>
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
                  {(() => {
                    const demiJournee = tarifs
                      ? resolveRate(tarifs.items, {
                          resourceId: resource.id,
                          resourceType: resource.resourceType,
                          unit: 'half_day',
                        })
                      : undefined
                    const journee = tarifs
                      ? resolveRate(tarifs.items, {
                          resourceId: resource.id,
                          resourceType: resource.resourceType,
                          unit: 'day',
                        })
                      : undefined
                    if (!demiJournee && !journee) return null
                    return (
                      <p className="mt-auto border-t border-border pt-3 text-sm font-medium text-primary">
                        {demiJournee &&
                          `${formatCents(demiJournee.amountCents, tarifs?.currency)} HT la demi-journée`}
                        {demiJournee && journee && ' · '}
                        {journee &&
                          `${formatCents(journee.amountCents, tarifs?.currency)} HT la journée`}
                      </p>
                    )
                  })()}

                  {/* Appel à l'action au plus près de l'envie : la carte lue
                      mène au formulaire déjà rempli de cet espace. */}
                  <Link
                    href={`/?espace=${resource.id}#demande`}
                    className="press mt-5 inline-flex items-center justify-center gap-2 rounded-md border border-primary px-4 py-2.5 text-sm font-medium text-primary transition-colors hover:bg-primary hover:text-primary-foreground"
                  >
                    Réserver cet espace
                    <ArrowRightIcon size={18} />
                  </Link>
                  </div>
                </Reveal>
              )
            })}
          </div>
        )}
      </section>

      {/* Ambiance -------------------------------------------------------- */}
      <section className="border-t border-border bg-muted">
        <div className="mx-auto max-w-[1200px] px-5 py-16 sm:px-8">
          <div className="max-w-2xl">
            <h2 className="text-3xl font-semibold tracking-tight text-primary">
              Un lieu de rencontre, pas seulement des murs
            </h2>
            <p className="mt-2 text-muted-foreground">
              Accueil, cuisine partagée, coin pause et espace sportif : le centre est pensé pour
              qu&rsquo;on s&rsquo;y croise.
            </p>
          </div>

          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ['/photos/accueil.jpg', 'L’accueil à l’étage'],
              ['/photos/cuisine.jpg', 'La cuisine partagée'],
              ['/photos/pause-cafe.jpg', 'Le coin pause'],
              ['/photos/espace-sport.jpg', 'L’espace sportif'],
            ].map(([src, legende], index) => (
              <Reveal
                as="figure"
                key={src}
                delayMs={index * 70}
                className="group overflow-hidden rounded-lg bg-card"
              >
                <div className="relative aspect-[4/3]">
                  <Image
                    src={src}
                    alt={legende}
                    fill
                    sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 280px"
                    className="object-cover transition-transform duration-[250ms] ease-out group-hover:scale-[1.03]"
                  />
                </div>
                <figcaption className="px-4 py-3 text-sm text-muted-foreground">
                  {legende}
                </figcaption>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* Disponibilités -------------------------------------------------- */}
      <section id="disponibilites" className="scroll-mt-24 border-y border-border bg-muted">
        <div className="mx-auto max-w-[1200px] px-5 py-16 sm:px-8">
          <div className="flex flex-wrap items-end justify-between gap-6">
            <div>
              <h2 className="text-3xl font-semibold tracking-tight text-primary">
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
                className="flex items-center gap-2 text-sm font-medium text-primary"
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
            {availability.map(({ resource, free, freeMinutes, closed }) => (
              <div
                key={resource.id}
                className="flex flex-col gap-4 rounded-lg border border-border bg-card p-5 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="sm:w-64 sm:shrink-0">
                  <h3 className="font-semibold text-primary">{resource.name}</h3>
                  <p className="text-sm text-muted-foreground">
                    {resourceTypeLabels[resource.resourceType]}
                    {resource.capacity ? ` · ${resource.capacity} pers.` : ''}
                  </p>
                </div>

                {free.length === 0 ? (
                  // La couleur ne porte jamais l'information seule : le mot est
                  // là, pas seulement un fond gris. Et « fermé » n'est pas
                  // « complet » — proposer de rappeler n'a de sens que dans un
                  // seul des deux cas.
                  <p className="rounded-sm bg-muted px-3 py-2 text-sm font-medium text-muted-foreground">
                    {closed ? 'Fermé ce jour-là' : 'Complet ce jour-là'}
                  </p>
                ) : (
                  <div className="flex flex-1 flex-wrap items-center gap-2">
                    {free.map((range) => {
                      // Une plage libre peut couvrir la journée ; on propose
                      // une heure par défaut plutôt que douze, que la durée
                      // maximale d'une demande refuserait de toute façon.
                      const finProposee = new Date(
                        Math.min(range.endsAt.getTime(), range.startsAt.getTime() + 3_600_000),
                      )
                      const params = new URLSearchParams({
                        date: isoDate,
                        espace: resource.id,
                        debut: formatTime(range.startsAt, timeZone),
                        fin: formatTime(finProposee, timeZone),
                      })
                      return (
                        <Link
                          key={range.startsAt.toISOString()}
                          href={`/?${params}#demande`}
                          className="rounded-sm border border-accent bg-accent/10 px-3 py-1.5 text-sm font-medium text-primary tabular transition-colors hover:bg-primary hover:text-primary-foreground"
                        >
                          {formatTime(range.startsAt, timeZone)} –{' '}
                          {formatTime(range.endsAt, timeZone)}
                        </Link>
                      )
                    })}
                    <span className="text-sm text-muted-foreground">
                      {formatMinutes(freeMinutes)} libres
                    </span>
                    <Link
                      href={`/?date=${isoDate}&espace=${resource.id}#demande`}
                      className="ml-auto shrink-0 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover"
                    >
                      Réserver
                    </Link>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Sur place ------------------------------------------------------- */}
      <section id="services" className="mx-auto max-w-[1200px] scroll-mt-24 px-5 py-16 sm:px-8">
        <div className="grid gap-10 lg:grid-cols-2">
          <div>
            <h2 className="text-3xl font-semibold tracking-tight text-primary">
              Services sur place
            </h2>
            <p className="mt-2 text-muted-foreground">
              À ajouter à votre réservation, sur demande.
            </p>
            <ul className="mt-6 grid gap-3 sm:grid-cols-2">
              {[
                'Wifi gratuit',
                'Écran tactile',
                'Purificateur d’air',
                'Petit-déjeuner et déjeuner',
                'Rafraîchissements',
                'Paperboard',
              ].map((service) => (
                <li key={service} className="flex items-center gap-2 text-sm">
                  <CheckIcon size={20} className="shrink-0 text-primary" />
                  {service}
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-lg border border-border bg-muted p-6 sm:p-8">
            <h2 className="text-xl font-semibold text-primary">Nous trouver</h2>
            <address className="mt-4 flex flex-col gap-1 not-italic text-muted-foreground">
              {tenant.addressLine1 && <span>{tenant.addressLine1}</span>}
              {tenant.addressLine2 && <span>{tenant.addressLine2}</span>}
              <span>
                {[tenant.postalCode, tenant.city].filter(Boolean).join(' ')}
              </span>
            </address>

            <ul className="mt-6 grid gap-2 text-sm sm:grid-cols-2">
              {[
                [<CarIcon key="p" size={20} />, 'Parking privé gratuit'],
                [<CarIcon key="b" size={20} />, 'Borne de recharge électrique'],
                [<CheckIcon key="a" size={20} />, 'Accès PMR'],
                [<CheckIcon key="d" size={20} />, 'Douche sur place'],
                [<MapPinIcon key="r" size={20} />, 'Restaurants à proximité'],
                [<MapPinIcon key="h" size={20} />, 'Hébergements à proximité'],
              ].map(([icone, texte]) => (
                <li key={String(texte)} className="flex items-center gap-2 text-muted-foreground">
                  <span className="shrink-0 text-primary">{icone}</span>
                  {texte}
                </li>
              ))}
            </ul>

            <dl className="mt-6 flex flex-col gap-3 border-t border-border pt-5 text-sm">
              {tenant.phone && (
                <div className="flex items-center gap-2">
                  <dt className="text-muted-foreground">Téléphone</dt>
                  <dd>
                    <a
                      href={`tel:${tenant.phone.replace(/\s/g, '')}`}
                      className="font-medium text-primary underline-offset-2 hover:underline"
                    >
                      {tenant.phone}
                    </a>
                  </dd>
                </div>
              )}
              <div className="flex items-start gap-2">
                <dt className="text-muted-foreground">Ouverture</dt>
                <dd className="font-medium text-primary">
                  {ouverture ?? 'Nous consulter'}
                </dd>
              </div>
            </dl>
          </div>
        </div>
      </section>

      {/* Demande --------------------------------------------------------- */}
      <section id="demande" className="scroll-mt-24">
        <div className="mx-auto max-w-[1200px] px-5 py-16 sm:px-8">
          <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_380px]">
            <div>
              <h2 className="text-3xl font-semibold tracking-tight text-primary">
                Demander un créneau
              </h2>
              <p className="mt-2 max-w-2xl text-muted-foreground">
                Remplissez le formulaire : le créneau est bloqué à votre nom pendant que notre
                équipe confirme.
              </p>
              {espaceChoisi ? (
                <div className="mt-8 flex flex-col gap-5">
                  {/* Changer d'espace ou de semaine recharge la page : un
                      formulaire GET et des liens marchent sans JavaScript, et
                      l'URL obtenue se partage. */}
                  <div className="flex flex-wrap items-end justify-between gap-4">
                    <form className="flex flex-wrap items-end gap-3" id="espace">
                      <div>
                        <label
                          htmlFor="espaceChoisi"
                          className="block text-sm font-medium text-foreground"
                        >
                          Espace
                        </label>
                        <select
                          id="espaceChoisi"
                          name="espace"
                          defaultValue={espaceChoisi.id}
                          className="mt-1.5 rounded-sm border border-border bg-background px-3 py-2.5 text-base outline-none focus:border-primary focus:ring-2 focus:ring-primary/30"
                        >
                          {resources.map((resource) => (
                            <option key={resource.id} value={resource.id}>
                              {resource.name} — {resourceTypeLabels[resource.resourceType]}
                              {resource.capacity ? ` (${resource.capacity} pers.)` : ''}
                            </option>
                          ))}
                        </select>
                      </div>
                      <input type="hidden" name="date" value={isoDate} />
                      <button
                        type="submit"
                        className="rounded-md border border-primary px-4 py-2.5 text-sm font-medium text-primary transition-colors hover:bg-muted"
                      >
                        Afficher
                      </button>
                    </form>

                    <nav aria-label="Période affichée" className="flex items-center gap-2">
                      <SemaineLink
                        date={addDaysToIsoDate(isoDate, -7)}
                        espace={espaceChoisi.id}
                        label="7 jours avant"
                        disabled={isoDate <= today}
                      />
                      <p className="px-2 text-sm text-muted-foreground tabular">
                        {jours[0]?.slice(8, 10)}/{jours[0]?.slice(5, 7)} –{' '}
                        {jours[6]?.slice(8, 10)}/{jours[6]?.slice(5, 7)}
                      </p>
                      <SemaineLink
                        date={addDaysToIsoDate(isoDate, 7)}
                        espace={espaceChoisi.id}
                        label="7 jours après"
                        disabled={addDaysToIsoDate(isoDate, 7) > maxDate}
                      />
                    </nav>
                  </div>

                  <PublicBookingForm
                    resource={espaceChoisi}
                    days={semaine}
                    timeZone={timeZone}
                    today={today}
                    defaultDate={isoDate}
                    minDate={today}
                    maxDate={maxDate}
                    defaultStartTime={WALL_TIME.test(debut ?? '') ? debut : undefined}
                    defaultEndTime={WALL_TIME.test(fin ?? '') ? fin : undefined}
                  />
                </div>
              ) : (
                <p className="mt-8 rounded-lg border border-dashed border-border bg-muted px-6 py-10 text-center text-muted-foreground">
                  Aucun espace n’est proposé à la réservation pour le moment. Appelez-nous, nous
                  trouverons une solution.
                </p>
              )}
            </div>

            <aside className="h-fit rounded-lg border border-border bg-muted p-6">
              <h3 className="font-semibold text-primary">Comment ça se passe</h3>
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

      {/* Barre d'action fixe, téléphone seulement : sur un petit écran le
          bouton principal disparaît dès qu'on descend dans la page. */}
      <div className="sticky bottom-0 z-10 border-t border-border bg-background/95 px-5 py-3 backdrop-blur sm:hidden">
        <div className="flex gap-3">
          <Link
            href="#demande"
            className="press flex-1 rounded-md bg-primary px-4 py-3 text-center font-medium text-primary-foreground"
          >
            Demander un créneau
          </Link>
          {tenant.phone && (
            <a
              href={`tel:${tenant.phone.replace(/\s/g, '')}`}
              aria-label={`Appeler le ${tenant.phone}`}
              className="flex items-center justify-center rounded-md border border-primary px-4 text-primary"
            >
              <PhoneIcon size={22} />
            </a>
          )}
        </div>
      </div>
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
        <dt className="text-2xl font-semibold text-primary tabular">{value}</dt>
        <dd className="text-sm text-muted-foreground">{label}</dd>
      </div>
    </div>
  )
}

/**
 * Flèche de semaine.
 *
 * Désactivée, elle reste affichée mais n'est plus un lien : un bouton qui
 * disparaît déplace ceux d'à côté, et on clique alors sur le mauvais.
 */
function SemaineLink({
  date,
  espace,
  label,
  disabled,
}: {
  date: string
  espace: string
  label: string
  disabled: boolean
}) {
  const classes = 'rounded-md border px-3 py-2 text-sm font-medium transition-colors'

  if (disabled) {
    return (
      <span
        aria-disabled="true"
        className={`${classes} border-border text-muted-foreground/50`}
      >
        {label}
      </span>
    )
  }

  return (
    <Link
      href={`/?date=${date}&espace=${espace}#demande`}
      className={`${classes} border-border text-primary hover:bg-muted`}
    >
      {label}
    </Link>
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
        <strong className="block font-medium text-primary">{title}</strong>
        <span className="text-muted-foreground">{children}</span>
      </span>
    </li>
  )
}
