import Link from 'next/link'

import { can } from '../../../lib/auth/permissions.ts'
import { requirePermission } from '../../../lib/auth/staff.ts'
import {
  formatDateTime,
  formatDuration,
  formatLongDate,
  formatTime,
  toIsoDate,
} from '../../../lib/dates.ts'
import { currentTimeZone } from '../../../lib/tenant.ts'
import { frozenQuoteDisplay } from '../../../modules/facturation/devis.ts'
import { DismissOfferRequestForm } from '../../../modules/facturation/dismiss-offer-request-form.tsx'
import {
  DISMISSAL_REASON_MAX_LENGTH,
  OFFER_REQUEST_LIST_DAYS,
  listOfferRequests,
} from '../../../modules/facturation/offres-portail.ts'
import { formatCents } from '../../../modules/facturation/tarifs.ts'
import {
  confirmBookingAction,
  refuseBookingAction,
} from '../../../modules/reservations/actions.ts'
import { ChannelLabel } from '../../../modules/reservations/canal.tsx'
import { listPendingRequests } from '../../../modules/reservations/demandes-queries.ts'
import { resourceTypeLabels } from '../../../modules/ressources/labels.ts'

export const metadata = { title: 'Demandes' }

/**
 * File des demandes : réservations déposées depuis le site public (ADR 005)
 * ou depuis l'espace client, sur une ressource soumise à l'accord de
 * l'accueil (ADR 036) ; et offres groupées demandées depuis l'espace client
 * (`offer_requests`, ADR 041), dont l'accueil tire le contrat ou qu'il écarte.
 *
 * Chaque demande de réservation bloque déjà son créneau : traiter la file vite
 * n'est pas une question de confort, c'est ce qui libère les salles que
 * personne ne prendra.
 */
