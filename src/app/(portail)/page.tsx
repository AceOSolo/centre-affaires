import Image from 'next/image'
import Link from 'next/link'

import {
  ArrowRightIcon,
  BuildingIcon,
  CalendarIcon,
  CarIcon,
  CheckIcon,
  MapPinIcon,
  PhoneIcon,
  UsersIcon,
} from '../../components/ui/icons.tsx'
import { Reveal } from '../../components/ui/reveal.tsx'
import {
  formatLongDate,
  formatMinutes,
  formatTime,
  toIsoDate,
} from '../../lib/dates.ts'
import { currentTenant } from '../../lib/tenant.ts'
import { findDefaultRatePlan } from '../../modules/facturation/queries.ts'
import { formatCents, resolveRate } from '../../modules/facturation/tarifs.ts'
import { PublicBookingForm } from '../../modules/reservations/public-booking-form.tsx'
import { PublicAvailabilityDate } from '../../modules/reservations/public-availability-date.tsx'
import { listDayAvailability } from '../../modules/reservations/queries.ts'
import { formatOpeningSummary } from '../../modules/ressources/ouverture.ts'
import { listOpeningHours } from '../../modules/ressources/ouverture-queries.ts'
import { MIN_REQUEST_MINUTES } from '../../modules/reservations/requests.ts'
import { requestableRanges, requestBounds, requestPolicyMessage } from '../../modules/reservations/request-policy.ts'
import { freeMinutes as countFreeMinutes } from '../../modules/reservations/slots.ts'
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

  const now = new Date()
  const { earliest, latest } = requestBounds(tenant, now)
  const minDate = toIsoDate(earliest, timeZone)
  const maxDate = toIsoDate(latest, timeZone)
  // Une URL hors délai ramène au premier jour admissible.
  const isoDate = date && ISO_DATE.test(date) && date >= minDate && date <= maxDate ? date : minDate

  const [rawAvailability, tarifs, regles] = await Promise.all([
    listDayAvailability(isoDate, timeZone),
    // Les prix affichés viennent de la grille par défaut en vigueur ce jour-là :
    // la page vitrine et la facturation ne peuvent pas diverger (R08, R11).
    findDefaultRatePlan(isoDate),
    listOpeningHours(),
  ])
  const availability = rawAvailability.map((entry) => {
    const free = requestableRanges(entry.free, tenant, now)
    return { ...entry, free, freeMinutes: countFreeMinutes(free) }
  })
  const ouverture = formatOpeningSummary(regles)
  const resources = availability.map((entry) => entry.resource)
  const espaceChoisi = resources.find((resource) => resource.id === espace) ?? resources[0]
  const grandeCapacite = Math.max(0, ...resources.map((resource) => resource.capacity ?? 0))
  const espaceEnAvant = resources.find((resource) => resource.photoPath)
  const heroImage = espaceEnAvant?.photoPath ?? tenant.heroImagePath

  const bookingResources = resources.map((resource) => ({
    id: resource.id,
    name: resource.name,
    resourceType: resource.resourceType,
    description: resource.description,
    capacity: resource.capacity,
    photoPath: resource.photoPath,
    attributes: resource.attributes,
    rates: (['hour', 'half_day', 'day', 'week'] as const).flatMap((unit) => {
      const rate = resolveRate(tarifs, {
        resourceId: resource.id, resourceType: resource.resourceType, unit, on: isoDate,
      })
      return rate ? [{ unit, amountCents: rate.amountCents }] : []
    }),
  }))

  return (
    <>
      {/* Hero ------------------------------------------------------------ */}
      <section aria-labelledby="accueil-titre" className="border-b border-border bg-muted">
        <div className="mx-auto max-w-[1200px] px-5 py-10 sm:px-8 sm:py-12 lg:py-14">
          <div className={`grid items-center gap-8 lg:gap-12 ${heroImage ? 'lg:grid-cols-2' : ''}`}>
            <div className="max-w-2xl">
              <p className="inline-flex items-center gap-2 rounded-full border border-primary/15 bg-white px-3 py-1.5 text-xs font-medium text-primary">
                <MapPinIcon size={16} className="shrink-0" />
                {tenant.city ?? tenant.name}
              </p>
              <h1 id="accueil-titre" className="mt-6 text-[2.5rem] font-semibold leading-[1.1] tracking-tight text-primary sm:text-5xl">
                Le bon espace.<br />
                <span className="font-light">Pour vos grandes idées.</span>
              </h1>
              <p className="mt-5 max-w-lg text-base leading-relaxed text-muted-foreground sm:text-lg">
                Une réunion à préparer, une équipe à réunir, un projet à lancer.
                Trouvez votre place chez {tenant.name}.
              </p>
              <div className="mt-7 flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-6">
                <Link
                  href="#espaces"
                  className="press inline-flex min-h-12 items-center justify-center gap-3 rounded-md bg-primary px-5 py-3 font-medium text-primary-foreground transition-colors hover:bg-primary-hover"
                >
                  Découvrir nos espaces
                  <ArrowRightIcon size={20} />
                </Link>
                <Link href="#disponibilites" className="inline-flex min-h-11 items-center justify-center gap-2 text-sm font-medium text-primary underline-offset-4 hover:underline">
                  <CalendarIcon size={20} />
                  Voir les disponibilités
                </Link>
              </div>
              <ul className="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-xs text-muted-foreground sm:text-sm">
                {['Salles équipées', 'Sans abonnement', 'Accueil sur place'].map((avantage) => (
                  <li key={avantage} className="flex items-center gap-1.5">
                    <CheckIcon size={16} className="text-primary" />
                    {avantage}
                  </li>
                ))}
              </ul>
            </div>

            {heroImage && (
              <figure className="relative overflow-hidden rounded-xl bg-white">
                <div className="relative aspect-[4/3] sm:aspect-[16/11]">
                  <Image
                    src={heroImage}
                    alt={espaceEnAvant?.photoPath ? espaceEnAvant.name : `Le centre d'affaires ${tenant.name}`}
                    fill
                    sizes="(max-width: 1024px) calc(100vw - 40px), 550px"
                    preload
                    className="object-cover"
                  />
                  {espaceEnAvant?.photoPath && espaceEnAvant.capacity && (
                    <span className="absolute right-4 top-4 flex items-center gap-2 rounded-full bg-white px-3 py-2 text-xs font-medium text-primary">
                      <UsersIcon size={16} />
                      Jusqu’à {espaceEnAvant.capacity} personnes
                    </span>
                  )}
                </div>
                <figcaption className="flex items-center justify-between gap-4 px-5 py-4">
                  <div>
                    <p className="text-sm font-medium text-primary">
                      {espaceEnAvant?.photoPath ? espaceEnAvant.name : tenant.name}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {espaceEnAvant?.photoPath ? 'Votre prochaine réunion commence ici.' : tenant.tagline}
                    </p>
                  </div>
                  <Link
                    href={espaceEnAvant?.photoPath ? `/?date=${isoDate}&espace=${espaceEnAvant.id}#demande` : '#espaces'}
                    aria-label={espaceEnAvant?.photoPath ? `Voir les créneaux de ${espaceEnAvant.name}` : 'Découvrir nos espaces'}
                    className="flex size-11 shrink-0 items-center justify-center rounded-full border border-border text-primary transition-colors hover:bg-muted"
                  >
                    <ArrowRightIcon size={20} />
                  </Link>
                </figcaption>
              </figure>
            )}
          </div>

          {resources.length > 0 && (
            <form key={`recherche-${isoDate}-${espaceChoisi?.id}`} action="/#demande" method="get" className="mt-8 grid items-end gap-4 rounded-xl border border-border bg-white p-5 sm:p-6 lg:grid-cols-[1fr_1.3fr_1fr_auto]">
              <div className="lg:self-center">
                <p className="font-semibold text-primary">Votre prochain rendez-vous</p>
                <p className="mt-1 text-sm text-muted-foreground">Un espace, une date. À vous de jouer.</p>
              </div>
              <div className="min-w-0">
                <label htmlFor="recherche-espace" className="text-xs font-medium text-primary">Quel espace ?</label>
                <select id="recherche-espace" name="espace" defaultValue={espaceChoisi?.id} className="mt-1.5 w-full rounded-sm border border-border bg-muted px-3 py-3 text-sm text-foreground">
                  {resources.map((resource) => <option key={resource.id} value={resource.id}>{resource.name}</option>)}
                </select>
              </div>
              <div className="min-w-0">
                <label htmlFor="recherche-date" className="text-xs font-medium text-primary">À quelle date ?</label>
                <input id="recherche-date" name="date" type="date" required min={minDate} max={maxDate} defaultValue={isoDate} className="mt-1.5 min-w-0 w-full rounded-sm border border-border bg-muted px-3 py-3 text-sm text-foreground" />
              </div>
              <button type="submit" className="press inline-flex min-h-12 items-center justify-center gap-3 rounded-md bg-primary px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-primary-hover">
                Voir les créneaux
                <ArrowRightIcon size={20} />
              </button>
            </form>
          )}
          <dl className="mt-8 grid grid-cols-3 gap-4 border-t border-border pt-6">
            <Stat
              value={String(resources.length)}
              label={resources.length > 1 ? 'espaces à découvrir' : 'espace à découvrir'}
            />
            <Stat
              value={grandeCapacite > 0 ? `Jusqu’à ${grandeCapacite}` : 'Sur demande'}
              label="personnes par salle"
            />
            <Stat
              value={`${MIN_REQUEST_MINUTES} min`}
              label="minimum par réservation"
            />
          </dl>
        </div>
      </section>

      {/* Services -------------------------------------------------------- */}
      <section aria-label="Nos solutions" className="border-b border-border">
        <div className="mx-auto max-w-[1200px] px-5 py-12 sm:px-8">
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { titre: 'Réunir votre équipe', texte: 'Des salles pour vos réunions, formations et séminaires.', Icon: UsersIcon },
              { titre: 'Installer votre activité', texte: 'Des bureaux fermés, au mois, prêts à l’emploi.', Icon: BuildingIcon },
              { titre: 'Domicilier votre entreprise', texte: 'Une adresse professionnelle et la réception de votre courrier.', Icon: MapPinIcon },
              { titre: 'Créer votre événement', texte: 'Des espaces modulables pour vos temps forts.', Icon: CalendarIcon },
            ].map(({ titre, texte, Icon }, index) => (
              <Reveal key={titre} delayMs={index * 60}>
                <Icon size={24} className="mb-4 text-primary" />
                <h2 className="text-base font-medium text-primary">{titre}</h2>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{texte}</p>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* Espaces --------------------------------------------------------- */}
      <section id="espaces" className="mx-auto max-w-[1200px] scroll-mt-36 px-5 py-12 sm:px-8 lg:scroll-mt-24 lg:py-16">
        <div className="flex flex-wrap items-end justify-between gap-5">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.16em] text-primary">Nos espaces</p>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-primary sm:text-4xl">À chaque projet, sa place.</h2>
            <p className="mt-3 max-w-2xl text-muted-foreground">Choisissez le cadre qui vous convient. Nous préparons le reste.</p>
          </div>
          <Link href="/annonces" className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-primary underline-offset-4 hover:underline">
            Toutes nos annonces <ArrowRightIcon size={20} />
          </Link>
        </div>

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
                  className="group flex flex-col overflow-hidden rounded-lg border border-border bg-card transition-colors hover:border-primary/40"
                >
                  {resource.photoPath ? (
                    <div className="relative aspect-[16/10] overflow-hidden bg-muted">
                      <Image
                        src={resource.photoPath}
                        alt={resource.name}
                        fill
                        sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 360px"
                        className="object-cover transition-transform duration-[250ms] ease-out group-hover:scale-[1.03]"
                      />
                    </div>
                  ) : (
                    <div className="relative flex h-32 flex-col items-center justify-center gap-3 bg-muted text-primary sm:aspect-[16/10] sm:h-auto">
                      <span className="flex size-16 items-center justify-center rounded-xl border border-primary/15 bg-white">
                        {resource.resourceType === 'boite_aux_lettres' ? <MapPinIcon size={28} /> : <BuildingIcon size={28} />}
                      </span>
                      <span className="text-sm font-medium">{resourceTypeLabels[resource.resourceType]}</span>
                    </div>
                  )}
                  <div className="flex flex-1 flex-col p-6">
                  <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    {resourceTypeLabels[resource.resourceType]}
                  </p>
                  <h3 className="mt-2 text-xl font-semibold text-primary">{resource.name}</h3>
                  {resource.description && (
                    <p className="mt-2 text-sm text-muted-foreground">{resource.description}</p>
                  )}
                  {resource.capacity && (
                    <p className="mt-4 flex items-center gap-2 text-sm text-primary">
                      <UsersIcon size={20} className="text-primary" />
                      Jusqu&rsquo;à {resource.capacity} personnes
                    </p>
                  )}
                  {details && (
                    <p className="mt-2 text-sm text-muted-foreground">{details}</p>
                  )}
                  {(() => {
                    const demiJournee = tarifs
                      ? resolveRate(tarifs, {
                          resourceId: resource.id,
                          resourceType: resource.resourceType,
                          unit: 'half_day',
                          on: isoDate,
                        })
                      : undefined
                    const journee = tarifs
                      ? resolveRate(tarifs, {
                          resourceId: resource.id,
                          resourceType: resource.resourceType,
                          unit: 'day',
                          on: isoDate,
                        })
                      : undefined
                    if (!demiJournee && !journee) return <p className="mt-auto pt-5 text-sm text-muted-foreground">Contactez-nous pour les tarifs.</p>
                    const tarifPrincipal = demiJournee ?? journee
                    if (!tarifPrincipal) return null
                    return (
                      <div className="mt-auto pt-5">
                        <p className="text-sm text-muted-foreground">
                          <span className="text-2xl font-semibold tracking-tight text-primary tabular">{formatCents(tarifPrincipal.amountCents, tarifs?.currency)}</span>
                          {' '}HT / {demiJournee ? 'demi-journée' : 'journée'}
                        </p>
                        {demiJournee && journee && <p className="mt-1 text-xs text-muted-foreground">{formatCents(journee.amountCents, tarifs?.currency)} HT la journée</p>}
                      </div>
                    )
                  })()}

                  {/* Appel à l'action au plus près de l'envie : la carte lue
                      mène au formulaire déjà rempli de cet espace. */}
                  <Link
                    href={`/?date=${isoDate}&espace=${resource.id}#demande`}
                    className="press mt-5 inline-flex min-h-11 items-center justify-between gap-2 rounded-md border border-border px-4 py-3 text-sm font-medium text-primary transition-colors hover:bg-primary hover:text-primary-foreground"
                  >
                    Voir les créneaux
                    <ArrowRightIcon size={18} />
                  </Link>
                  </div>
                </Reveal>
              )
            })}
          </div>
        )}
      </section>

      {/* Disponibilités -------------------------------------------------- */}
      <section id="disponibilites" className="scroll-mt-36 border-y border-border bg-muted lg:scroll-mt-24">
        <div className="mx-auto max-w-[1200px] px-5 py-16 sm:px-8">
          <div className="flex flex-wrap items-end justify-between gap-6">
            <div>
              <p className="mb-3 text-xs font-medium uppercase tracking-[0.16em] text-primary">Votre agenda, votre espace</p>
              <h2 className="text-3xl font-semibold tracking-tight text-primary">
                Disponibilités
              </h2>
              <p className="mt-2 capitalize text-muted-foreground">
                {formatLongDate(isoDate, timeZone)}
              </p>
              <p className="mt-2 text-sm text-muted-foreground">{requestPolicyMessage(tenant)}</p>
            </div>

            <PublicAvailabilityDate
              key={isoDate}
              date={isoDate}
              minDate={minDate}
              maxDate={maxDate}
              resourceId={espaceChoisi?.id}
            />
          </div>

          <div className="mt-8 flex flex-col gap-4">
            {availability.length === 0 && <p className="rounded-lg border border-border bg-white p-6 text-muted-foreground">Les disponibilités ne sont pas encore publiées. Contactez l’équipe pour préparer votre venue.</p>}
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
                          className="inline-flex min-h-11 items-center rounded-sm border border-accent bg-accent/10 px-3 py-2 text-sm font-medium text-primary tabular transition-colors hover:bg-primary hover:text-primary-foreground"
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
                      className="ml-auto inline-flex min-h-11 shrink-0 items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover"
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

      {/* Réservation guidée --------------------------------------------- */}
      <section id="demande" className="scroll-mt-36 border-t border-border bg-muted/40 lg:scroll-mt-24">
        <div className="mx-auto max-w-[1200px] px-5 py-16 sm:px-8">
          <div className="mb-8">
            <h2 className="text-3xl font-semibold tracking-tight text-primary">
              Réservez votre salle, étape par étape
            </h2>
            <p className="mt-3 max-w-2xl text-muted-foreground">
              Une salle, un créneau, vos coordonnées. Nous vous guidons jusqu’au choix du paiement ou du devis.
            </p>
          </div>
          {resources.length ? (
            <PublicBookingForm
              key={`${espace ?? ''}/${isoDate}/${debut ?? ''}/${fin ?? ''}`}
              resources={bookingResources}
              currency={tarifs?.currency ?? tenant.currency}
              timeZone={timeZone}
              defaultResourceId={resources.find((resource) => resource.id === espace)?.id}
              defaultDate={isoDate}
              minDate={minDate}
              maxDate={maxDate}
              policy={{ bookingLeadHours: tenant.bookingLeadHours, bookingHorizonDays: tenant.bookingHorizonDays }}
              defaultStartTime={WALL_TIME.test(debut ?? '') ? debut : undefined}
              defaultEndTime={WALL_TIME.test(fin ?? '') ? fin : undefined}
            />
          ) : (
            <p className="rounded-lg border border-dashed border-border bg-muted px-6 py-10 text-center text-muted-foreground">
              Aucun espace n’est proposé à la réservation pour le moment. Appelez-nous, nous trouverons une solution.
            </p>
          )}
        </div>
      </section>

      {/* Ambiance -------------------------------------------------------- */}
      <section className="border-t border-border bg-muted">
        <div className="mx-auto max-w-[1200px] px-5 py-16 sm:px-8">
          <div className="max-w-2xl">
            <h2 className="text-3xl font-semibold tracking-tight text-primary">
              Bien travailler, c’est aussi se sentir bien.
            </h2>
            <p className="mt-3 text-muted-foreground">
              Accueil, cuisine partagée, coin pause et espace sportif : le centre est pensé pour
              qu’on s’y croise.
            </p>
          </div>
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ['/photos/accueil.jpg', 'L’accueil à l’étage'],
              ['/photos/cuisine.jpg', 'La cuisine partagée'],
              ['/photos/pause-cafe.jpg', 'Le coin pause'],
              ['/photos/espace-sport.jpg', 'L’espace sportif'],
            ].map(([src, legende], index) => (
              <Reveal as="figure" key={src} delayMs={index * 70} className="group overflow-hidden rounded-lg bg-card">
                <div className="relative aspect-[4/3] overflow-hidden">
                  <Image
                    src={src}
                    alt={legende}
                    fill
                    sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 280px"
                    className="object-cover transition-transform duration-[250ms] ease-out group-hover:scale-[1.03]"
                  />
                </div>
                <figcaption className="px-4 py-3 text-sm text-muted-foreground">{legende}</figcaption>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* Sur place ------------------------------------------------------- */}
      <section id="services" className="mx-auto max-w-[1200px] scroll-mt-36 px-5 py-16 sm:px-8 lg:scroll-mt-24">
        <div className="grid gap-10 lg:grid-cols-2">
          <div>
            <p className="mb-3 text-xs font-medium uppercase tracking-[0.16em] text-primary">L’esprit tranquille</p>
            <h2 className="text-3xl font-semibold tracking-tight text-primary">Services sur place</h2>
            <p className="mt-3 text-muted-foreground">À ajouter à votre réservation, sur demande.</p>
            <ul className="mt-6 grid gap-3 sm:grid-cols-2">
              {['Wifi gratuit', 'Écran tactile', 'Purificateur d’air', 'Petit-déjeuner et déjeuner', 'Rafraîchissements', 'Paperboard'].map((service) => (
                <li key={service} className="flex items-center gap-2 text-sm">
                  <CheckIcon size={20} className="shrink-0 text-primary" />
                  {service}
                </li>
              ))}
            </ul>
            {tenant.heroImagePath && (
              <div className="relative mt-8 aspect-[2/1] overflow-hidden rounded-xl">
                <Image src={tenant.heroImagePath} alt={`L’extérieur du centre ${tenant.name}`} fill sizes="(max-width: 1024px) 100vw, 550px" className="object-cover" />
              </div>
            )}
          </div>
          <div className="rounded-xl border border-border bg-muted p-6 sm:p-8">
            <h2 className="text-xl font-semibold text-primary">Nous trouver</h2>
            <address className="mt-4 flex flex-col gap-1 not-italic text-muted-foreground">
              {tenant.addressLine1 && <span>{tenant.addressLine1}</span>}
              {tenant.addressLine2 && <span>{tenant.addressLine2}</span>}
              <span>{[tenant.postalCode, tenant.city].filter(Boolean).join(' ')}</span>
            </address>
            <a
              href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([tenant.name, tenant.addressLine1, tenant.addressLine2, tenant.postalCode, tenant.city].filter(Boolean).join(', '))}`}
              target="_blank"
              rel="noreferrer"
              className="mt-3 inline-flex min-h-11 items-center gap-2 text-sm font-medium text-primary underline-offset-4 hover:underline"
            >
              <MapPinIcon size={20} /> Préparer mon itinéraire <ArrowRightIcon size={18} />
            </a>
            <ul className="mt-6 grid gap-3 text-sm sm:grid-cols-2">
              {[
                [<CarIcon key="p" size={20} />, 'Parking privé gratuit'],
                [<CarIcon key="b" size={20} />, 'Borne de recharge électrique'],
                [<CheckIcon key="a" size={20} />, 'Accès PMR'],
                [<CheckIcon key="d" size={20} />, 'Douche sur place'],
                [<MapPinIcon key="r" size={20} />, 'Restaurants à proximité'],
                [<MapPinIcon key="h" size={20} />, 'Hébergements à proximité'],
              ].map(([icone, texte]) => (
                <li key={String(texte)} className="flex items-center gap-2 text-muted-foreground">
                  <span className="shrink-0 text-primary">{icone}</span>{texte}
                </li>
              ))}
            </ul>
            <dl className="mt-6 flex flex-col gap-3 border-t border-border pt-5 text-sm">
              {tenant.phone && (
                <div className="flex flex-wrap items-center gap-2">
                  <dt className="text-muted-foreground">Téléphone</dt>
                  <dd><a href={`tel:${tenant.phone.replace(/\s/g, '')}`} className="inline-flex min-h-11 items-center font-medium text-primary underline-offset-4 hover:underline">{tenant.phone}</a></dd>
                </div>
              )}
              <div className="flex flex-wrap items-start gap-2">
                <dt className="text-muted-foreground">Ouverture</dt>
                <dd className="font-medium text-primary">{ouverture ?? 'Nous consulter'}</dd>
              </div>
            </dl>
          </div>
        </div>
      </section>

      {/* Barre d'action fixe, téléphone seulement : sur un petit écran le
          bouton principal disparaît dès qu'on descend dans la page. */}
      <div className="booking-mobile-cta sticky bottom-0 z-10 border-t border-border bg-background/95 px-5 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur sm:hidden">
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
function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="text-center">
      <dt className="text-lg font-semibold tracking-tight text-primary tabular sm:text-2xl">{value}</dt>
      <dd className="mt-1 text-xs text-muted-foreground sm:text-sm">{label}</dd>
    </div>
  )
}
