import Link from 'next/link'

import { requirePermission } from '../../../../lib/auth/staff.ts'
import { currentTimeZone } from '../../../../lib/tenant.ts'
import { isUuid } from '../../../../lib/uuid.ts'
import { listClients } from '../../../../modules/clients/queries.ts'
import { NewProposalForm } from '../../../../modules/facturation/proposal-new-form.tsx'
import { listBookingsForNewProposal } from '../../../../modules/facturation/propositions-accueil-queries.ts'
import type { RequesterFormValues } from '../../../../modules/facturation/propositions-ecran.ts'
import { findProposalForBooking } from '../../../../modules/facturation/propositions-queries.ts'
import { describeSlot, proposalStatusLabels } from '../../../../modules/facturation/propositions.ts'
import { proposalProducts, type ProposalProduct } from '../../../../modules/facturation/schema-devis.ts'
import { productForResourceType, questionnaires } from '../../../../modules/reservations/questionnaires.ts'
import { findBooking } from '../../../../modules/reservations/queries.ts'

export const metadata = { title: 'Nouveau devis' }

const emptyRequester: RequesterFormValues = {
  recipient: 'client',
  clientId: '',
  requesterName: '',
  requesterEmail: '',
  requesterPhone: '',
  requesterCompany: '',
  message: '',
  staffNote: '',
}

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)

/**
 * Devis établi par l'accueil (ADR 043) : on choisit d'abord ce qu'il propose,
 * puis la réservation (espace, véhicule), le destinataire et les réponses.
 * Depuis la fiche d'une réservation, `?reservation=` la rattache d'office.
 */
export default async function NewProposalPage({
  searchParams,
}: {
  searchParams: Promise<{ produit?: string | string[]; reservation?: string | string[]; client?: string | string[] }>
}) {
  await requirePermission('demandes.traiter')
  const params = await searchParams
  const timeZone = await currentTimeZone()
  const reservationId = first(params.reservation)
  // Depuis la fiche d'un client (ADR 048) : l'entreprise est présélectionnée.
  const clientParam = first(params.client)
  const presetClientId = clientParam && isUuid(clientParam) ? clientParam : undefined
  const clientQuery = presetClientId ? `&client=${presetClientId}` : ''
  const booking = reservationId && isUuid(reservationId) ? await findBooking(reservationId) : undefined
  const existing = booking ? await findProposalForBooking(booking.id) : undefined

  // La réservation impose son produit ; sinon, celui choisi.
  const requested = first(params.produit)
  const product: ProposalProduct | undefined = booking
    ? productForResourceType(booking.resource.resourceType)
    : (proposalProducts as readonly string[]).includes(requested ?? '')
      ? (requested as ProposalProduct)
      : undefined

  const header = (
    <div>
      <Link href="/devis" className="text-sm text-muted-foreground hover:underline">
        ← Devis
      </Link>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">Nouveau devis</h1>
      <p className="mt-1 max-w-prose text-sm text-muted-foreground">
        Il naît « À compléter » : vous ajoutez ensuite ses lignes, puis le validez pour qu’il parte vers
        Dolibarr.
      </p>
    </div>
  )

  if (reservationId && (!booking || booking.kind !== 'booking' || booking.status === 'cancelled' || !product || existing)) {
    return (
      <div className="flex max-w-3xl flex-col gap-6">
        {header}
        <div className="rounded-lg border border-border bg-white px-5 py-4 text-sm">
          {existing ? (
            <p>
              Cette réservation a déjà son devis :{' '}
              <Link href={`/devis/${existing.id}`} className="font-medium text-primary underline-offset-2 hover:underline">
                {existing.number} — {proposalStatusLabels[existing.status]}
              </Link>
              .
            </p>
          ) : !booking ? (
            <p>Cette réservation est introuvable. Choisissez-la dans le formulaire du devis.</p>
          ) : booking.status === 'cancelled' ? (
            <p>Cette réservation est annulée : elle ne se chiffre plus.</p>
          ) : (
            <p>Cette ressource ne se chiffre pas en devis : seuls les salles, bureaux et véhicules en ont un.</p>
          )}
          <Link href="/devis/nouveau" className="mt-3 inline-block text-primary underline-offset-2 hover:underline">
            Établir un autre devis
          </Link>
        </div>
      </div>
    )
  }

  if (!product) {
    return (
      <div className="flex max-w-3xl flex-col gap-6">
        {header}
        <nav aria-labelledby="produit-titre" className="flex flex-col gap-3">
          <h2 id="produit-titre" className="text-sm font-semibold tracking-tight">
            Que propose le devis ?
          </h2>
          <ul className="grid gap-3 sm:grid-cols-3">
            {proposalProducts.map((candidate) => (
              <li key={candidate}>
                <Link
                  href={`/devis/nouveau?produit=${candidate}${clientQuery}`}
                  className="flex h-full flex-col gap-1 rounded-lg border border-border bg-white px-4 py-3 transition-colors duration-150 ease-out hover:border-accent hover:bg-accent/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  <span className="font-medium text-primary">{questionnaires[candidate].label}</span>
                  <span className="text-sm text-muted-foreground">{questionnaires[candidate].description}</span>
                  {questionnaires[candidate].resourceTypes.length > 0 && (
                    <span className="text-xs text-muted-foreground">Sur une réservation du planning.</span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    )
  }

  const [clients, bookings] = await Promise.all([
    listClients(),
    booking ? Promise.resolve([]) : listBookingsForNewProposal(product, new Date()),
  ])

  const defaults = {
    requester: booking
      ? booking.clientId
        ? { ...emptyRequester, recipient: 'client' as const, clientId: booking.clientId }
        : {
            ...emptyRequester,
            recipient: 'prospect' as const,
            requesterName: booking.requesterName ?? '',
            requesterEmail: booking.requesterEmail ?? '',
            requesterPhone: booking.requesterPhone ?? '',
          }
      : presetClientId
        ? { ...emptyRequester, recipient: 'client' as const, clientId: presetClientId }
        : emptyRequester,
    answers: {},
    reservation: booking?.id ?? '',
  }

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      {header}
      <p className="text-sm">
        <span className="text-muted-foreground">Produit : </span>
        <span className="font-medium">{questionnaires[product].label}</span>
        {!booking && (
          <>
            {' '}
            ·{' '}
            <Link
              href={presetClientId ? `/devis/nouveau?client=${presetClientId}` : '/devis/nouveau'}
              className="text-primary underline-offset-2 hover:underline"
            >
              Changer
            </Link>
          </>
        )}
      </p>
      <NewProposalForm
        product={product}
        clients={clients.map((client) => ({ id: client.id, name: client.name }))}
        bookings={bookings.map((candidate) => ({
          id: candidate.id,
          label: `${candidate.resourceName} — ${describeSlot(candidate.startsAt, candidate.endsAt, timeZone)} — ${candidate.clientName ?? candidate.requesterName ?? candidate.title}`,
        }))}
        fixedBooking={
          booking
            ? {
                id: booking.id,
                label: `${booking.resource.name} — ${describeSlot(booking.startsAt, booking.endsAt, timeZone)} — ${booking.title}`,
              }
            : null
        }
        defaults={defaults}
      />
    </div>
  )
}
