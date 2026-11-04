import Link from 'next/link'

import { frozenQuoteDisplay, type QuoteDisplay } from '../facturation/devis.ts'
import { formatQuoteQuantity } from '../facturation/devis-resume.tsx'
import { formatCents } from '../facturation/tarifs.ts'
import { describeAttributes } from '../ressources/labels.ts'
import { AddOptionsForm } from './add-options-form.tsx'
import { bookingStatusBadgeStyles, bookingStatusLabels } from './labels.ts'
import { acceptsEquipmentOptions, totalWithOptions } from './options.ts'
import { listFreeEquipment, listOptionsOf } from './options-queries.ts'
import type { BookingWithResource } from './queries.ts'

/** « 36,00 € TTC · 1 journée », ou « Non chiffré ». */
function priceLabel(quote: QuoteDisplay | null | undefined): string {
  if (!quote) return 'Non chiffré'
  return `${formatCents(quote.totalCents, quote.currency)} TTC · ${formatQuoteQuantity(quote.unit, quote.quantity)}`
}

/**
 * Le matériel en option d'une réservation de salle, sur sa fiche (ADR 062) :
 * les appareils réservés avec elle, le total, et « Ajouter du matériel »
 * parmi ceux qui sont libres sur la même période. Rien pour une réservation
 * qui n'en reçoit pas (autre type, occupation de contrat, option elle-même).
 */
export async function OptionsSection({ booking }: { booking: BookingWithResource }) {
  if (booking.kind !== 'booking' || booking.parentBookingId || !acceptsEquipmentOptions(booking.resource.resourceType)) {
    return null
  }
  const cancelled = booking.status === 'cancelled'
  const [options, free] = await Promise.all([
    listOptionsOf([booking.id]),
    cancelled ? [] : listFreeEquipment({ startsAt: booking.startsAt, endsAt: booking.endsAt, clientId: booking.clientId }),
  ])
  const live = options.filter((option) => option.status !== 'cancelled')
  const total = totalWithOptions([frozenQuoteDisplay(booking), ...live.map((option) => option.quote)])

  return (
    <section aria-labelledby="materiel-titre" className="flex flex-col gap-4 rounded-lg border border-border bg-white px-5 py-4 text-sm">
      <div>
        <h2 id="materiel-titre" className="font-medium text-foreground">
          Matériel en option
        </h2>
        <p className="mt-1 text-muted-foreground">
          Télévision, climatisation, vidéoprojecteur… loués avec la salle. Chaque appareil a son planning : il
          ne peut pas être loué deux fois.
        </p>
      </div>

      {options.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <caption className="sr-only">Appareils réservés avec cette salle</caption>
            <thead className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th scope="col" className="py-2 pr-4 font-medium">Appareil</th>
                <th scope="col" className="py-2 pr-4 font-medium">État</th>
                <th scope="col" className="py-2 font-medium">Prix</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {options.map((option) => (
                <tr key={option.id}>
                  <td className="py-2 pr-4">
                    <Link href={`/reservations/${option.id}`} className="font-medium text-primary underline-offset-2 hover:underline">
                      {option.resource.name}
                    </Link>
                    <span className="block text-xs text-muted-foreground">
                      {[option.resource.code, describeAttributes(option.resource.attributes ?? {})].filter(Boolean).join(' · ')}
                    </span>
                  </td>
                  <td className="py-2 pr-4">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${bookingStatusBadgeStyles[option.status]}`}>
                      {bookingStatusLabels[option.status]}
                    </span>
                  </td>
                  <td className="py-2 tabular">{option.status === 'cancelled' ? '—' : priceLabel(option.quote)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {live.length > 0 && total.currency && (
            <p className="mt-2 tabular">
              <span className="text-muted-foreground">Salle et matériel : </span>
              <span className="font-medium">{formatCents(total.totalCents, total.currency)} TTC</span>
              {total.unpriced > 0 && <span className="text-muted-foreground"> — hors ce qui n’est pas chiffré</span>}
            </p>
          )}
        </div>
      )}

      {cancelled ? (
        options.length === 0 && <p className="text-muted-foreground">Réservation annulée : aucun matériel n’y était lié.</p>
      ) : free.length > 0 ? (
        <AddOptionsForm
          bookingId={booking.id}
          choices={free.map((device) => ({
            id: device.id,
            label: device.name,
            detail: [device.code, describeAttributes(device.attributes ?? {})].filter(Boolean).join(' · '),
            price: priceLabel(device.quote),
          }))}
        />
      ) : (
        <p className="rounded-md border border-dashed border-border px-4 py-3 text-muted-foreground">
          Aucun appareil libre sur cette période.{' '}
          <Link href="/ressources?type=materiel" className="text-primary underline underline-offset-2">
            Le parc du matériel
          </Link>{' '}
          dit ce qui est en service ;{' '}
          <Link href="/reservations/semaine?type=materiel" className="text-primary underline underline-offset-2">
            son planning
          </Link>{' '}
          ce qui est déjà loué.
        </p>
      )}
    </section>
  )
}
