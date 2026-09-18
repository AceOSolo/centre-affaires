'use client'

import { useActionState, useMemo, useState } from 'react'

import Link from 'next/link'

import { formatTime, toIsoDate, wallClockToUtc } from '../../lib/dates.ts'
import type { Resource } from '../ressources/schema.ts'
import { moveBookingAction, type FormState } from './actions.ts'
import type { TimeRange } from './availability.ts'
import { AvailabilityVerdict, type BusyBooking } from './booking-form.tsx'
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

/**
 * Déplacement d'une réservation.
 *
 * Même grille et même verdict que la création : c'est la même question posée
 * au même moment. Deux différences, et elles comptent.
 *
 * La réservation déplacée est retirée des cases occupées — sinon elle
 * s'opposerait à elle-même et son créneau actuel serait le seul inatteignable.
 * Sa place d'origine est rappelée en clair, parce qu'une grille où plus rien
 * n'est surligné ne dit pas d'où l'on part.
 *
 * L'objet et les notes ne sont pas ici : déplacer une réunion et la renommer
 * sont deux intentions différentes.
 */
export function MoveForm({
  bookingId,
  resource,
  days,
  busy,
  timeZone,
  today,
  origin,
  defaultDate,
  defaultStartTime,
  defaultEndTime,
}: {
  bookingId: string
  /** Ressource affichée par le calendrier ; le choix se fait au-dessus. */
  resource: Resource
  days: CalendarDay[]
  /** Réservations de cette ressource, celle qu'on déplace exclue. */
  busy: BusyBooking[]
  timeZone: string
  today: string
  /** Place actuelle, pour la rappeler et pour savoir si l'on a bougé. */
  origin: { resourceId: string; resourceName: string; label: string }
  defaultDate: string
  defaultStartTime: string
  defaultEndTime: string
}) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(moveBookingAction, null)
  const [date, setDate] = useState(defaultDate)
  const [startTime, setStartTime] = useState(defaultStartTime)
  const [endTime, setEndTime] = useState(defaultEndTime)

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

  // Rien n'a bougé : le bouton reste inerte plutôt que de réécrire la même
  // ligne et de faire croire à un déplacement.
  const unchanged =
    resource.id === origin.resourceId &&
    date === defaultDate &&
    startTime === defaultStartTime &&
    endTime === defaultEndTime

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

        <input type="hidden" name="id" value={bookingId} />
        <input type="hidden" name="resourceId" value={resource.id} />

        <p className="rounded-md border border-border bg-muted px-3 py-2.5 text-sm text-muted-foreground">
          Place actuelle : <span className="font-medium text-foreground">{origin.resourceName}</span>
          , <span className="tabular">{origin.label}</span>.
        </p>

        <AvailabilityVerdict
          selection={selection}
          days={days}
          busy={busy}
          timeZone={timeZone}
        />

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

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={pending || unchanged}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-hover disabled:opacity-50"
          >
            {pending ? 'Déplacement…' : 'Déplacer'}
          </button>
          <Link
            href={`/reservations/${bookingId}`}
            className="text-sm text-muted-foreground hover:underline"
          >
            Annuler
          </Link>
        </div>
        {unchanged && (
          <p className="-mt-2 text-xs text-muted-foreground">
            Choisissez un autre créneau ou une autre ressource pour déplacer la réservation.
          </p>
        )}
      </form>
    </div>
  )
}
