'use client'

import type { ReactNode } from 'react'

import { CheckIcon, ClockIcon } from '../../components/ui/icons.tsx'
import { addDaysToIsoDate, formatTime, toIsoDate } from '../../lib/dates.ts'
import { rentalFormulaDescriptions, rentalFormulaLabels, type RentalFormula } from '../ressources/formules.ts'
import type { TimeRange } from './availability.ts'
import { formatDays } from './durees.ts'
import {
  choiceRejectionMessage,
  dayDeparture,
  emptyChoice,
  endDayIssue,
  endDayIssueMessage,
  lastDayOfLongFormula,
  openingGroups,
  type ChosenFormula,
  type EvaluatedChoice,
  type FormulaLimits,
  type PeriodChoice,
} from './formules-periode.ts'
import { periodDuration, periodEnds, periodRejection, type PeriodAvailability } from './periode.ts'
import { publicSelection } from './public-selection.ts'

/**
 * Jours, heures et formule d'une demande de réservation (ADR 076), communs à
 * la page publique, à l'espace client et à la modification d'une réservation
 * par son client. Le calcul est celui de `formules-periode.ts`, que les
 * actions serveur refont ; ce composant ne fait que le montrer.
 *
 * - Le **jour du départ** se choisit librement dans un calendrier, dans la
 *   limite de la durée maximale du produit ; un jour qui ne propose pas
 *   d'heure dit pourquoi (fermé, réservé avant, trop loin).
 * - Les **heures d'ouverture et de fermeture** des jours choisis remplacent
 *   les « nuits comprises » : ce sont celles de « Horaires et fermetures ».
 *
 * Les contrôles n'ont pas de `name` : le formulaire parent pose les champs
 * envoyés (`choiceFormValues`), présents à toutes ses étapes.
 */

export type PeriodFieldErrors = Partial<Record<'formula' | 'startTime' | 'endDate' | 'endTime' | 'count', string>>

/** Astérisque des champs obligatoires. À remplacer par le composant commun du lot 1 à la fusion. */
function Requis() {
  return (
    <span aria-hidden="true" className="ml-0.5 font-normal text-primary">
      *
    </span>
  )
}

/** « mer. 4 nov. » : un jour, lu sans fuseau — midi UTC ne change jamais de date. */
export function shortDay(isoDate: string): string {
  return new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(
    new Date(`${isoDate}T12:00:00Z`),
  )
}

/** « mar. 17 nov. à 14:00 » */
function shortInstant(instant: Date, timeZone: string): string {
  return `${shortDay(toIsoDate(instant, timeZone))} à ${formatTime(instant, timeZone)}`
}

/**
 * Valeurs envoyées par le formulaire : la formule et ce qu'elle a choisi. Pour
 * une journée, une semaine ou un mois, les heures sont celles de la période
 * calculée ; le serveur les recalcule de toute façon.
 */
export function choiceFormValues(
  choice: PeriodChoice,
  evaluation: EvaluatedChoice | undefined,
  date: string,
  timeZone: string,
): Record<'formula' | 'startTime' | 'endDate' | 'endTime' | 'count', string> {
  const range = evaluation?.range
  const typed = choice.formula === 'libre' || choice.formula === 'heure' || choice.formula === 'demi_journee'
  return {
    formula: choice.formula,
    startTime: typed ? choice.startTime : range ? formatTime(range.startsAt, timeZone) : '',
    endDate:
      choice.formula === 'libre' || choice.formula === 'journee'
        ? choice.endDate || date
        : range
          ? toIsoDate(range.endsAt, timeZone)
          : date,
    endTime:
      choice.formula === 'libre' || choice.formula === 'heure'
        ? choice.endTime
        : range
          ? formatTime(range.endsAt, timeZone)
          : '',
    count: String(choice.count),
  }
}

