'use client'

import { useActionState, useState } from 'react'

import { CheckIcon } from '../../components/ui/icons.tsx'
import { resourceTypeLabels } from '../ressources/labels.ts'
import type { Resource } from '../ressources/schema.ts'
import { requestBookingAction, type PublicFormState } from './public-actions.ts'

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
 * Il ne vérifie rien de métier : la recevabilité est décidée côté serveur par
 * `rejectRequest`, et la disponibilité par la contrainte d'exclusion. Ce qui est
 * fait ici — la fin qui suit le début — n'est qu'un confort de saisie.
 */
export function PublicBookingForm({
  resources,
  defaultDate,
  minDate,
  maxDate,
}: {
  resources: Resource[]
  defaultDate: string
  minDate: string
  maxDate: string
}) {
  const [state, formAction, pending] = useActionState<PublicFormState, FormData>(
    requestBookingAction,
    { status: 'idle' },
  )
  const [startTime, setStartTime] = useState('09:00')
  const [endTime, setEndTime] = useState('10:00')

  if (state.status === 'sent') {
    return (
      <div className="rounded-lg border border-border bg-muted p-6 sm:p-8">
        <div className="flex size-11 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <CheckIcon size={24} />
        </div>
        <h3 className="mt-4 text-xl font-semibold text-secondary">Demande envoyée</h3>
        <p className="mt-2 text-muted-foreground">
          Nous avons bien reçu votre demande pour&nbsp;:
        </p>
        <p className="mt-1 font-medium">{state.summary}</p>
        <p className="mt-4 text-sm text-muted-foreground">
          Le créneau est réservé provisoirement à votre nom. Notre équipe le confirme par
          téléphone ou par courriel, en général sous un jour ouvré.
        </p>
      </div>
    )
  }

  return (
    <form action={formAction} className="flex flex-col gap-5">
      {state.status === 'error' && (
        <p
          role="alert"
          className="rounded-sm border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
        >
          {state.message}
        </p>
      )}

      <div className="grid gap-5 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className={labelClass} htmlFor="resourceId">
            Espace souhaité
          </label>
          <select
            id="resourceId"
            name="resourceId"
            required
            defaultValue={resources[0]?.id ?? ''}
            className={`${fieldClass} mt-1.5`}
          >
            {resources.map((resource) => (
              <option key={resource.id} value={resource.id}>
                {resource.name} — {resourceTypeLabels[resource.resourceType]}
                {resource.capacity ? ` (${resource.capacity} pers.)` : ''}
              </option>
            ))}
          </select>
        </div>

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
            defaultValue={defaultDate}
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
            Précisions{' '}
            <span className="font-normal text-muted-foreground">(facultatif)</span>
          </label>
          <textarea id="notes" name="notes" rows={3} className={`${fieldClass} mt-1.5`} />
        </div>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <button
          type="submit"
          disabled={pending || resources.length === 0}
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
