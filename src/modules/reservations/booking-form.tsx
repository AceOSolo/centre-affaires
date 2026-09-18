'use client'

import { useActionState, useState } from 'react'

import Link from 'next/link'

import { resourceTypeLabels } from '../ressources/labels.ts'
import type { Resource } from '../ressources/schema.ts'
import { createBookingAction, type FormState } from './actions.ts'

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
 * Saisie d'une réservation.
 *
 * Les heures sont saisies en heure murale du centre ; la conversion en instants
 * UTC a lieu dans l'action serveur (décision 4). Le conflit de créneau n'est pas
 * anticipé ici : c'est la contrainte d'exclusion qui tranche, et l'action renvoie
 * le nom de la réservation qui occupe déjà la place (décision 3).
 */
export function BookingForm({
  resources,
  defaultDate,
  defaultResourceId,
  defaultStartTime,
}: {
  resources: Resource[]
  defaultDate: string
  defaultResourceId?: string
  defaultStartTime?: string
}) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    createBookingAction,
    null,
  )
  const [startTime, setStartTime] = useState(defaultStartTime ?? '09:00')
  const [endTime, setEndTime] = useState(addMinutes(defaultStartTime ?? '09:00', 60))

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
    <form action={formAction} className="flex max-w-2xl flex-col gap-5">
      {state?.error && (
        <p
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
        >
          {state.error}
        </p>
      )}

      <div>
        <label className={labelClass} htmlFor="resourceId">
          Ressource
        </label>
        <select
          id="resourceId"
          name="resourceId"
          required
          defaultValue={defaultResourceId ?? resources[0].id}
          className={`${fieldClass} mt-1`}
        >
          {resources.map((resource) => (
            <option key={resource.id} value={resource.id}>
              {resource.code} — {resource.name} ({resourceTypeLabels[resource.resourceType]})
            </option>
          ))}
        </select>
      </div>

      <div className="grid gap-5 sm:grid-cols-3">
        <div>
          <label className={labelClass} htmlFor="date">
            Jour
          </label>
          <input
            id="date"
            name="date"
            type="date"
            required
            defaultValue={defaultDate}
            className={`${fieldClass} mt-1`}
          />
        </div>
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
            className={`${fieldClass} mt-1 tabular-nums`}
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
            className={`${fieldClass} mt-1 tabular-nums`}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Fin exclue : une réservation qui finit à 10h00 laisse le créneau de
            10h00 libre.
          </p>
        </div>
      </div>

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
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50"
        >
          {pending ? 'Enregistrement…' : 'Réserver'}
        </button>
        <Link
          href={`/reservations?date=${defaultDate}`}
          className="text-sm text-muted-foreground hover:underline"
        >
          Annuler
        </Link>
      </div>
    </form>
  )
}
