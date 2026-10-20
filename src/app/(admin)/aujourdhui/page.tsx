import Link from 'next/link'

import {
  ArrowRightIcon,
  CalendarIcon,
  CheckIcon,
  ClockIcon,
  FileTextIcon,
  MailIcon,
} from '../../../components/ui/icons.tsx'
import { can } from '../../../lib/auth/permissions.ts'
import { requireAnyPermission } from '../../../lib/auth/staff.ts'
import { formatDateTime, formatLongDate, formatTime, toIsoDate, todayIsoDate } from '../../../lib/dates.ts'
import { currentTenant } from '../../../lib/tenant.ts'
import { listClients } from '../../../modules/clients/queries.ts'
import { countPendingMailRequests } from '../../../modules/courrier/demandes-queries.ts'
import { listInspections } from '../../../modules/etats-des-lieux/queries.ts'
import { awaitsReception } from '../../../modules/facturation/propositions.ts'
import { listProposals } from '../../../modules/facturation/propositions-queries.ts'
import { bookingStatusLabels } from '../../../modules/reservations/labels.ts'
import { listBookingsForDay, listPendingBookings } from '../../../modules/reservations/queries.ts'
import { dayTimeline, todayPermissions, todoTiles, type TodayCounts } from './journee.ts'

export const metadata = { title: 'Aujourd’hui' }

/** Demandes listées sous les tuiles : les plus proches d'abord, le reste est dans « Demandes ». */
const PENDING_SHOWN = 5

const tileIcons: Record<keyof TodayCounts, typeof MailIcon> = {
  requests: ClockIcon,
  mailRequests: MailIcon,
  inspectionsToFinish: FileTextIcon,
  inspectionsToSign: FileTextIcon,
}

const lien = 'inline-flex min-h-6 items-center gap-1.5 text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring'

/**
 * Page d'arrivée de l'équipe (ADR 050) : ce qui attend, puis la journée.
 *
 * Elle ne remplace aucun écran : chaque tuile, chaque ligne mène à celui qui
 * traite. Elle s'ouvre avec un seul des droits qu'elle réunit, et chaque
 * bloc vérifie le sien — l'accueil et l'exploitant n'y voient pas les mêmes
 * files si leurs droits diffèrent.
 */