export function PeriodFields({
  idPrefix,
  date,
  timeZone,
  availability,
  starts,
  maxDays,
  limits,
  formulas,
  choice,
  evaluation,
  onChange,
  fieldClass,
  labelClass,
  errors = {},
}: {
  /**
   * Préfixe des identifiants ; vide : le nom du champ lui-même (`startTime`,
   * `endDate`…), auquel mène le résumé des erreurs.
   */
  idPrefix: string
  /** Jour de l'arrivée. */
  date: string
  timeZone: string
  availability: PeriodAvailability
  /** Arrivées permises ce jour-là : plages libres coupées par le préavis et l'horizon. */
  starts: Date[]
  maxDays: number
  limits: FormulaLimits
  /** Formules réglées sur la ressource ; vide : le formulaire libre. */
  formulas: readonly RentalFormula[]
  choice: PeriodChoice
  /** Le choix évalué par le parent (`evaluateChoice`), pour montrer la période et son refus. */
  evaluation: EvaluatedChoice | undefined
  onChange: (choice: PeriodChoice) => void
  fieldClass: string
  labelClass: string
  errors?: PeriodFieldErrors
}) {
  const id = (name: string) => (idPrefix ? `${idPrefix}-${name}` : name)
  const set = (changes: Partial<PeriodChoice>) => onChange({ ...choice, ...changes })
  const start = choice.startTime ? publicSelection(date, choice.startTime, '23:59', timeZone)?.startsAt : undefined
  const lastAllowedDay = addDaysToIsoDate(date, Math.max(1, maxDays) - 1)
  const range = evaluation?.range
  const describedBy = (name: keyof PeriodFieldErrors, hint?: string) =>
    [errors[name] ? id(`${name}-error`) : undefined, hint].filter(Boolean).join(' ') || undefined

  const fieldError = (name: keyof PeriodFieldErrors) =>
    errors[name] ? (
      <p id={id(`${name}-error`)} className="mt-1 text-sm text-destructive">
        {errors[name]}
      </p>
    ) : null

  const startSelect = (options: Date[], label: string) => (
    <div>
      <label htmlFor={id('startTime')} className={labelClass}>
        {label}
        <Requis />
      </label>
      <select
        id={id('startTime')}
        value={choice.startTime}
        required
        aria-required="true"
        aria-invalid={errors.startTime ? true : undefined}
        aria-describedby={describedBy('startTime')}
        onChange={(event) => set({ startTime: event.target.value, endTime: '' })}
        className={`${fieldClass} mt-1 tabular`}
      >
        <option value="">Choisir une heure</option>
        {options.map((at) => (
          <option key={at.toISOString()} value={formatTime(at, timeZone)}>
            {formatTime(at, timeZone)}
          </option>
        ))}
      </select>
      {fieldError('startTime')}
    </div>
  )

  const endDayInput = (
    <div>
      <label htmlFor={id('endDate')} className={labelClass}>
        Jour du départ
        <Requis />
      </label>
      <input
        id={id('endDate')}
        type="date"
        min={date}
        max={lastAllowedDay}
        value={choice.endDate}
        required
        aria-required="true"
        aria-invalid={errors.endDate ? true : undefined}
        aria-describedby={describedBy('endDate', id('endDate-hint'))}
        onChange={(event) => set({ endDate: event.target.value, endTime: '' })}
        className={`${fieldClass} mt-1`}
      />
      <p id={id('endDate-hint')} className="mt-1 text-xs text-muted-foreground">
        {maxDays > 1 ? `Le jour de votre choix, jusqu’au ${shortDay(lastAllowedDay)}.` : 'Le jour même.'}
      </p>
      {fieldError('endDate')}
    </div>
  )

  const endTimeSelect = (ends: Date[], placeholder: string) => (
    <div>
      <label htmlFor={id('endTime')} className={labelClass}>
        Heure du départ
        <Requis />
      </label>
      <select
        id={id('endTime')}
        value={choice.endTime}
        required
        aria-required="true"
        disabled={!start}
        aria-invalid={errors.endTime ? true : undefined}
        aria-describedby={describedBy('endTime')}
        onChange={(event) => set({ endTime: event.target.value })}
        className={`${fieldClass} mt-1 tabular disabled:bg-muted disabled:text-muted-foreground`}
      >
        <option value="">{start ? 'Choisir une heure' : placeholder}</option>
        {ends.map((at) => (
          <option key={at.toISOString()} value={formatTime(at, timeZone)}>
            {formatTime(at, timeZone)}
            {start ? ` · ${periodDuration({ startsAt: start, endsAt: at }, timeZone)}` : ''}
          </option>
        ))}
      </select>
      {fieldError('endTime')}
    </div>
  )

  let fields: ReactNode
  let notice: string | undefined
  switch (choice.formula) {
    case 'libre':
    case 'heure': {
      const several = choice.formula === 'libre' && maxDays > 1
      const endDate = several ? choice.endDate || date : date
      const ends = start ? periodEnds(start, endDate, availability, timeZone, several ? maxDays : 1) : []
      if (start && several && ends.length === 0) {
        notice = endDayIssueMessage(endDayIssue(start, endDate, availability, timeZone, maxDays), maxDays, (at) =>
          shortInstant(at, timeZone),
        )
      }
      fields = (
        <div className={`grid gap-4 ${several ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}>
          {startSelect(starts, 'Arrivée')}
          {several && endDayInput}
          {endTimeSelect(ends, 'Choisissez d’abord l’arrivée')}
        </div>
      )
      break
    }
    case 'demi_journee': {
      const half = limits.halfDayMinutes * 60_000
      const fitting = starts.filter(
        (at) => !periodRejection({ startsAt: at, endsAt: new Date(at.getTime() + half) }, availability, timeZone, 1),
      )
      fields = (
        <div className="grid gap-4 sm:grid-cols-2">
          {startSelect(fitting, 'Arrivée')}
          <div>
            <p className={labelClass}>Départ</p>
            <p className="mt-1 flex min-h-11 items-center text-sm tabular">
              {start ? `${formatTime(new Date(start.getTime() + half), timeZone)}, une demi-journée plus tard` : 'Une demi-journée après l’arrivée'}
            </p>
          </div>
        </div>
      )
      break
    }
    case 'journee': {
      const departure = choice.endDate ? dayDeparture(availability, choice.endDate) : undefined
      fields = (
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <p className={labelClass}>Arrivée</p>
            <p className="mt-1 flex min-h-11 items-center text-sm tabular">
              {range ? `${shortDay(date)}, ${formatTime(range.startsAt, timeZone)}` : `${shortDay(date)}, à l’ouverture`}
            </p>
          </div>
          {endDayInput}
          {departure && (
            <p className="text-sm text-muted-foreground sm:col-span-2">
              Départ à la fermeture du centre, à <span className="tabular">{formatTime(departure, timeZone)}</span>.
            </p>
          )}
        </div>
      )
      break
    }
    case 'semaine':
    case 'mois': {
      const max = choice.formula === 'semaine' ? limits.maxWeeks : limits.maxMonths
      const unit = (count: number) =>
        choice.formula === 'semaine' ? `${count} semaine${count > 1 ? 's' : ''}` : `${count} mois`
      fields = (
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <p className={labelClass}>Arrivée</p>
            <p className="mt-1 flex min-h-11 items-center text-sm tabular">
              {range ? `${shortDay(date)}, ${formatTime(range.startsAt, timeZone)}` : `${shortDay(date)}, à l’ouverture`}
            </p>
          </div>
          <div>
            <label htmlFor={id('count')} className={labelClass}>
              Durée
              <Requis />
            </label>
            <select
              id={id('count')}
              value={String(choice.count)}
              required
              aria-required="true"
              aria-invalid={errors.count ? true : undefined}
              aria-describedby={describedBy('count', id('count-hint'))}
              onChange={(event) => set({ count: Number(event.target.value) })}
              className={`${fieldClass} mt-1`}
            >
              {Array.from({ length: max }, (_, index) => index + 1).map((count) => (
                <option key={count} value={count}>
                  {unit(count)}
                </option>
              ))}
            </select>
            <p id={id('count-hint')} className="mt-1 text-xs text-muted-foreground">
              Jusqu’au {shortDay(lastDayOfLongFormula(choice.formula, date, choice.count))} inclus
              {range ? `, départ le ${shortInstant(range.endsAt, timeZone)} (fermeture)` : ''}.
            </p>
            {fieldError('count')}
          </div>
        </div>
      )
      break
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {formulas.length > 1 && (
        <fieldset aria-describedby={errors.formula ? id('formula-error') : undefined}>
          <legend className={labelClass}>
            Formule
            <Requis />
          </legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {formulas.map((formula, index) => {
              const checked = choice.formula === formula
              return (
                <label key={formula} className="relative flex cursor-pointer">
                  <input
                    id={index === 0 ? id('formula') : undefined}
                    type="radio"
                    name={id('formula-choice')}
                    value={formula}
                    checked={checked}
                    required
                    onChange={() => onChange(emptyChoice(formula as ChosenFormula, date))}
                    className="peer sr-only"
                  />
                  <span
                    className={`flex min-h-11 w-full items-start gap-2 rounded-md border-2 px-3 py-2 text-sm transition-colors duration-150 ease-out peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-primary ${checked ? 'border-primary bg-accent/5' : 'border-border bg-white hover:border-primary/50'}`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium text-primary">{rentalFormulaLabels[formula]}</span>
                      <span className="block text-xs text-muted-foreground">{rentalFormulaDescriptions[formula]}</span>
                    </span>
                    {checked && (
                      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-white">
                        <CheckIcon size={16} />
                        <span className="sr-only">Choisie</span>
                      </span>
                    )}
                  </span>
                </label>
              )
            })}
          </div>
          {fieldError('formula')}
        </fieldset>
      )}
      {formulas.length === 1 && (
        <p className="text-sm">
          <span className="font-medium">Formule : </span>
          {rentalFormulaLabels[formulas[0]].toLocaleLowerCase('fr-FR')} — {rentalFormulaDescriptions[formulas[0]].toLocaleLowerCase('fr-FR')}
        </p>
      )}

      {fields}

      {notice && (
        <p role="alert" className="text-sm text-destructive">
          {notice}
        </p>
      )}
      {range && evaluation?.rejection && (
        <p role="alert" className="text-sm text-destructive">
          {choiceRejectionMessage(evaluation.rejection, maxDays, limits)}
        </p>
      )}

      {range && <OpeningHours range={range} availability={availability} timeZone={timeZone} />}
      {!range && choice.formula === 'libre' && maxDays > 1 && (
        <p className="text-xs text-muted-foreground">
          Jusqu’à {formatDays(maxDays)} d’affilée : le jour du départ se choisit librement.
        </p>
      )}
    </div>
  )
}

/**
 * Heures d'ouverture du centre sur les jours de la période : on arrive et on
 * repart quand le centre est ouvert, on y accède à ses heures d'ouverture
 * (ADR 076). Au-delà de deux semaines, l'arrivée et le départ seulement.
 */
function OpeningHours({ range, availability, timeZone }: { range: TimeRange; availability: PeriodAvailability; timeZone: string }) {
  const first = toIsoDate(range.startsAt, timeZone)
  const last = toIsoDate(new Date(range.endsAt.getTime() - 1), timeZone)
  const hours = (windows: TimeRange[]) =>
    windows.length === 0
      ? 'fermé'
      : windows.map((window) => `${formatTime(window.startsAt, timeZone)} – ${formatTime(window.endsAt, timeZone)}`).join(', ')
  // Deux jours ont des instants différents : on regroupe par heures murales.
  const shown = openingGroups(availability, first, last, (window) =>
    `${formatTime(window.startsAt, timeZone)}-${formatTime(window.endsAt, timeZone)}`,
  )
  const long = Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`) > 13 * 86_400_000
  const lines = long
    ? [
        { label: `Arrivée, ${shortDay(first)}`, text: hours(availability.days.find((day) => day.date === first)?.windows ?? []) },
        { label: `Départ, ${shortDay(last)}`, text: hours(availability.days.find((day) => day.date === last)?.windows ?? []) },
      ]
    : shown.map((group) => ({
        label: group.from === group.to ? shortDay(group.from) : `${shortDay(group.from)} → ${shortDay(group.to)}`,
        text: hours(group.hours),
      }))
  return (
    <div className="rounded-md border border-border bg-white p-3 text-sm">
      <p className="flex items-center gap-2 font-medium">
        <ClockIcon size={16} className="shrink-0 text-primary" />
        Heures d’ouverture du centre
      </p>
      <ul className="mt-2 flex flex-col gap-1">
        {lines.map((line) => (
          <li key={line.label} className="flex flex-wrap justify-between gap-x-4">
            <span className="text-muted-foreground first-letter:uppercase">{line.label}</span>
            <span className="tabular">{line.text}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-muted-foreground">
        {long
          ? 'Entre les deux, l’espace vous est réservé ; vous y accédez aux heures d’ouverture du centre.'
          : 'L’espace vous est réservé sur toute la période ; vous y accédez aux heures d’ouverture du centre.'}
      </p>
    </div>
  )
}
