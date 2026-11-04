import Link from 'next/link'

import { TriangleAlertIcon } from '../../components/ui/icons.tsx'
import { formatDateTime, formatTime, toIsoDate } from '../../lib/dates.ts'
import { bookingHref } from '../reservations/affichage.ts'
import { newInspectionHref } from './inspections-section.tsx'
import type { ConflictingBooking, UnreturnedOccupation } from './restitution.ts'

/** Réservations en conflit nommées une à une ; le reste est compté. */
const SHOWN = 3

const lien =
  'font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

/** « 04/11/2026 14:00 – 17:00 », la fin datée si elle tombe un autre jour. */
function period(booking: { startsAt: Date; endsAt: Date }, timeZone: string): string {
  const sameDay = toIsoDate(booking.startsAt, timeZone) === toIsoDate(booking.endsAt, timeZone)
  return `${formatDateTime(booking.startsAt, timeZone)} – ${
    sameDay ? formatTime(booking.endsAt, timeZone) : formatDateTime(booking.endsAt, timeZone)
  }`
}

/** Lien de la sortie qui lève le blocage : la même occupation que l'entrée. */
export function exitHref(occupation: UnreturnedOccupation): string {
  if (occupation.booking) return newInspectionHref({ reservation: occupation.booking.id }, 'exit')
  if (occupation.contract) return newInspectionHref({ contrat: occupation.contract.id }, 'exit')
  return newInspectionHref({ ressource: occupation.resource.id }, 'exit')
}

function ConflictList({
  conflicts,
  timeZone,
}: {
  conflicts: ConflictingBooking[]
  timeZone: string
}) {
  if (conflicts.length === 0) {
    return <p className="text-muted-foreground">Aucune réservation à venir sur la ressource.</p>
  }
  const rest = conflicts.length - SHOWN
  return (
    <p>
      <span className="font-medium text-statut-conflit">
        {conflicts.length > 1 ? `${conflicts.length} réservations en conflit` : 'Réservation en conflit'}
      </span>{' '}
      :{' '}
      {conflicts.slice(0, SHOWN).map((booking, index) => (
        <span key={booking.id}>
          {index > 0 && ', '}
          <Link href={bookingHref(booking)} className={`${lien} tabular`}>
            {period(booking, timeZone)} « {booking.title} »
          </Link>
          {booking.clientName && <span className="text-muted-foreground"> ({booking.clientName})</span>}
        </span>
      ))}
      {rest > 0 && <span> et {rest > 1 ? `${rest} autres` : '1 autre'}</span>}.
    </p>
  )
}

/**
 * Alerte « ressource non restituée » (ADR 063) : la fin prévue d'une
 * occupation est dépassée et sa sortie n'est pas close. La base refuse alors
 * toute nouvelle réservation de la ressource qui finirait après cette fin ;
 * celles déjà posées sont en conflit. Le seul cas anormal du planning : le
 * rouge `--statut-conflit`, toujours avec son icône et son texte.
 *
 * Rien n'est rendu sans occupation non restituée : l'écran ne change pas de
 * forme les jours ordinaires.
 */
export function UnreturnedNotice({
  occupations,
  timeZone,
  now = new Date(),
  canInspect,
  headingLevel = 2,
}: {
  occupations: readonly UnreturnedOccupation[]
  timeZone: string
  now?: Date
  /** Droit `etats-des-lieux.gerer` : propose la sortie qui lève le blocage. */
  canInspect: boolean
  headingLevel?: 2 | 3
}) {
  if (occupations.length === 0) return null
  const Heading = headingLevel === 2 ? 'h2' : 'h3'
  const title =
    occupations.length > 1
      ? `${occupations.length} ressources non restituées`
      : 'Ressource non restituée'

  return (
    <section
      aria-labelledby="non-restituees-titre"
      className="rounded-lg border border-l-4 border-statut-conflit bg-white px-4 py-3 text-sm"
    >
      <Heading
        id="non-restituees-titre"
        className="flex items-center gap-2 text-sm font-semibold text-statut-conflit"
      >
        <TriangleAlertIcon size={20} className="shrink-0" />
        {title}
      </Heading>
      <p className="mt-1 max-w-prose text-muted-foreground">
        La fin prévue est dépassée et l’état des lieux de sortie n’est pas clos : la ressource reste
        occupée. Aucune nouvelle réservation ne s’y pose avant la sortie.
      </p>
      <ul className="mt-2 flex flex-col divide-y divide-border">
        {occupations.map((occupation) => {
          const upcoming = occupation.conflicts.filter((booking) => booking.endsAt.getTime() > now.getTime())
          return (
            <li key={occupation.entryId} className="flex flex-col gap-1 py-2">
              <p>
                <span className="font-medium">{occupation.resource.name}</span>{' '}
                <span className="text-muted-foreground">({occupation.resource.code})</span> —{' '}
                {occupation.client.name},{' '}
                {occupation.booking
                  ? `réservation « ${occupation.booking.title} »`
                  : occupation.contract
                    ? `contrat ${occupation.contract.reference}`
                    : 'occupation'}{' '}
                : fin prévue le <span className="tabular">{formatDateTime(occupation.since, timeZone)}</span>.
              </p>
              <ConflictList conflicts={upcoming} timeZone={timeZone} />
              {canInspect ? (
                <p className="flex flex-wrap gap-x-4 gap-y-1">
                  <Link href={exitHref(occupation)} className={lien}>
                    Faire l’état des lieux de sortie
                  </Link>
                  <Link href={`/etats-des-lieux/${occupation.entryId}`} className={lien}>
                    Voir l’entrée
                  </Link>
                </p>
              ) : (
                <p className="text-muted-foreground">La sortie se fait par l’accueil ou l’exploitant.</p>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
