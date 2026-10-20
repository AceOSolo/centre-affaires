import Image from 'next/image'

import {
  ArrowRightIcon,
  BuildingIcon,
  CarIcon,
  CheckIcon,
  ClockIcon,
  MapPinIcon,
  PhoneIcon,
  UsersIcon,
} from '../../components/ui/icons.tsx'
import { todayIsoDate, toIsoDate } from '../../lib/dates.ts'
import { currentTenant } from '../../lib/tenant.ts'
import { findDefaultRatePlan } from '../../modules/facturation/queries.ts'
import type { RateUnit } from '../../modules/facturation/schema.ts'
import { proposalProducts, type ProposalProduct } from '../../modules/facturation/schema-devis.ts'
import { listServices } from '../../modules/facturation/services-queries.ts'
import { pickRateItem, resolveRate } from '../../modules/facturation/tarifs.ts'
import { BookingDialog, ReserveButton } from '../../modules/reservations/booking-dialog.tsx'
import type { PublicBookingResource, SlotProduct } from '../../modules/reservations/public-booking-form.tsx'
import { productForResourceType, questionnaires } from '../../modules/reservations/questionnaires.ts'
import { requestBounds } from '../../modules/reservations/request-policy.ts'
import { describeAttributes } from '../../modules/ressources/labels.ts'
import { formatOpeningSummary } from '../../modules/ressources/ouverture.ts'
import { listOpeningHours } from '../../modules/ressources/ouverture-queries.ts'
import { listBookableResources } from '../../modules/ressources/queries.ts'
import type { ResourceType } from '../../modules/ressources/schema.ts'

