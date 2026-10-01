import Link from 'next/link'
import { notFound } from 'next/navigation'

import { requirePermission } from '../../../../lib/auth/staff.ts'
import { formatDuration, formatLongDate, formatTime, toIsoDate } from '../../../../lib/dates.ts'
import { currentTimeZone } from '../../../../lib/tenant.ts'
import { isUuid } from '../../../../lib/uuid.ts'
import { findClient, listClients } from '../../../../modules/clients/queries.ts'
import { contractStatusLabels } from '../../../../modules/contrats/labels.ts'
import { formatContractDays, occupationDays } from '../../../../modules/contrats/occupation.ts'
import {
  assignBookingClientAction,
  cancelBookingAction,
} from '../../../../modules/reservations/actions.ts'
import { ChannelLabel } from '../../../../modules/reservations/canal.tsx'
import { bookingDisplayTitle } from '../../../../modules/reservations/occupation.ts'
import { findBooking } from '../../../../modules/reservations/queries.ts'
import { resourceTypeLabels } from '../../../../modules/ressources/labels.ts'

export const metadata = { title: 'Réservation' }

export default async function BookingPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePermission('reservations.gerer')
  const { id } = await params
  if (!isUuid(id)) notFound()
  const timeZone = await currentTimeZone()
  const booking = await findBooking(id)
  if (!booking) notFound()
  // `findClient` et non la liste : une fiche archivée reste nommée ici.
  const [clients, client] = await Promise.all([
    listClients(),
    booking.clientId ? findClient(booking.clientId) : undefined,
  ])

  const isoDate = toIsoDate(booking.startsAt, timeZone)
  const cancelled = booking.status === 'cancelled'
  // Occupation d'une ressource sous contrat (ADR 018) : des jours entiers,
  // parfois sans terme, qui ne se modifient qu'à travers le contrat.
  const occupation = booking.kind === 'contract'

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <div>
        <Link
          href={`/reservations?date=${isoDate}`}
          className="text-sm text-muted-foreground hover:underline"
        >
          ← Planning
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{bookingDisplayTitle(booking)}</h1>
        {booking.seriesId && <Link href={`/reservations/series/${booking.seriesId}`} className="mt-2 inline-block text-sm text-primary underline underline-offset-2">Voir la série et gérer les occurrences à venir</Link>}
        {cancelled && (
          <p className="mt-2 inline-block rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-foreground">
            {occupation ? 'Occupation levée — la ressource est libre' : 'Annulée — le créneau est libre'}
          </p>
        )}
      </div>

      {occupation && (
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted px-5 py-4 text-sm">
          <p>
            La ressource est occupée au titre d’un contrat. Cette occupation suit le contrat : elle
            ne se déplace ni ne s’annule ici. Pour la changer, modifiez le contrat — ressource,
            dates, résiliation ou archivage.
          </p>
          {booking.contractId && (
            <Link
              href={`/contrats/${booking.contractId}`}
              className="self-start rounded-md border border-primary bg-white px-4 py-2 font-medium text-primary transition-colors hover:bg-muted"
            >
              Ouvrir le contrat {booking.contract?.reference}
            </Link>
          )}
        </div>
      )}

      <dl className="grid grid-cols-[8rem_1fr] gap-y-3 rounded-lg border border-border bg-white px-5 py-4 text-sm">
        <dt className="text-muted-foreground">Ressource</dt>
        <dd>
          {booking.resource.name}{' '}
          <span className="text-muted-foreground">
            ({booking.resource.code} · {resourceTypeLabels[booking.resource.resourceType]})
          </span>
        </dd>

        {occupation ? (
          <>
            <dt className="text-muted-foreground">Période</dt>
            <dd className="tabular">
              {formatContractDays(occupationDays(booking, timeZone))}
            </dd>
          </>
        ) : (
          <>
            <dt className="text-muted-foreground">Date</dt>
            <dd className="capitalize">{formatLongDate(isoDate, timeZone)}</dd>

            <dt className="text-muted-foreground">Créneau</dt>
            <dd>
              {formatTime(booking.startsAt, timeZone)} – {formatTime(booking.endsAt, timeZone)}{' '}
              <span className="text-muted-foreground">
                ({formatDuration(booking.startsAt, booking.endsAt)})
              </span>
            </dd>
          </>
        )}

        {booking.contract && (
          <>
            <dt className="text-muted-foreground">Contrat</dt>
            <dd>
              <Link
                href={`/contrats/${booking.contract.id}`}
                className="underline-offset-2 hover:underline"
              >
                {booking.contract.reference}
              </Link>{' '}
              <span className="text-muted-foreground">
                ({booking.contract.deletedAt
                  ? 'archivé'
                  : contractStatusLabels[booking.contract.status].toLowerCase()})
              </span>
            </dd>
          </>
        )}

        <dt className="text-muted-foreground">Canal</dt>
        <dd>
          <ChannelLabel channel={booking.channel} detailed />
        </dd>

        <dt className="text-muted-foreground">Client</dt>
        <dd>
          {client ? (
            <Link href={`/clients/${client.id}`} className="underline-offset-2 hover:underline">
              {client.name}
            </Link>
          ) : (
            <span className="text-muted-foreground">
              {booking.requesterName ? `Aucun — demandé par ${booking.requesterName}` : 'Aucun'}
            </span>
          )}
        </dd>

        {/* Demande publique arrivée au terme de sa conservation (ADR 020) :
            dire pourquoi le demandeur n'apparaît plus. */}
        {booking.requesterAnonymizedAt && (
          <>
            <dt className="text-muted-foreground">Demandeur</dt>
            <dd>
              Coordonnées effacées le{' '}
              {formatLongDate(toIsoDate(booking.requesterAnonymizedAt, timeZone), timeZone)}, au
              terme de leur durée de conservation
            </dd>
          </>
        )}

        {booking.notes && (
          <>
            <dt className="text-muted-foreground">Notes</dt>
            <dd className="whitespace-pre-line">{booking.notes}</dd>
          </>
        )}

        {cancelled && (
          <>
            <dt className="text-muted-foreground">Annulée le</dt>
            <dd>
              {booking.cancelledAt
                ? `${formatLongDate(toIsoDate(booking.cancelledAt, timeZone), timeZone)} à ${formatTime(booking.cancelledAt, timeZone)}`
                : '—'}
            </dd>
            <dt className="text-muted-foreground">Motif</dt>
            <dd>{booking.cancellationReason ?? '—'}</dd>
          </>
        )}
      </dl>

      {!cancelled && !occupation && (
        <div>
          <Link
            href={`/reservations/${booking.id}/modifier`}
            className="inline-block rounded-md border border-primary px-4 py-2 text-sm font-medium text-primary transition-colors hover:bg-muted"
          >
            Déplacer la réservation
          </Link>
        </div>
      )}

      {booking.kind === 'booking' && clients.length > 0 && (
        <form
          action={assignBookingClientAction}
          className="flex flex-col gap-3 rounded-lg border border-border bg-white px-5 py-4 sm:flex-row sm:items-end"
        >
          <input type="hidden" name="id" value={booking.id} />
          <div className="flex-1">
            <label className="block text-sm font-medium text-foreground" htmlFor="clientId">
              Client rattaché
            </label>
            <select
              id="clientId"
              name="clientId"
              defaultValue={booking.clientId ?? ''}
              aria-describedby="clientId-hint"
              className="mt-1 w-full rounded-sm border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/40"
            >
              <option value="">Aucun</option>
              {clients.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </select>
            <p id="clientId-hint" className="mt-1 text-xs text-muted-foreground">
              La réservation apparaît dans l’espace de ce client.
              {booking.contract &&
                ` Changer de client la détache du contrat ${booking.contract.reference}.`}
            </p>
          </div>
          <button
            type="submit"
            className="self-start rounded-md border border-border px-4 py-2 text-sm font-medium hover:bg-muted sm:self-auto"
          >
            Enregistrer
          </button>
        </form>
      )}

      {/* Pas de suppression : la réservation reste consultable, l'annulation est
          sa suppression logique (décision 6). Une occupation de contrat
          s'annule par son contrat (ADR 018). */}
      {!cancelled && !occupation && (
        <form
          action={cancelBookingAction}
          className="flex flex-col gap-3 rounded-lg border border-border bg-white px-5 py-4"
        >
          <input type="hidden" name="id" value={booking.id} />
          <label
            className="text-sm font-medium text-foreground"
            htmlFor="reason"
          >
            Annuler cette réservation
          </label>
          <input
            id="reason"
            name="reason"
            placeholder="Motif (facultatif)"
            className="w-full rounded-sm border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/40"
          />
          <button
            type="submit"
            className="self-start rounded-md border border-destructive/30 px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/5"
          >
            Annuler la réservation
          </button>
        </form>
      )}
    </div>
  )
}
