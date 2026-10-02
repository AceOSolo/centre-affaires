import { addDaysToIsoDate, toWallClock, wallClockToUtc } from '../../lib/dates.ts'
import { isoWeekday } from '../ressources/ouverture.ts'
import { overlaps, type TimeRange } from './availability.ts'

export const MAX_BULK_BOOKINGS = 500
export const MAX_WEEKLY_SLOTS = 20
export type WeeklySlot = { weekdays: number[]; startTime: string; endTime: string }
export type RecurrenceInput = { startsOn: string; endsOn: string; slots: WeeklySlot[] }

export class RecurrenceError extends Error {}

export function validIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T12:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

/** Chaque occurrence est convertie séparément : 9 h reste 9 h au changement d’heure. */
export function expandRecurrence(input: RecurrenceInput, timeZone: string): TimeRange[] {
  if (!validIsoDate(input.startsOn) || !validIsoDate(input.endsOn) || input.endsOn < input.startsOn) {
    throw new RecurrenceError('Indiquez une période valide, avec une fin après le début.')
  }
  if (input.endsOn > addDaysToIsoDate(input.startsOn, 365)) {
    throw new RecurrenceError('La période ne peut pas dépasser un an.')
  }
  if (!Array.isArray(input.slots) || input.slots.length === 0 || input.slots.length > MAX_WEEKLY_SLOTS) {
    throw new RecurrenceError(`Ajoutez entre 1 et ${MAX_WEEKLY_SLOTS} plages hebdomadaires.`)
  }
  const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/
  for (const slot of input.slots) {
    if (!slot || !Array.isArray(slot.weekdays) || slot.weekdays.length === 0 ||
      slot.weekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7) ||
      !timePattern.test(slot.startTime) || !timePattern.test(slot.endTime) || slot.endTime <= slot.startTime) {
      throw new RecurrenceError('Chaque plage doit avoir au moins un jour et une heure de fin après le début.')
    }
  }
  const occurrences: TimeRange[] = []
  for (let date = input.startsOn; date <= input.endsOn; date = addDaysToIsoDate(date, 1)) {
    for (const slot of input.slots) {
      if (!slot.weekdays.includes(isoWeekday(date))) continue
      const startsAt = wallClockToUtc(`${date}T${slot.startTime}`, timeZone)
      const endsAt = wallClockToUtc(`${date}T${slot.endTime}`, timeZone)
      if (toWallClock(startsAt, timeZone) !== `${date}T${slot.startTime}` ||
        toWallClock(endsAt, timeZone) !== `${date}T${slot.endTime}` || endsAt <= startsAt) {
        throw new RecurrenceError(`Horaire inexistant le ${date} à cause du changement d’heure.`)
      }
      occurrences.push({ startsAt, endsAt })
      if (occurrences.length > MAX_BULK_BOOKINGS) {
        throw new RecurrenceError(`Un lot est limité à ${MAX_BULK_BOOKINGS} réservations. Réduisez la période.`)
      }
    }
  }
  if (occurrences.length === 0) throw new RecurrenceError('Aucun des jours choisis ne tombe dans cette période.')
  occurrences.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
  for (let i = 1; i < occurrences.length; i++) {
    if (overlaps(occurrences[i - 1], occurrences[i])) {
      throw new RecurrenceError('Les plages saisies se chevauchent. Corrigez-les avant de créer le lot.')
    }
  }
  return occurrences
}
