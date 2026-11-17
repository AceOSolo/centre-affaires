import { Fragment } from 'react'

import Link from 'next/link'
import { notFound } from 'next/navigation'

import { FlashNotice } from '../../../../components/ui/flash-notice.tsx'
import { CheckIcon, TriangleAlertIcon } from '../../../../components/ui/icons.tsx'
import { LienRetour } from '../../../../components/ui/lien-retour.tsx'
import { can } from '../../../../lib/auth/permissions.ts'
import { requirePermission } from '../../../../lib/auth/staff.ts'
import { addDaysToIsoDate, formatLongDate, todayIsoDate, toIsoDate } from '../../../../lib/dates.ts'
import { currentTimeZone } from '../../../../lib/tenant.ts'
import { ResourceTimeline } from '../../../../modules/etats-des-lieux/chronologie-ressource.tsx'
import { UnreturnedNotice } from '../../../../modules/etats-des-lieux/non-restituees.tsx'
import {
  listUnreturnedOccupations,
  markConflicts,
  unreturnedFor,
} from '../../../../modules/etats-des-lieux/restitution.ts'
import { rateUnitLabels } from '../../../../modules/facturation/labels.ts'
import { findDefaultRatePlan } from '../../../../modules/facturation/queries.ts'
import { formatCents } from '../../../../modules/facturation/tarifs.ts'
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
import { AnnonceMedias } from '../../../../modules/ressources/annonce-medias.tsx'
import { parseListingMedia } from '../../../../modules/ressources/annonces-medias.ts'
import { findListingForResource } from '../../../../modules/ressources/annonces-queries.ts'
import { ClientBookingModeForm } from '../../../../modules/ressources/client-booking-mode-form.tsx'
import { ResourceMediaStart } from '../../../../modules/ressources/fiche-medias.tsx'
import {
  resourceTariffPattern,
  showsMediaOnResource,
  tariffLines,
  tariffRefProblem,
  typeTariffRef,
} from '../../../../modules/ressources/fiche-ressource.ts'
import { acceptsRentalFormulas, formulasOf } from '../../../../modules/ressources/formules.ts'
import { RentalFormulasForm } from '../../../../modules/ressources/formules-form.tsx'
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
 *
 * Elle montre aussi ses prix et la référence Dolibarr qui les envoie, déduite
 * du code (ADR 049, ADR 082), et gère ses photos et vidéos — celles de son
 * annonce (ADR 073), créée en brouillon au besoin.
 */
