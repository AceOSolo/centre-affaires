'use client'

import Link from 'next/link'
import { useActionState, useEffect, useRef, useState } from 'react'

import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import { ClockIcon } from '../../components/ui/icons.tsx'
import { QuoteSummary } from '../facturation/devis-resume.tsx'
import type { RentalFormula } from '../ressources/formules.ts'
import {
  modifyClientBookingAction,
  previewModificationAction,
  type ModificationFormState,
  type ModificationQuoteState,
} from './compte-modification-actions.ts'
import { evaluateChoice, type FormulaLimits, type PeriodChoice } from './formules-periode.ts'
import { revivePeriod, type SerializedPeriodAvailability } from './periode.ts'
import { choiceFormValues, PeriodFields } from './periode-fields.tsx'
import { availableStarts } from './public-selection.ts'

const fieldClass =
  'w-full min-h-11 rounded-sm border border-border bg-white px-3 py-2 text-base outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-accent/40 aria-[invalid=true]:border-destructive disabled:bg-muted disabled:text-muted-foreground'
const labelClass = 'block text-sm font-medium'
const focusClass = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary'

const fieldLabels: Record<string, string> = {
  formula: 'Formule',
  startTime: 'Arrivée',
  endDate: 'Jour du départ',
  endTime: 'Heure du départ',
  count: 'Durée',
}

/**
 * Nouvelles dates d'une demande ou d'une réservation, choisies par son client
 * (ADR 076) : la formule, les jours et les heures, comme à la réservation
 * (`PeriodFields`), le nouveau montant, puis l'envoi. La réservation repasse
 * en attente de l'accueil ; l'écran le dit avant et après.
 */
