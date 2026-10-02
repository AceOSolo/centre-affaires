'use client'

import Link from 'next/link'
import { useActionState, useMemo, useState } from 'react'
import { addDaysToIsoDate, formatTime, toIsoDate } from '../../lib/dates.ts'
import { weekdayLabels, weekdays } from '../ressources/labels.ts'
import { createBookingSeriesAction } from './bulk-actions.ts'
import { expandRecurrence, MAX_BULK_BOOKINGS, MAX_WEEKLY_SLOTS, type WeeklySlot } from './recurrence.ts'

const field = 'mt-1 w-full rounded-sm border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/40'
const newSlot = (): WeeklySlot => ({ weekdays: [1], startTime: '09:00', endTime: '10:00' })

export function BulkBookingForm({ resources, today, timeZone, defaultKind, canManageResources }: {
  resources: { id: string; name: string; code: string }[]
  today: string
  timeZone: string
  defaultKind: 'booking' | 'unavailability'
  /** Droit `ressources.gerer`, qui ouvre la déclaration d'une ressource. */
  canManageResources: boolean
}) {
  const [state, action, pending] = useActionState(createBookingSeriesAction, null)
  const [kind, setKind] = useState(defaultKind)
  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const [startsOn, setStartsOn] = useState(today)
  const [endsOn, setEndsOn] = useState(addDaysToIsoDate(today, 28))
  const [resourceIds, setResourceIds] = useState<string[]>(resources[0] ? [resources[0].id] : [])
  const [slots, setSlots] = useState<WeeklySlot[]>([newSlot()])
  const preview = useMemo(() => {
    try {
      const occurrences = expandRecurrence({ startsOn, endsOn, slots }, timeZone)
      const count = occurrences.length * resourceIds.length
      if (!resourceIds.length) return { error: 'Choisissez au moins une ressource.' }
      if (count > MAX_BULK_BOOKINGS) return { error: `Le lot dépasse ${MAX_BULK_BOOKINGS} occurrences. Réduisez la période ou les ressources.` }
      return { occurrences, count }
    } catch (error) { return { error: error instanceof Error ? error.message : 'Vérifiez les plages.' } }
  }, [startsOn, endsOn, slots, timeZone, resourceIds])

  function updateSlot(index: number, changes: Partial<WeeklySlot>) {
    setSlots((current) => current.map((slot, at) => at === index ? { ...slot, ...changes } : slot))
  }

  // L'accueil n'a pas accès aux fiches ressources (ADR 019) : pas de lien vers « Accès réservé ».
  if (!resources.length) return <p>Aucune ressource en service. {canManageResources ? <><Link className="underline" href="/ressources/nouvelle">Ajouter une ressource</Link>.</> : 'Demandez à l’exploitant d’en déclarer une.'}</p>

  return (
    <form action={action} className="flex flex-col gap-6">
      <fieldset disabled={pending} className="flex flex-col gap-6 disabled:opacity-60">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-sm font-medium" htmlFor="bulk-kind">Type de lot
            <select id="bulk-kind" name="kind" value={kind} onChange={(event) => setKind(event.target.value as typeof kind)} className={field}>
              <option value="booking">Réservations</option>
              <option value="unavailability">Indisponibilités</option>
            </select>
          </label>
          <label className="text-sm font-medium" htmlFor="bulk-title">{kind === 'booking' ? 'Objet des réservations' : 'Motif d’indisponibilité'}
            <input id="bulk-title" name="title" required maxLength={200} value={title} onChange={(event) => setTitle(event.target.value)} placeholder={kind === 'booking' ? 'Réunion hebdomadaire' : 'Entretien, occupation régulière…'} className={field} />
          </label>
        </div>
        <fieldset className="rounded-lg border border-border bg-white p-4">
          <legend className="px-1 text-sm font-medium">Ressources concernées</legend>
          <div className="mb-3 flex gap-4 text-xs">
            <button type="button" className="text-primary underline" onClick={() => setResourceIds(resources.map((resource) => resource.id))}>Tout sélectionner</button>
            <button type="button" className="text-primary underline" onClick={() => setResourceIds([])}>Tout désélectionner</button>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {resources.map((resource) => <label key={resource.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="resourceIds" value={resource.id} checked={resourceIds.includes(resource.id)} onChange={(event) => setResourceIds((current) => event.target.checked ? [...current, resource.id] : current.filter((id) => id !== resource.id))} />
              {resource.code} — {resource.name}
            </label>)}
          </div>
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-sm font-medium" htmlFor="bulk-start">Du (inclus)
            <input id="bulk-start" name="startsOn" type="date" required value={startsOn} onChange={(event) => setStartsOn(event.target.value)} className={field} />
          </label>
          <label className="text-sm font-medium" htmlFor="bulk-end">Au (inclus)
            <input id="bulk-end" name="endsOn" type="date" required min={startsOn} value={endsOn} onChange={(event) => setEndsOn(event.target.value)} className={field} />
          </label>
        </div>
        <section className="flex flex-col gap-3" aria-labelledby="bulk-slots">
          <h2 id="bulk-slots" className="text-sm font-semibold">Plages répétées chaque semaine</h2>
          <p className="text-xs text-muted-foreground">Ajoutez plusieurs plages pour des horaires différents selon les jours. Pour une seule journée, utilisez la même date de début et de fin.</p>
          <input type="hidden" name="slots" value={JSON.stringify(slots)} />
          {slots.map((slot, index) => <fieldset key={index} className="rounded-lg border border-border bg-white p-4">
            <legend className="px-1 text-sm font-medium">Plage {index + 1}</legend>
            <div className="mb-4 flex flex-wrap gap-3">
              {weekdays.map((day) => <label key={day} className="flex items-center gap-1.5 text-sm">
                <input type="checkbox" checked={slot.weekdays.includes(day)} onChange={(event) => updateSlot(index, { weekdays: event.target.checked ? [...slot.weekdays, day] : slot.weekdays.filter((value) => value !== day) })} />
                {weekdayLabels[day]}
              </label>)}
            </div>
            <div className="flex flex-wrap items-end gap-4">
              <label className="text-sm" htmlFor={`slot-start-${index}`}>Début
                <input id={`slot-start-${index}`} type="time" required step={60} value={slot.startTime} onChange={(event) => updateSlot(index, { startTime: event.target.value })} className={field} />
              </label>
              <label className="text-sm" htmlFor={`slot-end-${index}`}>Fin
                <input id={`slot-end-${index}`} type="time" required step={60} value={slot.endTime} onChange={(event) => updateSlot(index, { endTime: event.target.value })} className={field} />
              </label>
              {slots.length > 1 && <button type="button" aria-label={`Retirer la plage ${index + 1}`} onClick={() => setSlots((current) => current.filter((_, at) => at !== index))} className="py-2 text-sm text-destructive hover:underline">Retirer</button>}
            </div>
          </fieldset>)}
          <button type="button" disabled={slots.length >= MAX_WEEKLY_SLOTS} onClick={() => setSlots((current) => [...current, newSlot()])} className="self-start rounded-md border border-border px-4 py-2 text-sm hover:bg-white disabled:opacity-50">Ajouter une plage</button>
        </section>
        <label className="text-sm font-medium" htmlFor="bulk-notes">Notes (facultatif)
          <textarea id="bulk-notes" name="notes" rows={2} maxLength={5000} value={notes} onChange={(event) => setNotes(event.target.value)} className={field} />
        </label>
        <div aria-live="polite" className="rounded-lg border border-border bg-white p-4 text-sm">
          {preview.error ? <p>{preview.error}</p> : <>
            <p className="font-medium">{preview.count} {kind === 'booking' ? 'réservations' : 'indisponibilités'} sur {resourceIds.length} ressource(s)</p>
            <p className="mt-1 text-xs text-muted-foreground">Heures du centre ({timeZone}). Les conflits seront vérifiés à l’enregistrement. Un conflit annule tout le lot.</p>
            <details className="mt-3">
              <summary className="cursor-pointer text-primary">Voir les {preview.occurrences?.length} créneaux par ressource</summary>
              <ul className="mt-2 max-h-56 overflow-y-auto space-y-1">
                {preview.occurrences?.map((range) => <li key={range.startsAt.toISOString()}>{toIsoDate(range.startsAt, timeZone)} · {formatTime(range.startsAt, timeZone)} – {formatTime(range.endsAt, timeZone)}</li>)}
              </ul>
            </details>
          </>}
        </div>
        {state?.error && <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">{state.error}</p>}
        <div className="flex items-center gap-4">
          <button disabled={pending || Boolean(preview.error)} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50">{pending ? 'Création du lot…' : kind === 'booking' ? 'Créer les réservations' : 'Bloquer les créneaux'}</button>
          <Link href="/reservations" className="text-sm text-muted-foreground hover:underline">Annuler</Link>
        </div>
      </fieldset>
    </form>
  )
}
