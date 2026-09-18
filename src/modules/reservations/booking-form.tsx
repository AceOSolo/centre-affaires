'use client'

import { useActionState, useMemo, useState } from 'react'

import Link from 'next/link'

import { CheckIcon, ClockIcon } from '../../components/ui/icons.tsx'
import { formatMinutes, formatTime, toIsoDate, wallClockToUtc } from '../../lib/dates.ts'
import type { Resource } from '../ressources/schema.ts'
import { createBookingAction, type FormState } from './actions.ts'
import { overlaps, type TimeRange } from './availability.ts'
import { isSelectable, rangeMinutes } from './selection.ts'
import { WeekCalendar, type CalendarDay } from './week-calendar.tsx'

const fieldClass =
  'w-full rounded-sm border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/40'
const labelClass = 'block text-sm font-medium text-foreground'

/** Ajoute des minutes à une heure murale « 09:00 », sans quitter la journée. */
function addMinutes(time: string, minutes: number): string {
  const [hour, minute] = time.split(':').map(Number)
  const total = Math.min(hour * 60 + minute + minutes, 23 * 60 + 59)
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

/** Ce qu'il faut d'une réservation existante pour nommer un conflit. */
export type BusyBooking = TimeRange & { id: string; title: string }

/**
 * Saisie d'une réservation.
 *
 * Les heures sont saisies en heure murale du centre ; la conversion en instants
 * UTC a lieu dans l'action serveur (décision 4).
 *
 * Le créneau se prend au calendrier ou au clavier, indifféremment : les trois
 * champs restent la seule vérité, la grille les écrit et les relit.
 *
 * La disponibilité est annoncée avant l'envoi, à partir des réservations déjà
 * posées — mais elle n'est pas l'autorité : c'est la contrainte d'exclusion qui
 * tranche, et l'action renvoie le nom de la réservation qui occupe la place
 * (décision 3). Un créneau hors ouverture reste saisissable : le staff doit
 * pouvoir ouvrir exceptionnellement une salle un jour férié.
 */
export function BookingForm({
  resource,
  resources,
  days,
  busy,
  timeZone,
  today,
  defaultDate,
  defaultStartTime,
}: {
  /** Ressource affichée par le calendrier ; le choix se fait au-dessus. */
  resource: Resource
  resources: Resource[]
  days: CalendarDay[]
  /** Réservations de cette ressource, pour nommer le créneau qui bloque. */
  busy: BusyBooking[]
  timeZone: string
  today: string
  defaultDate: string
  defaultStartTime?: string
}) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(createBookingAction, null)
  const [date, setDate] = useState(defaultDate)
  const [startTime, setStartTime] = useState(defaultStartTime ?? '09:00')
  const [endTime, setEndTime] = useState(addMinutes(defaultStartTime ?? '09:00', 60))

  const selection = useMemo<TimeRange | undefined>(() => {
    if (!date || !startTime || !endTime || endTime <= startTime) return undefined
    return {
      startsAt: wallClockToUtc(`${date}T${startTime}`, timeZone),
      endsAt: wallClockToUtc(`${date}T${endTime}`, timeZone),
    }
  }, [date, startTime, endTime, timeZone])

  function onSelect(range: TimeRange | undefined) {
    if (!range) return
    setDate(toIsoDate(range.startsAt, timeZone))
    setStartTime(formatTime(range.startsAt, timeZone))
    setEndTime(formatTime(range.endsAt, timeZone))
  }

  if (resources.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border bg-white px-6 py-12 text-center text-sm text-muted-foreground">
        Aucune ressource en service.{' '}
        <Link href="/ressources/nouvelle" className="underline underline-offset-2">
          Déclarer une ressource
        </Link>{' '}
        avant de réserver.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
      <div className="min-w-0 flex-1">
        <WeekCalendar
          days={days}
          timeZone={timeZone}
          today={today}
          selection={selection}
          onSelect={onSelect}
          label={`Planning de ${resource.name}`}
        />
      </div>

      <form action={formAction} className="flex w-full flex-col gap-5 lg:max-w-sm">
        {state?.error && (
          <p
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
          >
            {state.error}
          </p>
        )}

        <input type="hidden" name="resourceId" value={resource.id} />

        <AvailabilityVerdict selection={selection} days={days} busy={busy} timeZone={timeZone} />

        <div>
          <label className={labelClass} htmlFor="date">
            Jour
          </label>
          <input
            id="date"
            name="date"
            type="date"
            required
            value={date}
            onChange={(event) => setDate(event.target.value)}
            className={`${fieldClass} mt-1`}
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass} htmlFor="startTime">
              Début
            </label>
            <input
              id="startTime"
              name="startTime"
              type="time"
              required
              step={900}
              value={startTime}
              onChange={(event) => {
                const value = event.target.value
                setStartTime(value)
                // La fin suit le début tant qu'elle lui est antérieure : la base
                // refuserait un intervalle vide, autant ne pas le proposer.
                if (value && value >= endTime) setEndTime(addMinutes(value, 60))
              }}
              className={`${fieldClass} mt-1 tabular`}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="endTime">
              Fin
            </label>
            <input
              id="endTime"
              name="endTime"
              type="time"
              required
              step={900}
              value={endTime}
              onChange={(event) => setEndTime(event.target.value)}
              className={`${fieldClass} mt-1 tabular`}
            />
          </div>
        </div>
        <p className="-mt-2 text-xs text-muted-foreground">
          Fin exclue : une réservation qui finit à 10h00 laisse le créneau de 10h00 libre.
        </p>

        <div>
          <label className={labelClass} htmlFor="title">
            Objet
          </label>
          <input
            id="title"
            name="title"
            required
            maxLength={200}
            placeholder="Comité de direction"
            className={`${fieldClass} mt-1`}
          />
        </div>

        <div>
          <label className={labelClass} htmlFor="notes">
            Notes <span className="font-normal text-muted-foreground">(facultatif)</span>
          </label>
          <textarea id="notes" name="notes" rows={3} className={`${fieldClass} mt-1`} />
        </div>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={pending}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-hover disabled:opacity-50"
          >
            {pending ? 'Enregistrement…' : 'Réserver'}
          </button>
          <Link
            href={`/reservations?date=${date}`}
            className="text-sm text-muted-foreground hover:underline"
          >
            Annuler
          </Link>
        </div>
      </form>
    </div>
  )
}

