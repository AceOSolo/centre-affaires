'use client'

import { useActionState, useMemo, useState } from 'react'

import { CheckIcon, ClockIcon } from '../../components/ui/icons.tsx'
import { formatLongDate, formatTime, toIsoDate, wallClockToUtc } from '../../lib/dates.ts'
import { resourceTypeLabels } from '../ressources/labels.ts'
import type { Resource } from '../ressources/schema.ts'
import type { TimeRange } from './availability.ts'
import { requestBookingAction, type PublicFormState } from './public-actions.ts'
import { rangeMinutes } from './selection.ts'
import { formatMinutes } from '../../lib/dates.ts'
import { WeekCalendar, type CalendarDay } from './week-calendar.tsx'

const fieldClass =
  'w-full rounded-sm border border-border bg-background px-3 py-2.5 text-base outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-primary/30'
const labelClass = 'block text-sm font-medium text-foreground'

/** Ajoute des minutes à une heure murale « 09:00 », sans quitter la journée. */
function addMinutes(time: string, minutes: number): string {
  const [hour, minute] = time.split(':').map(Number)
  const total = Math.min(hour * 60 + minute + minutes, 23 * 60 + 59)
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

/**
 * Formulaire public de demande de créneau.
 *
 * Le calendrier et les trois champs de date et d'heure décrivent le même
 * créneau : les champs restent la seule vérité, le calendrier les écrit et les
 * relit. Une sélection faite à la souris se corrige donc au clavier dans les
 * champs, et l'inverse se voit aussitôt dans la grille.
 *
 * Rien n'est vérifié ici : la recevabilité est décidée côté serveur par
 * `rejectRequest` et la disponibilité par la contrainte d'exclusion. La grille
 * ne fait qu'éviter de demander un créneau déjà pris.
 */
export function PublicBookingForm({
  resource,
  days,
  timeZone,
  today,
  defaultDate,
  minDate,
  maxDate,
  defaultStartTime,
  defaultEndTime,
}: {
  /** L'espace est choisi au-dessus de la grille : ici il est acquis. */
  resource: Resource
  days: CalendarDay[]
  timeZone: string
  today: string
  defaultDate: string
  minDate: string
  maxDate: string
  defaultStartTime?: string
  defaultEndTime?: string
}) {
  const [state, formAction, pending] = useActionState<PublicFormState, FormData>(
    requestBookingAction,
    { status: 'idle' },
  )
  const [date, setDate] = useState(defaultDate)
  const [startTime, setStartTime] = useState(defaultStartTime ?? '09:00')
  const [endTime, setEndTime] = useState(
    defaultEndTime ?? addMinutes(defaultStartTime ?? '09:00', 60),
  )

  // La sélection affichée dans la grille est déduite des champs, jamais tenue à
  // part : deux états parallèles finiraient par se contredire.
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

  if (state.status === 'sent') {
    return (
      <div className="rounded-lg border border-border bg-muted p-6 sm:p-8">
        <div className="flex size-11 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <CheckIcon size={24} />
        </div>
        <h3 className="mt-4 text-xl font-semibold text-primary">Demande envoyée</h3>
        <p className="mt-2 text-muted-foreground">Nous avons bien reçu votre demande pour&nbsp;:</p>
        <p className="mt-1 font-medium">{state.summary}</p>
        <p className="mt-4 text-sm text-muted-foreground">
          Le créneau est réservé provisoirement à votre nom. Notre équipe le confirme par
          téléphone ou par courriel, en général sous un jour ouvré.
        </p>
      </div>
    )
  }

  return (
    <form action={formAction} className="flex flex-col gap-6">
      {state.status === 'error' && (
        <p
          role="alert"
          className="rounded-sm border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
        >
          {state.message}
        </p>
      )}

      {/* L'espace est fixé par la grille affichée : le renvoyer en clair ici
          éviterait que le formulaire et le calendrier parlent de deux salles. */}
      <input type="hidden" name="resourceId" value={resource.id} />

      <div className="flex flex-col gap-3">
        <WeekCalendar
          days={days}
          timeZone={timeZone}
          today={today}
          selection={selection}
          onSelect={onSelect}
          label={`Disponibilités de ${resource.name}`}
        />
        <SelectionSummary selection={selection} timeZone={timeZone} resource={resource} />
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label className={labelClass} htmlFor="date">
            Jour
          </label>
          <input
            id="date"
            name="date"
            type="date"
            required
            min={minDate}
            max={maxDate}
            value={date}
            onChange={(event) => setDate(event.target.value)}
            className={`${fieldClass} mt-1.5`}
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={labelClass} htmlFor="startTime">
              De
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
              className={`${fieldClass} mt-1.5 tabular`}
            />
          </div>
          <div>
            <label className={labelClass} htmlFor="endTime">
              À
            </label>
            <input
              id="endTime"
              name="endTime"
              type="time"
              required
              step={900}
              value={endTime}
              onChange={(event) => setEndTime(event.target.value)}
              className={`${fieldClass} mt-1.5 tabular`}
            />
          </div>
        </div>

        <div className="sm:col-span-2">
          <label className={labelClass} htmlFor="title">
            Objet de la réunion
          </label>
          <input
            id="title"
            name="title"
            required
            maxLength={200}
            placeholder="Réunion d'équipe, entretien, formation…"
            className={`${fieldClass} mt-1.5`}
          />
        </div>

        <div>
          <label className={labelClass} htmlFor="name">
            Nom et prénom
          </label>
          <input
            id="name"
            name="name"
            required
            autoComplete="name"
            className={`${fieldClass} mt-1.5`}
          />
        </div>

        <div>
          <label className={labelClass} htmlFor="phone">
            Téléphone
          </label>
          <input
            id="phone"
            name="phone"
            type="tel"
            required
            autoComplete="tel"
            className={`${fieldClass} mt-1.5`}
          />
        </div>

        <div className="sm:col-span-2">
          <label className={labelClass} htmlFor="email">
            Adresse électronique
          </label>
          <input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="email"
            className={`${fieldClass} mt-1.5`}
          />
        </div>

        <div className="sm:col-span-2">
          <label className={labelClass} htmlFor="notes">
            Précisions <span className="font-normal text-muted-foreground">(facultatif)</span>
          </label>
          <textarea id="notes" name="notes" rows={3} className={`${fieldClass} mt-1.5`} />
        </div>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-primary px-5 py-3 font-medium text-primary-foreground transition-colors hover:bg-primary-hover disabled:opacity-60"
        >
          {pending ? 'Envoi…' : 'Envoyer la demande'}
        </button>
        <p className="text-sm text-muted-foreground">
          Sans engagement. Le créneau est bloqué le temps que nous vous répondions.
        </p>
      </div>
    </form>
  )
}

/**
 * Rappel de ce qui est demandé, en toutes lettres.
 *
 * La grille surligne les cases choisies, mais un surlignage ne se lit pas au
 * lecteur d'écran et ne dit pas la durée. `aria-live` annonce le changement à
 * chaque clic sans déplacer le focus.
 */
function SelectionSummary({
  selection,
  timeZone,
  resource,
}: {
  selection: TimeRange | undefined
  timeZone: string
  resource: Resource
}) {
  return (
    <p
      aria-live="polite"
      className="flex flex-wrap items-center gap-2 rounded-sm bg-muted px-4 py-3 text-sm"
    >
      <ClockIcon size={20} className="text-primary" />
      {selection ? (
        <span>
          <span className="font-medium text-primary">{resource.name}</span>
          {' — '}
          <span className="capitalize">
            {formatLongDate(toIsoDate(selection.startsAt, timeZone), timeZone)}
          </span>{' '}
          de <span className="tabular">{formatTime(selection.startsAt, timeZone)}</span> à{' '}
          <span className="tabular">{formatTime(selection.endsAt, timeZone)}</span>
          {' · '}
          {formatMinutes(rangeMinutes(selection))}
        </span>
      ) : (
        <span className="text-muted-foreground">
          Cliquez l’heure de début puis l’heure de fin dans le calendrier, ou saisissez-les
          ci-dessous. {resourceTypeLabels[resource.resourceType]} : {resource.name}.
        </span>
      )}
    </p>
  )
}