export default async function ResourcePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { member } = await requirePermission('ressources.gerer')
  const { id } = await params
  // Arrivée depuis « Créer » (recette du 17/11) : on confirme, et on invite
  // aux photos et vidéos, qui s'ajoutent ici.
  const created = (await searchParams).creee === '1'
  // Un identifiant mal formé ferait échouer la requête en 22P02 : c'est une
  // page introuvable, pas une erreur serveur.
  if (!UUID.test(id)) notFound()
  const resource = await findResource(id)
  if (!resource) notFound()

  const timeZone = await currentTimeZone()
  const today = todayIsoDate(timeZone)
  const last = addDaysToIsoDate(today, HORIZON_DAYS - 1)
  const [between, allUnreturned, listing, ratePlan] = await Promise.all([
    listBookingsBetween(today, last, timeZone),
    listUnreturnedOccupations(),
    findListingForResource(resource.id),
    // Les prix du jour : la grille par défaut en vigueur, celle de la réservation en ligne.
    findDefaultRatePlan(today),
  ])
  // Non restituée (ADR 063) : ses réservations suivantes sont en conflit.
  const unreturned = unreturnedFor(allUnreturned, resource.id)
  const upcoming = markConflicts(
    between.filter((booking) => booking.resourceId === resource.id && booking.status !== 'cancelled'),
    unreturned,
  )

  const archived = Boolean(resource.deletedAt)
  const attributes = (resource.attributes ?? {}) as Record<string, unknown>
  const fields = attributeFields[resource.resourceType]
  const prices = ratePlan ? tariffLines(resource, ratePlan.items) : []
  const refProblem = tariffRefProblem(resource.code)
  const showsMedia = showsMediaOnResource(resource.resourceType, Boolean(listing), archived)

  return (
    <div className="flex flex-col gap-6">
      <div>
        <LienRetour href="/ressources" label="Ressources" />
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

      <UnreturnedNotice
        occupations={unreturned}
        timeZone={timeZone}
        canInspect={can(member.role, 'etats-des-lieux.gerer')}
      />

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

      {/* Prix et référence Dolibarr (ADR 049, ADR 082) : la référence se déduit
          du code, elle ne se saisit pas à part. */}
      <section
        aria-labelledby="dolibarr"
        className="flex flex-col gap-3 rounded-lg border border-border bg-white px-5 py-4 text-sm"
      >
        <div>
          <h2 id="dolibarr" className="text-sm font-semibold tracking-tight">
            Prix et référence Dolibarr
          </h2>
          {/* Pas de `<code>` : il passerait en police monospace, que la charte exclut. */}
          <p className="mt-1 max-w-[75ch] text-muted-foreground">
            Les prix arrivent de Dolibarr par la référence du produit : pour un prix propre à cette
            ressource,{' '}
            <span className="break-all font-medium text-foreground">
              {resourceTariffPattern(resource.resourceType, resource.code)}
            </span>{' '}
            ; pour tout le type,{' '}
            <span className="break-all font-medium text-foreground">tarif.{resource.resourceType}.&lt;unité&gt;</span>
            {' '}— unité parmi heure, demi-journee, journee, semaine, mois. La référence suit le code
            interne :{' '}
            {archived ? (
              'changer le code'
            ) : (
              <Link href={`/ressources/${resource.id}/modifier`} className="font-medium text-primary underline-offset-2 hover:underline">
                changer le code
              </Link>
            )}{' '}
            la change aussi, et les produits sont alors à renommer dans Dolibarr.
          </p>
        </div>

        {refProblem && (
          <p className="flex items-start gap-2 rounded-md border border-statut-conflit/40 bg-white px-3 py-2">
            <TriangleAlertIcon size={16} className="mt-0.5 shrink-0 text-statut-conflit" />
            {refProblem}
          </p>
        )}

        {!ratePlan ? (
          <p>
            <span className="font-medium">Pas de prix</span> : aucune grille tarifaire par défaut n’est en
            vigueur aujourd’hui, Dolibarr n’a nulle part où poser ses prix.{' '}
            {can(member.role, 'tarifs.gerer') && (
              <Link href="/tarifs" className="font-medium text-primary underline-offset-2 hover:underline">
                Grilles tarifaires
              </Link>
            )}
          </p>
        ) : prices.length === 0 ? (
          <p>
            <span className="font-medium">Pas de prix</span> : aucun prix reçu pour cette ressource ni
            pour son type. Le site annonce alors « tarif communiqué par l’accueil ».
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">
                Prix de {resource.name} dans la grille « {ratePlan.name} », par unité
              </caption>
              <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">Unité</th>
                  <th scope="col" className="px-4 py-2 font-medium">Référence Dolibarr</th>
                  <th scope="col" className="px-4 py-2 font-medium">État</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">Prix HT</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {prices.map((line) => {
                  const own = line.resourceCents !== null
                  return (
                    <tr key={line.unit}>
                      <th scope="row" className="whitespace-nowrap px-4 py-2 font-medium">
                        {rateUnitLabels[line.unit]}
                      </th>
                      <td className="break-all px-4 py-2">
                        {line.resourceRef}
                        {!own && (
                          <span className="block text-xs text-muted-foreground">
                            Prix appliqué : celui du type, {typeTariffRef(resource.resourceType, line.unit)}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2">
                        {own ? (
                          <span className="inline-flex items-center gap-1 font-medium text-primary">
                            <CheckIcon size={16} /> Prix reçu
                          </span>
                        ) : (
                          <span className="text-muted-foreground">Pas de prix propre</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 text-right tabular">
                        {formatCents(line.resourceCents ?? line.typeCents ?? 0, ratePlan.currency)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

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
                          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
                            booking.conflict
                              ? 'border border-statut-conflit bg-white text-statut-conflit'
                              : bookingStatusBadgeStyles[booking.status]
                          }`}
                        >
                          {booking.conflict && <TriangleAlertIcon size={14} />}
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

      {/* Chronologie des états des lieux, par occupation (R06, ADR 039, ADR 063). */}
      {can(member.role, 'etats-des-lieux.gerer') && (
        <ResourceTimeline
          resourceId={resource.id}
          timeZone={timeZone}
          unavailable={archived ? 'Ressource archivée : plus d’état des lieux à ouvrir.' : undefined}
        />
      )}

      {/* Photos et vidéos (ADR 082) : celles de l'annonce du site (ADR 073), sans
          second stockage ; l'annonce se crée en brouillon au besoin. */}
      {created && !showsMedia && <FlashNotice>Ressource créée.</FlashNotice>}

      {/* Ancre de « Créer » ; la confirmation, en tête du bloc, y porte le focus. */}
      {showsMedia && (
        <div id="medias" className="flex scroll-mt-24 flex-col gap-3">
          {created && <FlashNotice>Ressource créée : ajoutez ses photos et vidéos.</FlashNotice>}
          {listing ? (
          <div className="flex flex-col gap-2">
            <AnnonceMedias listingId={listing.id} headline={listing.headline} media={parseListingMedia(listing.media)} />
            <p className="max-w-4xl text-sm text-muted-foreground">
              Ce sont les photos et vidéos de l’annonce « {listing.headline} »,{' '}
              {listing.publishedAt ? 'publiée sur le site' : 'en brouillon, invisible du public'}.{' '}
              <Link
                href={`/ressources/annonces/${resource.id}`}
                className="font-medium text-primary underline-offset-2 hover:underline"
              >
                Modifier l’annonce
              </Link>{' '}
              (titre, texte, publication).
            </p>
          </div>
        ) : (
          <section aria-labelledby="photos" className="flex max-w-4xl flex-col gap-3">
            <div>
              <h2 id="photos" className="text-lg font-semibold tracking-tight">
                Photos et vidéos
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Elles défilent en tête de l’annonce de la ressource sur le site. Elle n’en a pas
                encore : le bouton en prépare une en brouillon, invisible du public tant que personne
                ne la publie.
              </p>
            </div>
            <ResourceMediaStart resourceId={resource.id} />
          </section>
          )}
        </div>
      )}

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

      {/* Formules de location d'un bureau : coworking ou longue durée (ADR 076). */}
      {!archived && acceptsRentalFormulas(resource.resourceType) && (
        <section
          className="flex flex-col gap-3 rounded-lg border border-border bg-white px-5 py-4"
          aria-labelledby="formules-location"
        >
          <h2 id="formules-location" className="text-sm font-semibold tracking-tight">
            Formules de location
          </h2>
          <RentalFormulasForm resourceId={resource.id} formulas={formulasOf(resource)} />
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