export default async function DemandesPage() {
  const { member } = await requirePermission('demandes.traiter')
  const timeZone = await currentTimeZone()
  const [pending, offerRequests] = await Promise.all([listPendingRequests(), listOfferRequests()])
  const canDrawContract = can(member.role, 'contrats.creer')
  const openOfferRequests = offerRequests.filter((request) => request.status === 'requested')

  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="reservations-titre" className="flex flex-col gap-6">
        <div>
          <h1 id="reservations-titre" className="text-2xl font-semibold tracking-tight">
            Demandes à valider
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Déposées depuis le site public ou depuis l’espace client. Chaque demande occupe déjà son
            créneau : la refuser le libère.
          </p>
        </div>

        {pending.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border bg-white px-6 py-12 text-center">
            <p className="text-sm text-muted-foreground">Aucune demande de réservation en attente.</p>
            <Link
              href="/reservations"
              className="mt-4 inline-block text-sm text-muted-foreground underline-offset-2 hover:underline"
            >
              Revenir au planning
            </Link>
          </div>
        ) : (
          <ul className="flex flex-col gap-4">
            {pending.map((booking) => {
              const isoDate = toIsoDate(booking.startsAt, timeZone)
              const quote = frozenQuoteDisplay(booking)
              // Depuis l'espace client : la personne de l'entreprise ; depuis la
              // page publique : les coordonnées saisies (ADR 005).
              const email = booking.bookedBy?.email ?? booking.requesterEmail
              return (
                <li
                  key={booking.id}
                  className="flex flex-col gap-4 rounded-lg border border-border bg-white p-5 lg:flex-row lg:items-start lg:justify-between"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium text-primary">
                        À valider
                      </span>
                      <h2 className="font-medium">{booking.title}</h2>
                    </div>

                    <p className="mt-2 text-sm capitalize text-muted-foreground">
                      {formatLongDate(isoDate, timeZone)}
                    </p>
                    <p className="text-sm text-muted-foreground tabular">
                      {formatTime(booking.startsAt, timeZone)} –{' '}
                      {formatTime(booking.endsAt, timeZone)} ({' '}
                      {formatDuration(booking.startsAt, booking.endsAt)} ) ·{' '}
                      {booking.resource.name} ({resourceTypeLabels[booking.resource.resourceType]})
                    </p>

                    <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
                      <dt className="text-muted-foreground">Canal</dt>
                      <dd>
                        <ChannelLabel channel={booking.channel} />
                      </dd>
                      {booking.clientName && (
                        <>
                          <dt className="text-muted-foreground">Client</dt>
                          <dd>
                            {booking.clientId ? (
                              <Link
                                href={`/clients/${booking.clientId}`}
                                className="underline-offset-2 hover:underline"
                              >
                                {booking.clientName}
                              </Link>
                            ) : (
                              booking.clientName
                            )}
                          </dd>
                        </>
                      )}
                      <dt className="text-muted-foreground">Demandeur</dt>
                      <dd>{booking.bookedBy?.name ?? booking.requesterName ?? '—'}</dd>
                      <dt className="text-muted-foreground">Courriel</dt>
                      <dd>
                        {email ? (
                          <a href={`mailto:${email}`} className="underline-offset-2 hover:underline">
                            {email}
                          </a>
                        ) : (
                          '—'
                        )}
                      </dd>
                      {!booking.bookedBy && (
                        <>
                          <dt className="text-muted-foreground">Téléphone</dt>
                          <dd>
                            {booking.requesterPhone ? (
                              <a
                                href={`tel:${booking.requesterPhone.replace(/\s/g, '')}`}
                                className="underline-offset-2 hover:underline"
                              >
                                {booking.requesterPhone}
                              </a>
                            ) : (
                              '—'
                            )}
                          </dd>
                        </>
                      )}
                      <dt className="text-muted-foreground">Montant</dt>
                      <dd className="tabular">
                        {quote
                          ? `${formatCents(quote.totalCents, quote.currency)} TTC, figé sur la demande`
                          : 'Non chiffrée : à préciser au client'}
                      </dd>
                    </dl>

                    {booking.notes && (
                      <p className="mt-3 whitespace-pre-line rounded-md bg-muted p-3 text-sm text-muted-foreground">
                        {booking.notes}
                      </p>
                    )}
                  </div>

                  <div className="flex shrink-0 flex-col gap-3 lg:w-64">
                    <form action={confirmBookingAction}>
                      <input type="hidden" name="id" value={booking.id} />
                      <button
                        type="submit"
                        className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover"
                      >
                        Valider la demande
                      </button>
                    </form>

                    <form action={refuseBookingAction} className="flex flex-col gap-2">
                      <input type="hidden" name="id" value={booking.id} />
                      <label htmlFor={`motif-${booking.id}`} className="text-sm font-medium">
                        Motif du refus <span className="font-normal text-muted-foreground">(facultatif)</span>
                      </label>
                      <input
                        id={`motif-${booking.id}`}
                        name="reason"
                        className="w-full rounded-sm border border-border px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/40"
                      />
                      <button
                        type="submit"
                        className="w-full rounded-md border border-destructive/30 px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/5"
                      >
                        Refuser
                      </button>
                    </form>

                    <Link
                      href={`/reservations?date=${isoDate}`}
                      className="text-center text-sm text-muted-foreground underline-offset-2 hover:underline"
                    >
                      Voir le planning du jour
                    </Link>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="offres-titre" className="flex flex-col gap-4">
        <div>
          <h2 id="offres-titre" className="text-lg font-semibold tracking-tight">
            Offres demandées depuis l’espace client{' '}
            <span className="font-normal text-muted-foreground">({openOfferRequests.length} à traiter)</span>
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Une demande n’engage rien : le contrat tiré de l’offre la traite, ou l’accueil l’écarte.
            Les demandes traitées restent affichées {OFFER_REQUEST_LIST_DAYS} jours ; le client
            retrouve les siennes dans son historique.
          </p>
        </div>
        {offerRequests.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border bg-white px-6 py-8 text-center text-sm text-muted-foreground">
            Aucune offre demandée. Les offres se présentent dans l’espace client depuis leur fiche
            (« Offres »).
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-white">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">Demandée le</th>
                  <th scope="col" className="px-4 py-3 font-medium">Client</th>
                  <th scope="col" className="px-4 py-3 font-medium">Offre</th>
                  <th scope="col" className="px-4 py-3 font-medium">État et suite</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {offerRequests.map((request) => (
                  <tr key={request.id} className="align-top">
                    <td className="whitespace-nowrap px-4 py-3 tabular">
                      {formatDateTime(request.requestedAt, timeZone)}
                    </td>
                    <td className="px-4 py-3">
                      <Link href={`/clients/${request.clientId}`} className="underline-offset-2 hover:underline">
                        {request.clientName}
                      </Link>
                      {request.requestedByName && (
                        <span className="block text-xs text-muted-foreground">
                          par {request.requestedByName}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">{request.offerName}</td>
                    <td className="px-4 py-3">
                      {request.status === 'contracted' && request.contract ? (
                        <Link
                          href={`/contrats/${request.contract.id}`}
                          className="underline-offset-2 hover:underline"
                        >
                          Contrat {request.contract.reference} établi
                        </Link>
                      ) : request.status === 'dismissed' ? (
                        <>
                          <span>
                            Écartée
                            {request.closedAt ? ` le ${formatDateTime(request.closedAt, timeZone)}` : ''}
                            {request.closedByName ? ` par ${request.closedByName}` : ''}
                          </span>
                          {request.dismissalReason && (
                            <span className="block text-xs text-muted-foreground">
                              Motif : {request.dismissalReason}
                            </span>
                          )}
                        </>
                      ) : (
                        <>
                          <span className="font-medium">À traiter</span>
                          {canDrawContract ? (
                            <Link
                              href={`/contrats/nouveau/offre?${new URLSearchParams({ offre: request.offerId, client: request.clientId }).toString()}`}
                              className="block font-medium text-primary underline-offset-2 hover:underline"
                            >
                              Préparer le contrat
                            </Link>
                          ) : (
                            <span className="block text-muted-foreground">
                              Contrat : à transmettre à l’exploitant
                            </span>
                          )}
                          <DismissOfferRequestForm
                            requestId={request.id}
                            subject={`${request.offerName}, ${request.clientName}`}
                            maxLength={DISMISSAL_REASON_MAX_LENGTH}
                          />
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