export default async function AujourdhuiPage() {
  const { member } = await requireAnyPermission(todayPermissions)
  const allowed = (permission: Parameters<typeof can>[1]) => can(member.role, permission)
  const tenant = await currentTenant()
  const timeZone = tenant.timezone
  const now = new Date()
  const today = todayIsoDate(timeZone, now)

  const [dayBookings, clients, pending, draftProposals, mailRequests, toFinish, toSign] = await Promise.all([
    allowed('reservations.gerer') ? listBookingsForDay(today, timeZone) : [],
    // Le nom de l'entreprise, comme sur le planning ; une demande du site n'a que celui du demandeur.
    allowed('reservations.gerer') || allowed('demandes.traiter') ? listClients() : [],
    allowed('demandes.traiter') ? listPendingBookings() : [],
    // Comptés comme dans le menu : un devis qui accompagne une demande en attente n'est compté qu'une fois (ADR 048).
    allowed('demandes.traiter') ? listProposals({ statuses: ['draft'] }) : [],
    allowed('courrier.gerer') ? countPendingMailRequests().then((counts) => counts.total) : 0,
    allowed('etats-des-lieux.gerer') ? listInspections({ stage: 'draft' }) : [],
    allowed('etats-des-lieux.gerer') ? listInspections({ stage: 'to_sign' }) : [],
  ])

  const tiles = todoTiles(
    {
      requests: pending.length + draftProposals.filter(awaitsReception).length,
      mailRequests,
      inspectionsToFinish: toFinish.length,
      inspectionsToSign: toSign.length,
    },
    allowed,
  )
  const timeline = dayTimeline(dayBookings, now)
  // Une réservation qui déborde sur la veille ou le lendemain dit aussi sa date.
  const hour = (instant: Date) => (toIsoDate(instant, timeZone) === today ? formatTime(instant, timeZone) : formatDateTime(instant, timeZone))
  const clientNames = new Map(clients.map((client) => [client.id, client.name]))
  const who = (booking: { clientId: string | null; requesterName: string | null }) =>
    (booking.clientId && clientNames.get(booking.clientId)) ?? booking.requesterName ?? null
  const nextPending = pending.toSorted((a, b) => a.startsAt.getTime() - b.startsAt.getTime()).slice(0, PENDING_SHOWN)

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-primary">Aujourd’hui</h1>
        <p className="mt-1 text-sm text-muted-foreground first-letter:uppercase">{formatLongDate(today, timeZone)}</p>
      </div>

      {tiles.length > 0 && (
        <section aria-labelledby="a-traiter">
          <h2 id="a-traiter" className="sr-only">À traiter</h2>
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {tiles.map((tile) => {
              const Icon = tile.count > 0 ? tileIcons[tile.key] : CheckIcon
              return (
                <li key={tile.key}>
                  <Link
                    href={tile.href}
                    className={`group flex h-full items-center gap-3 rounded-lg border p-4 transition-colors duration-150 ease-out focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
                      tile.count > 0 ? 'border-primary/30 bg-white hover:border-primary' : 'border-border bg-white/60 hover:bg-white'
                    }`}
                  >
                    <span
                      className={`flex size-10 shrink-0 items-center justify-center rounded-md ${
                        tile.count > 0 ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      <Icon size={20} />
                    </span>
                    <span className={`min-w-0 flex-1 text-sm ${tile.count > 0 ? 'font-medium text-primary' : 'text-muted-foreground'}`}>
                      {tile.label}
                    </span>
                    {tile.count > 0 && <ArrowRightIcon size={18} className="shrink-0 text-primary" />}
                  </Link>
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {allowed('reservations.gerer') && (
        <section aria-labelledby="journee" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 id="journee" className="text-lg font-semibold text-foreground">Planning du jour</h2>
            <Link href="/reservations" className={lien}>Ouvrir le planning <ArrowRightIcon size={16} /></Link>
          </div>
          {timeline.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border bg-white px-5 py-6 text-sm text-muted-foreground">
              Aucune réservation aujourd’hui. Une réservation se pose depuis le{' '}
              <Link href="/reservations" className="font-medium text-primary underline underline-offset-2">planning</Link>.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border bg-white">
              <table className="w-full text-sm">
                <thead className="border-b border-border text-left text-xs text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-4 py-2 font-medium">Horaire</th>
                    <th scope="col" className="px-4 py-2 font-medium">Espace</th>
                    <th scope="col" className="px-4 py-2 font-medium">Objet</th>
                    <th scope="col" className="px-4 py-2 font-medium">Client</th>
                    <th scope="col" className="px-4 py-2 font-medium">Statut</th>
                  </tr>
                </thead>
                <tbody>
                  {timeline.map((booking) => (
                    <tr
                      key={booking.id}
                      className={`border-b border-border last:border-0 ${
                        booking.moment === 'en_cours' ? 'bg-accent/10' : booking.moment === 'termine' ? 'text-muted-foreground' : ''
                      }`}
                    >
                      <td className="whitespace-nowrap px-4 py-2.5 tabular">
                        {hour(booking.startsAt)} – {hour(booking.endsAt)}
                        {booking.moment === 'en_cours' && <span className="ml-2 rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground">En cours</span>}
                        {booking.moment === 'termine' && <span className="ml-2 text-xs">Terminée</span>}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5">
                        <Link href={`/reservations/${booking.id}`} className="font-medium text-primary underline-offset-2 hover:underline">
                          {booking.resource.name}
                        </Link>
                      </td>
                      <td className="px-4 py-2.5">{booking.title}</td>
                      <td className="px-4 py-2.5">{who(booking) ?? <span className="text-muted-foreground">Sans client</span>}</td>
                      <td className="whitespace-nowrap px-4 py-2.5">
                        <span className="inline-flex items-center gap-1.5">
                          {booking.status === 'confirmed' ? <CheckIcon size={16} className="text-primary" /> : <ClockIcon size={16} className="text-primary" />}
                          {bookingStatusLabels[booking.status]}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {nextPending.length > 0 && (
        <section aria-labelledby="a-valider" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h2 id="a-valider" className="text-lg font-semibold text-foreground">Demandes à valider</h2>
            <Link href="/demandes" className={lien}>Toutes les demandes <ArrowRightIcon size={16} /></Link>
          </div>
          <ul className="divide-y divide-border rounded-lg border border-border bg-white">
            {nextPending.map((booking) => (
              <li key={booking.id}>
                <Link href="/demandes" className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-4 py-3 text-sm transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                  <span className="flex items-center gap-1.5 font-medium text-primary tabular">
                    <CalendarIcon size={16} />
                    {formatDateTime(booking.startsAt, timeZone)}
                  </span>
                  <span className="font-medium">{booking.resource.name}</span>
                  <span className="text-muted-foreground">{booking.title}{who(booking) ? ` · ${who(booking)}` : ''}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