/**
 * Verdict de disponibilité du créneau saisi.
 *
 * Trois cas distincts, et non deux : libre, occupé, ou hors ouverture. Les
 * confondre ferait passer un jour férié pour un conflit, alors que le staff a
 * le droit d'y poser une réservation.
 *
 * Le libellé porte l'information ; la couleur ne fait que la redoubler.
 */
export function AvailabilityVerdict({
  selection,
  days,
  busy,
  timeZone,
}: {
  selection: TimeRange | undefined
  days: CalendarDay[]
  busy: BusyBooking[]
  timeZone: string
}) {
  const box = 'flex items-start gap-2 rounded-md px-3 py-2.5 text-sm'

  if (!selection) {
    return (
      <p aria-live="polite" className={`${box} bg-muted text-muted-foreground`}>
        <ClockIcon size={20} />
        Renseignez un début et une fin, ou choisissez le créneau dans le planning.
      </p>
    )
  }

  const conflicts = busy.filter((booking) => overlaps(selection, booking))
  const cells = days.find((day) => day.isoDate === toIsoDate(selection.startsAt, timeZone))?.cells

  const duree = formatMinutes(rangeMinutes(selection))

  if (conflicts.length > 0) {
    return (
      <p aria-live="polite" className={`${box} bg-statut-conflit/10 text-statut-conflit`}>
        <ClockIcon size={20} />
        <span>
          <strong className="font-medium">Créneau occupé</strong> par{' '}
          {conflicts
            .map(
              (booking) =>
                `« ${booking.title} » de ${formatTime(booking.startsAt, timeZone)} à ${formatTime(
                  booking.endsAt,
                  timeZone,
                )}`,
            )
            .join(', ')}
          .
        </span>
      </p>
    )
  }

  if (cells && !isSelectable(selection, cells)) {
    return (
      <p aria-live="polite" className={`${box} bg-accent/10 text-foreground`}>
        <ClockIcon size={20} />
        <span>
          <strong className="font-medium">Hors des heures d’ouverture</strong> — libre, mais en
          dehors du planning habituel. {duree}.
        </span>
      </p>
    )
  }

  return (
    <p aria-live="polite" className={`${box} bg-primary/10 text-foreground`}>
      <CheckIcon size={20} />
      <span>
        <strong className="font-medium">Créneau libre</strong> · {duree}.
      </span>
    </p>
  )
}