export function ModificationForm(props: {
  bookingId: string
  /** Jour de l'arrivée, choisi par la page (formulaire en GET). */
  date: string
  timeZone: string
  /** Choix de départ : la réservation telle qu'elle est, si son jour est celui affiché. */
  initialChoice: PeriodChoice
  free: { startsAt: string; endsAt: string }[]
  period: SerializedPeriodAvailability
  maxDays: number
  formulas: RentalFormula[]
  limits: FormulaLimits
  now: string
  earliest: string
  latestStart: string
}) {
  const { bookingId, date, timeZone, maxDays, formulas, limits } = props
  const [state, formAction, pending] = useActionState<ModificationFormState, FormData>(modifyClientBookingAction, {
    status: 'idle',
  })
  const [choice, setChoice] = useState<PeriodChoice>(props.initialChoice)
  const [preview, setPreview] = useState<{ key: string; result: ModificationQuoteState }>()
  const headingRef = useRef<HTMLHeadingElement>(null)

  const period = revivePeriod(props.period)
  const free = props.free.map((range) => ({ startsAt: new Date(range.startsAt), endsAt: new Date(range.endsAt) }))
  const starts = availableStarts(free, new Date(props.now), new Date(props.latestStart))
  const evaluation = evaluateChoice(
    choice,
    { date, timeZone, availability: period, earliest: new Date(props.earliest), maxDays, limits },
    formulas,
  )
  const valid = Boolean(evaluation.range && !evaluation.rejection)
  const values = choiceFormValues(choice, evaluation, date, timeZone)
  const previewKey = valid ? JSON.stringify(values) : ''
  const quote = previewKey && preview?.key === previewKey ? preview.result : undefined

  useEffect(() => {
    if (!previewKey) return
    let cancelled = false
    const input = JSON.parse(previewKey) as typeof values
    previewModificationAction({ bookingId, date, ...input }).then(
      (result) => {
        if (!cancelled) setPreview({ key: previewKey, result })
      },
      () => {
        if (!cancelled) {
          setPreview({ key: previewKey, result: { status: 'unpriced', message: 'Le montant n’a pas pu être calculé.' } })
        }
      },
    )
    return () => {
      cancelled = true
    }
  }, [previewKey, bookingId, date])

  useEffect(() => {
    if (state.status === 'done') headingRef.current?.focus()
  }, [state])

  if (state.status === 'done') {
    return (
      <div role="status" className="rounded-lg border border-border bg-muted p-5 sm:p-6">
        <p className="flex items-center gap-2 text-sm font-medium text-primary">
          <span className="inline-flex size-8 items-center justify-center rounded-full bg-accent/15 text-primary">
            <ClockIcon size={20} />
          </span>
          En attente de validation
        </p>
        <h2 ref={headingRef} tabIndex={-1} className="mt-3 text-xl font-semibold text-primary outline-none">
          {state.title}
        </h2>
        <p className="mt-2 max-w-prose">{state.body}</p>
        <p className="mt-2 text-sm text-muted-foreground">
          {state.amount ? `Nouveau montant : ${state.amount} TTC.` : 'Le montant vous sera précisé par l’accueil.'}
        </p>
        <Link
          href="/compte/reservations"
          className={`mt-5 inline-flex min-h-11 items-center justify-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover ${focusClass}`}
        >
          Voir mes réservations
        </Link>
      </div>
    )
  }

  const errors = state.status === 'error' ? (state.fieldErrors ?? {}) : {}

  return (
    <form action={formAction} noValidate className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">Les champs marqués * sont obligatoires.</p>
      <ErrorSummary
        errors={state.status === 'error' ? state.fieldErrors : undefined}
        labels={fieldLabels}
        message={state.status === 'error' ? state.message : undefined}
      />
      <input type="hidden" name="bookingId" value={bookingId} />
      <input type="hidden" name="date" value={date} />
      {Object.entries(values).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}

      {starts.length === 0 && (choice.formula === 'libre' || choice.formula === 'heure' || choice.formula === 'demi_journee') ? (
        <p className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
          Plus aucun horaire libre ce jour-là. Choisissez un autre jour d’arrivée.
        </p>
      ) : (
        <PeriodFields
          idPrefix=""
          date={date}
          timeZone={timeZone}
          availability={period}
          starts={starts}
          maxDays={maxDays}
          limits={limits}
          formulas={formulas}
          choice={choice}
          evaluation={evaluation}
          onChange={setChoice}
          fieldClass={fieldClass}
          labelClass={labelClass}
          errors={errors}
        />
      )}

      {/* Place tenue pendant le calcul : pas de saut de mise en page. */}
      <section
        aria-labelledby="nouveau-montant"
        aria-live="polite"
        aria-busy={Boolean(previewKey) && !quote}
        className="min-h-28 rounded-md border border-border p-4"
      >
        <h2 id="nouveau-montant" className="mb-2 text-sm font-medium">
          Nouveau montant
        </h2>
        {!previewKey ? (
          <p className="text-sm text-muted-foreground">Choisissez vos nouvelles dates pour connaître le montant.</p>
        ) : !quote ? (
          <p className="text-sm text-muted-foreground">Calcul du montant…</p>
        ) : quote.status === 'priced' ? (
          <QuoteSummary quote={quote.quote} />
        ) : (
          <p className="text-sm text-muted-foreground">{quote.message}</p>
        )}
        <p className="mt-3 flex items-start gap-2 text-sm font-medium text-primary">
          <ClockIcon size={20} className="shrink-0" />
          <span>Après modification, la réservation attend de nouveau la validation de l’accueil. Le créneau vous est bloqué en attendant.</span>
        </p>
      </section>

      <div className="flex flex-col gap-3 border-t border-border pt-5 sm:flex-row sm:items-center">
        <button
          type="submit"
          disabled={pending || !valid}
          className={`inline-flex min-h-11 items-center justify-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50 ${focusClass}`}
        >
          {pending ? 'Envoi…' : 'Envoyer la modification'}
        </button>
        <Link
          href="/compte/reservations"
          className={`inline-flex min-h-11 items-center justify-center rounded-md border border-border bg-white px-5 text-sm font-medium transition-colors hover:bg-muted ${focusClass}`}
        >
          Ne rien changer
        </Link>
        <p aria-live="polite" className="text-sm text-muted-foreground">
          {pending ? 'Envoi en cours.' : ''}
        </p>
      </div>
    </form>
  )
}