export const metadata = {
  title: 'Salles de réunion, bureaux et domiciliation',
  description:
    'Salles de réunion et bureaux à l’heure ou à la journée, domiciliation d’entreprise. Demande de devis en ligne.',
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const WALL_TIME = /^\d{2}:\d{2}$/

/** Unités de la grille, de la plus fine à la plus large : un prix « à partir de » prend la première. */
const UNITES: RateUnit[] = ['hour', 'half_day', 'day', 'week', 'month']
const unitesEnClair: Partial<Record<RateUnit, string>> = {
  hour: 'à l’heure',
  half_day: 'à la demi-journée',
  day: 'à la journée',
  week: 'à la semaine',
  month: 'au mois',
}
const parUnite: Partial<Record<RateUnit, string>> = {
  hour: 'de l’heure',
  half_day: 'la demi-journée',
  day: 'la journée',
  week: 'la semaine',
  month: 'par mois',
}

/**
 * Un bloc par famille réservable sur créneau. Les mots sont ceux du centre :
 * ce que l'on y fait, ce qu'il y a sur place — jamais un slogan.
 */
const familles: {
  type: ResourceType
  ancre: string
  titre: string
  texte: string
  action: string
  equipements?: string[]
}[] = [
  {
    type: 'salle',
    ancre: 'salles',
    titre: 'Salles de réunion',
    texte: 'Pour vos réunions, formations, entretiens et séminaires. Café d’accueil, petit-déjeuner ou déjeuner sur demande.',
    action: 'Réserver une salle',
    equipements: ['Wifi', 'Écran tactile', 'Paperboard', 'Purificateur d’air'],
  },
  {
    type: 'bureau',
    ancre: 'bureaux',
    titre: 'Bureaux',
    texte: 'Un bureau fermé pour travailler au calme, avec l’accès aux espaces communs : cuisine partagée, coin pause, espace sportif.',
    action: 'Réserver un bureau',
  },
  {
    type: 'vehicule',
    ancre: 'vehicules',
    titre: 'Véhicules',
    texte: 'Un utilitaire pour un déménagement, une livraison ou un transport de marchandises.',
    action: 'Réserver un véhicule',
  },
]

const espacesCommuns = [
  { src: '/photos/accueil.jpg', legende: 'L’accueil' },
  { src: '/photos/cuisine.jpg', legende: 'La cuisine partagée' },
  { src: '/photos/pause-cafe.jpg', legende: 'Le coin pause' },
  { src: '/photos/espace-sport.jpg', legende: 'L’espace sportif' },
]

/** Mosaïque : la première photo en grand, la dernière en bandeau ; une grille pleine à toutes les largeurs. */
const tuiles: Record<number, string> = {
  0: 'col-span-2 aspect-[4/3] lg:row-span-2 lg:aspect-auto',
  3: 'col-span-2 aspect-[2/1] lg:aspect-auto',
}

const surPlace = [
  'Parking privé gratuit',
  'Borne de recharge électrique',
  'Accès PMR',
  'Douche',
  'Restaurants à proximité',
  'Hébergements à proximité',
]

const primaire = 'press inline-flex min-h-12 items-center justify-center gap-2 rounded-md bg-primary px-6 py-3 font-medium text-primary-foreground transition-colors hover:bg-primary-hover'
const secondaire = 'press inline-flex min-h-12 items-center justify-center gap-2 rounded-md border border-primary/30 bg-background px-6 py-3 font-medium text-primary transition-colors hover:border-primary hover:bg-muted'

export default async function PortailPage({
  searchParams,
}: {
  searchParams: Promise<{ produit?: string; date?: string; espace?: string; debut?: string; fin?: string }>
}) {
  const tenant = await currentTenant()
  const timeZone = tenant.timezone
  const { produit, date, espace, debut, fin } = await searchParams

  const now = new Date()
  const today = todayIsoDate(timeZone, now)
  const { earliest, latest } = requestBounds(tenant, now)
  const minDate = toIsoDate(earliest, timeZone)
  const maxDate = toIsoDate(latest, timeZone)
  // Une URL hors délai ramène au premier jour admissible.
  const isoDate = date && ISO_DATE.test(date) && date >= minDate && date <= maxDate ? date : minDate

  const [resources, tarifs, regles, services] = await Promise.all([
    listBookableResources(),
    // Les prix affichés viennent de la grille par défaut en vigueur : la page
    // vitrine et la facturation ne peuvent pas diverger (R08, R11).
    findDefaultRatePlan(today),
    listOpeningHours(),
    listServices(),
  ])
  const ouverture = formatOpeningSummary(regles)
  const currency = tarifs?.currency ?? tenant.currency

  // Tarifs de chaque espace, du plus fin au plus large.
  const bookable: PublicBookingResource[] = resources.map((resource) => ({
    id: resource.id,
    name: resource.name,
    resourceType: resource.resourceType,
    description: resource.description,
    capacity: resource.capacity,
    photoPath: resource.photoPath,
    attributes: resource.attributes,
    rates: UNITES.flatMap((unit) => {
      const rate = resolveRate(tarifs, { resourceId: resource.id, resourceType: resource.resourceType, unit, on: today })
      return rate ? [{ unit, amountCents: rate.amountCents }] : []
    }),
  }))
  const parProduit: Record<SlotProduct, PublicBookingResource[]> = {
    espace: bookable.filter((resource) => productForResourceType(resource.resourceType) === 'espace'),
    vehicule: bookable.filter((resource) => productForResourceType(resource.resourceType) === 'vehicule'),
  }

  // La domiciliation, sans calendrier, est toujours proposée (ADR 043).
  const produits = proposalProducts
    .filter((product) => product === 'domiciliation' || parProduit[product].length > 0)
    .map((product) => ({ product, label: questionnaires[product].label, description: questionnaires[product].description }))
  const blocs = familles
    .map((famille) => ({ ...famille, espaces: bookable.filter((resource) => resource.resourceType === famille.type) }))
    .filter((famille) => famille.espaces.length > 0)

  const domiciliation = tarifs
    ? pickRateItem(tarifs.items, { resourceId: null, resourceType: 'boite_aux_lettres', unit: 'month' })
    : undefined
  // Les actes de courrier facturés à l'unité : ce qui s'ajoute au forfait.
  const optionsCourrier = services.filter((service) => service.isActive && service.code?.startsWith('courrier.'))

  const ville = tenant.city
  const adresse = [tenant.addressLine1, tenant.addressLine2].filter(Boolean).join(', ')
  const codeVille = [tenant.postalCode, tenant.city].filter(Boolean).join(' ')
  const telHref = tenant.phone ? `tel:${tenant.phone.replace(/\s/g, '')}` : undefined
  const planUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([tenant.name, adresse, codeVille].filter(Boolean).join(', '))}`

  const offre = [...blocs.map((bloc) => bloc.titre), 'Domiciliation']
  const titre = enumerer(offre.map((mot, index) => (index === 0 ? mot : mot.toLowerCase())))

  const requestedProduct = proposalProducts.find((product): product is ProposalProduct => product === produit)

  return (
    <>
      {/* Accueil ---------------------------------------------------------- */}
      <section aria-labelledby="accueil-titre" className="mx-auto max-w-[1200px] px-5 pt-12 sm:px-8 sm:pt-20">
        <div className="mx-auto max-w-4xl text-center">
          <h1 id="accueil-titre" className="text-balance text-4xl font-semibold leading-[1.08] tracking-tight text-primary sm:text-5xl lg:text-6xl">
            {titre}{ville && <> à <span className="sm:whitespace-nowrap">{ville}</span></>}
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-pretty text-lg text-muted-foreground sm:text-xl">
            Choisissez votre créneau en ligne, recevez votre devis par e-mail.
            {ouverture ? ` Accueil ${ouverture.charAt(0).toLowerCase()}${ouverture.slice(1)}.` : ''}
          </p>
          <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
            <ReserveButton className={primaire}>
              Réserver
              <ArrowRightIcon size={20} />
            </ReserveButton>
            <a href="#offres" className={secondaire}>Voir les offres</a>
          </div>
        </div>

        {tenant.heroImagePath && (
          <div className="relative mt-12 aspect-[4/3] overflow-hidden rounded-xl bg-muted sm:mt-16 sm:aspect-[21/9]">
            <Image
              src={tenant.heroImagePath}
              alt={`Le bâtiment du centre ${tenant.name}`}
              fill
              sizes="(max-width: 1200px) calc(100vw - 40px), 1136px"
              preload
              className="object-cover"
            />
          </div>
        )}
      </section>

      {/* Offres ----------------------------------------------------------- */}
      <div id="offres" className="scroll-mt-24">
        {blocs.map((bloc, index) => {
          const depuis = aPartirDe(bloc.espaces)
          const unites = enumerer(UNITES.filter((unit) => bloc.espaces.some((espace) => espace.rates.some((rate) => rate.unit === unit))).map((unit) => unitesEnClair[unit] ?? ''), 'ou')
          const capaciteMax = Math.max(0, ...bloc.espaces.map((espace) => espace.capacity ?? 0))
          return (
            <section key={bloc.type} id={bloc.ancre} aria-labelledby={`${bloc.ancre}-titre`} className={`scroll-mt-24 py-16 sm:py-24 ${fond(index)}`}>
              <div className="mx-auto max-w-[1200px] px-5 sm:px-8">
                <div className="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
                  <div className="max-w-2xl">
                    <h2 id={`${bloc.ancre}-titre`} className="text-3xl font-semibold tracking-tight text-primary sm:text-5xl">{bloc.titre}</h2>
                    <p className="mt-4 text-pretty text-lg text-muted-foreground">{bloc.texte}</p>
                    <ul className="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-sm text-foreground">
                      {capaciteMax > 0 && <li className="flex items-center gap-2"><UsersIcon size={20} className="text-primary" />Jusqu’à {capaciteMax} personnes</li>}
                      {unites && <li className="flex items-center gap-2"><ClockIcon size={20} className="text-primary" /><span className="first-letter:uppercase">{unites}</span></li>}
                      {bloc.equipements?.map((equipement) => <li key={equipement} className="flex items-center gap-2"><CheckIcon size={20} className="text-primary" />{equipement}</li>)}
                    </ul>
                  </div>
                  <div className="shrink-0 lg:text-right">
                    {depuis ? (
                      <p className="text-muted-foreground">
                        À partir de <span className="text-2xl font-semibold tracking-tight text-primary tabular">{prix(depuis.amountCents, currency)}</span> HT {parUnite[depuis.unit]}
                      </p>
                    ) : (
                      <p className="text-muted-foreground">Tarif sur devis</p>
                    )}
                    <ReserveButton product={productForResourceType(bloc.type)} type={bloc.type} className={`${primaire} mt-4 w-full sm:w-auto`}>
                      {bloc.action}
                      <ArrowRightIcon size={20} />
                    </ReserveButton>
                  </div>
                </div>

                <ul className="mt-10 grid gap-x-6 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
                  {bloc.espaces.map((espace) => {
                    const premier = espace.rates[0]
                    const details = describeAttributes(espace.attributes ?? {})
                    return (
                      <li key={espace.id}>
                        {/* Toute la carte ouvre la réservation de cet espace. */}
                        <ReserveButton resourceId={espace.id} label={`Réserver ${espace.name}`} className="group block min-h-11 w-full rounded-xl text-left">
                          <span className="relative block aspect-[4/3] overflow-hidden rounded-xl bg-background">
                            {espace.photoPath ? (
                              <Image src={espace.photoPath} alt="" fill sizes="(max-width: 640px) calc(100vw - 40px), (max-width: 1024px) 50vw, 370px" className="object-cover transition-transform duration-[250ms] ease-out group-hover:scale-[1.02]" />
                            ) : (
                              <span className="flex h-full items-center justify-center text-primary/40">{bloc.type === 'vehicule' ? <CarIcon size={48} /> : <BuildingIcon size={48} />}</span>
                            )}
                          </span>
                          <span className="mt-4 flex items-baseline justify-between gap-3">
                            <span className="text-lg font-semibold text-foreground">{espace.name}</span>
                            {espace.capacity ? <span className="shrink-0 text-sm text-muted-foreground">{espace.capacity} pers.</span> : null}
                          </span>
                          {(espace.description || details) && <span className="mt-1 line-clamp-2 block text-sm text-muted-foreground">{espace.description ?? details}</span>}
                          <span className="mt-2 flex items-center justify-between gap-3 text-sm">
                            <span>{premier ? <><strong className="font-semibold tabular">{prix(premier.amountCents, currency)} HT</strong> {parUnite[premier.unit]}</> : 'Tarif sur devis'}</span>
                            <span className="inline-flex items-center gap-1 font-medium text-primary group-hover:underline">Réserver <ArrowRightIcon size={16} /></span>
                          </span>
                        </ReserveButton>
                      </li>
                    )
                  })}
                </ul>
              </div>
            </section>
          )
        })}

        {/* Domiciliation : pas de créneau, une demande de devis. */}
        <section id="domiciliation" aria-labelledby="domiciliation-titre" className={`scroll-mt-24 py-16 sm:py-24 ${fond(blocs.length)}`}>
          <div className="mx-auto grid max-w-[1200px] gap-10 px-5 sm:px-8 lg:grid-cols-2 lg:items-center lg:gap-16">
            <div>
              <h2 id="domiciliation-titre" className="text-3xl font-semibold tracking-tight text-primary sm:text-5xl">Domiciliation</h2>
              <p className="mt-4 text-pretty text-lg text-muted-foreground">
                Le siège de votre entreprise {adresse ? `au ${adresse}` : 'au centre'}{codeVille ? `, ${codeVille}` : ''}. Votre courrier est reçu à l’accueil et vous le suivez depuis votre espace client.
              </p>
              <ul className="mt-6 space-y-3">
                {['Adresse du siège social', 'Réception du courrier à l’accueil', 'Avis d’arrivée et suivi en ligne'].map((inclus) => (
                  <li key={inclus} className="flex items-center gap-3"><CheckIcon size={20} className="shrink-0 text-primary" />{inclus}</li>
                ))}
              </ul>
              <p className="mt-8 text-muted-foreground">
                {domiciliation
                  ? <>À partir de <span className="text-2xl font-semibold tracking-tight text-primary tabular">{prix(domiciliation.amountCents, currency)}</span> HT par mois</>
                  : 'Tarif sur devis'}
              </p>
              <div className="mt-4 flex flex-col gap-3 sm:flex-row">
                <ReserveButton product="domiciliation" className={primaire}>
                  Demander un devis
                  <ArrowRightIcon size={20} />
                </ReserveButton>
                {tenant.phone && telHref && (
                  <a href={telHref} className={secondaire}><PhoneIcon size={20} />{tenant.phone}</a>
                )}
              </div>
            </div>

            {optionsCourrier.length > 0 && (
              <div className="rounded-xl border border-border bg-background p-6 sm:p-8">
                <h3 className="text-lg font-semibold text-primary">À la demande</h3>
                <p className="mt-1 text-sm text-muted-foreground">Ajoutés à votre facture du mois, à l’acte.</p>
                <dl className="mt-6 divide-y divide-border">
                  {optionsCourrier.map((service) => (
                    <div key={service.id} className="flex items-baseline justify-between gap-4 py-3">
                      <dt>{service.name}</dt>
                      <dd className="shrink-0 font-medium tabular">{prix(service.unitPriceCents, service.currency)} HT</dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}
          </div>
        </section>
      </div>

      {/* Le centre -------------------------------------------------------- */}
      <section id="centre" aria-labelledby="centre-titre" className={`scroll-mt-24 py-16 sm:py-24 ${fond(blocs.length + 1)}`}>
        <div className="mx-auto max-w-[1200px] px-5 sm:px-8">
          <div className="max-w-2xl">
            <h2 id="centre-titre" className="text-3xl font-semibold tracking-tight text-primary sm:text-5xl">Le centre</h2>
            <p className="mt-4 text-pretty text-lg text-muted-foreground">
              Accueil, cuisine partagée, coin pause et espace sportif : les espaces communs sont ouverts à tous ceux qui travaillent ici.
            </p>
          </div>
          <ul className="mt-10 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4 lg:grid-rows-2">
            {espacesCommuns.map(({ src, legende }, index) => (
              <li key={src} className={`relative overflow-hidden rounded-xl bg-muted ${tuiles[index] ?? 'aspect-square'}`}>
                <figure className="absolute inset-0">
                  <Image src={src} alt="" fill sizes={index === 0 ? '(max-width: 1024px) calc(100vw - 40px), 570px' : '(max-width: 1024px) 50vw, 280px'} className="object-cover" />
                  <figcaption className="absolute bottom-3 left-3 rounded-full bg-background px-3 py-1 text-sm font-medium text-primary">{legende}</figcaption>
                </figure>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Accès ------------------------------------------------------------ */}
      <section id="acces" aria-labelledby="acces-titre" className={`scroll-mt-24 py-16 sm:py-24 ${fond(blocs.length + 2)}`}>
        <div className="mx-auto grid max-w-[1200px] gap-10 px-5 sm:px-8 lg:grid-cols-2 lg:gap-16">
          <div>
            <h2 id="acces-titre" className="text-3xl font-semibold tracking-tight text-primary sm:text-5xl">Accès</h2>
            <address className="mt-6 flex flex-col gap-1 text-lg not-italic">
              {tenant.addressLine1 && <span>{tenant.addressLine1}</span>}
              {tenant.addressLine2 && <span>{tenant.addressLine2}</span>}
              {codeVille && <span>{codeVille}</span>}
            </address>
            <a href={planUrl} target="_blank" rel="noreferrer" className="mt-4 inline-flex min-h-11 items-center gap-2 font-medium text-primary underline-offset-4 hover:underline">
              <MapPinIcon size={20} />
              Préparer mon itinéraire
              <ArrowRightIcon size={18} />
            </a>
            <dl className="mt-8 space-y-4">
              {ouverture && (
                <div className="flex items-start gap-3">
                  <dt><ClockIcon size={20} className="mt-0.5 text-primary" /><span className="sr-only">Horaires</span></dt>
                  <dd>{ouverture}</dd>
                </div>
              )}
              {tenant.phone && telHref && (
                <div className="flex items-start gap-3">
                  <dt><PhoneIcon size={20} className="mt-3 text-primary" /><span className="sr-only">Téléphone</span></dt>
                  <dd><a href={telHref} className="inline-flex min-h-11 items-center font-medium text-primary underline-offset-4 hover:underline">{tenant.phone}</a></dd>
                </div>
              )}
            </dl>
          </div>
          <div className="rounded-xl bg-background p-6 sm:p-8">
            <h3 className="text-lg font-semibold text-primary">Sur place</h3>
            <ul className="mt-5 grid gap-3 sm:grid-cols-2">
              {surPlace.map((item) => (
                <li key={item} className="flex items-center gap-3"><CheckIcon size={20} className="shrink-0 text-primary" />{item}</li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* Barre d'action fixe, téléphone seulement : sur un petit écran le
          bouton principal disparaît dès qu'on descend dans la page. */}
      <div className="sticky bottom-0 z-10 border-t border-border bg-background/95 px-5 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur sm:hidden">
        <div className="flex gap-3">
          <ReserveButton className="press flex min-h-12 flex-1 items-center justify-center rounded-md bg-primary px-4 py-3 font-medium text-primary-foreground">
            Réserver
          </ReserveButton>
          {tenant.phone && telHref && (
            <a href={telHref} aria-label={`Appeler le ${tenant.phone}`} className="flex min-h-12 min-w-12 items-center justify-center rounded-md border border-primary px-4 text-primary">
              <PhoneIcon size={22} />
            </a>
          )}
        </div>
      </div>

      <BookingDialog
        products={produits}
        resources={parProduit}
        initial={{
          product: requestedProduct,
          resourceId: bookable.find((resource) => resource.id === espace)?.id,
          date: isoDate,
          startTime: WALL_TIME.test(debut ?? '') ? debut : undefined,
          endTime: WALL_TIME.test(fin ?? '') ? fin : undefined,
        }}
        timeZone={timeZone}
        currency={currency}
        policy={{ bookingLeadHours: tenant.bookingLeadHours, bookingHorizonDays: tenant.bookingHorizonDays }}
        minDate={minDate}
        maxDate={maxDate}
      />
    </>
  )
}

/** Les sections alternent blanc et gris, quel que soit le nombre de familles proposées. */
function fond(rang: number): string {
  return rang % 2 === 1 ? 'bg-muted' : ''
}

/** Le prix le plus bas de l'unité la plus fine proposée par une famille. */
function aPartirDe(espaces: PublicBookingResource[]) {
  const premiers = espaces.flatMap((espace) => espace.rates.slice(0, 1))
  const unite = UNITES.find((unit) => premiers.some((rate) => rate.unit === unit))
  const candidats = premiers.filter((rate) => rate.unit === unite)
  return candidats.sort((a, b) => a.amountCents - b.amountCents)[0]
}

/** « 75 € », « 3,50 € » : les centimes ne s'écrivent que s'il y en a. */
function prix(amountCents: number, currency: string): string {
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency,
    minimumFractionDigits: amountCents % 100 === 0 ? 0 : 2,
  }).format(amountCents / 100)
}

/** « a, b et c » */
function enumerer(mots: string[], conjonction = 'et'): string {
  if (mots.length <= 1) return mots[0] ?? ''
  return `${mots.slice(0, -1).join(', ')} ${conjonction} ${mots[mots.length - 1]}`
}
