'use client'

import { useActionState, useEffect, useRef, useState } from 'react'

import Link from 'next/link'

import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import { CheckIcon, ClockIcon } from '../../components/ui/icons.tsx'
import { formatMinutes, formatTime } from '../../lib/dates.ts'
import { QuoteSummary } from '../facturation/devis-resume.tsx'
import {
  bookFromPortalAction,
  previewPortalBookingAction,
  type PortalBookingFormState,
  type PortalQuoteState,
} from './portail-actions.ts'
import {
  MAX_PORTAL_NOTES_LENGTH,
  MAX_PORTAL_TITLE_LENGTH,
  portalModeLabels,
  type PortalBookingMode,
} from './portail-regles.ts'
import { availableEnds, availableStarts, publicSelection } from './public-selection.ts'

const fieldClass =
  'mt-1 w-full min-h-11 rounded-sm border border-border bg-white px-3 py-2 text-base outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-accent/40 aria-[invalid=true]:border-destructive disabled:bg-muted disabled:text-muted-foreground'
const labelClass = 'block text-sm font-medium'
const focusClass = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary'

/** Un espace dans la journée : ses plages libres déjà coupées par le préavis du centre. */
export type PortalBookingFormProps = {
  resource: { id: string; name: string; typeLabel: string; mode: PortalBookingMode }
  date: string
  dateLabel: string
  timeZone: string
  /** Plages libres, en instants ISO (sérialisables). */
  free: { startsAt: string; endsAt: string }[]
  /** Instant de référence du serveur, et dernier départ permis par l'horizon du centre. */
  now: string
  latestStart: string
  accounts: { clientId: string; clientName: string }[]
}

const fieldLabels: Record<string, string> = {
  clientId: 'Entreprise',
  startTime: 'Heure de début',
  endTime: 'Heure de fin',
  title: 'Objet',
  notes: 'Précisions',
}

/** Une journée d'heure murale ne se réserve qu'à l'intérieur d'une plage libre : pas de plafond de huit heures. */
const PORTAL_MAX_MINUTES = 24 * 60

/**
 * Formulaire de réservation de l'espace client (R23) : l'entreprise (si le
 * compte en représente plusieurs), les heures parmi les plages libres, l'objet.
 * Le montant est demandé au serveur dès que le créneau est complet — le devis
 * de la vague 2, celui qui sera figé — avec ce qui se passera à l'envoi :
 * confirmation immédiate ou demande à l'accueil (ADR 036).
 */
export function PortalBookingForm(props: PortalBookingFormProps) {
  const { resource, date, dateLabel, timeZone, accounts } = props
  const [state, formAction, pending] = useActionState<PortalBookingFormState, FormData>(
    bookFromPortalAction,
    { status: 'idle' },
  )
  const [clientId, setClientId] = useState(accounts.length === 1 ? accounts[0].clientId : '')
  const [startTime, setStartTime] = useState('')
  const [endTime, setEndTime] = useState('')
  // Contrôlés : React réinitialise le formulaire après chaque envoi, un échec
  // ne doit rien faire retaper.
  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const [preview, setPreview] = useState<{ key: string; result: PortalQuoteState }>()
  const headingRef = useRef<HTMLHeadingElement>(null)

  const free = props.free.map((range) => ({ startsAt: new Date(range.startsAt), endsAt: new Date(range.endsAt) }))
  const starts = availableStarts(free, new Date(props.now), new Date(props.latestStart))
  const start = startTime ? publicSelection(date, startTime, '23:59', timeZone)?.startsAt : undefined
  const ends = start ? availableEnds(start, free, timeZone, PORTAL_MAX_MINUTES) : []
  const selection = startTime && endTime ? publicSelection(date, startTime, endTime, timeZone) : undefined

  const previewKey = selection && clientId ? `${resource.id}/${clientId}/${date}/${startTime}/${endTime}` : ''
  const quote = previewKey && preview?.key === previewKey ? preview.result : undefined

  useEffect(() => {
    if (!previewKey) return
    let cancelled = false
    previewPortalBookingAction({ resourceId: resource.id, clientId, date, startTime, endTime }).then(
      (result) => {
        if (!cancelled) setPreview({ key: previewKey, result })
      },
      () => {
        if (!cancelled) {
          setPreview({
            key: previewKey,
            result: { status: 'error', message: 'Le montant n’a pas pu être calculé. Réessayez.' },
          })
        }
      },
    )
    return () => {
      cancelled = true
    }
  }, [previewKey, resource.id, clientId, date, startTime, endTime])

  useEffect(() => {
    if (state.status === 'done') headingRef.current?.focus()
  }, [state])

  if (state.status === 'done') {
    const confirmed = state.outcome === 'confirmed'
    const Icon = confirmed ? CheckIcon : ClockIcon
    return (
      <div role="status" className="rounded-lg border border-border bg-muted p-5 sm:p-6">
        <p className="flex items-center gap-2 text-sm font-medium text-primary">
          <span
            className={`inline-flex size-8 items-center justify-center rounded-full ${confirmed ? 'bg-primary text-primary-foreground' : 'bg-accent/15 text-primary'}`}
          >
            <Icon size={20} />
          </span>
          {confirmed ? 'Réservée' : 'En attente de validation'}
        </p>
        <h3
          ref={headingRef}
          tabIndex={-1}
          className="mt-3 text-xl font-semibold text-primary outline-none"
        >
          {state.title}
        </h3>
        <p className="mt-2 max-w-prose">{state.body}</p>
        <p className="mt-2 text-sm text-muted-foreground">
          {state.amount
            ? `Montant ${confirmed ? 'de la réservation' : 'retenu sur la demande'} : ${state.amount} TTC.`
            : 'Le montant vous sera précisé par l’accueil.'}
        </p>
        <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:gap-3">
          <Link
            href="/compte/reservations"
            className={`inline-flex min-h-11 items-center justify-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover ${focusClass}`}
          >
            Voir mes réservations
          </Link>
          <Link
            href={`/compte/reservations/nouvelle?date=${date}`}
            className={`inline-flex min-h-11 items-center justify-center rounded-md border border-border bg-white px-5 text-sm font-medium transition-colors hover:bg-muted ${focusClass}`}
          >
            Réserver un autre créneau
          </Link>
        </div>
      </div>
    )
  }

  const errors = state.status === 'error' ? (state.fieldErrors ?? {}) : {}
  const ready = Boolean(selection && clientId && quote && quote.status !== 'error')
  const submitLabel =
    quote && quote.status !== 'error' && quote.outcome === 'confirmed'
      ? 'Confirmer la réservation'
      : 'Envoyer la demande'

  return (
    <form action={formAction} noValidate className="flex flex-col gap-5">
      <ErrorSummary
        errors={state.status === 'error' ? state.fieldErrors : undefined}
        labels={fieldLabels}
        message={state.status === 'error' ? state.message : undefined}
      />
      <input type="hidden" name="resourceId" value={resource.id} />
      <input type="hidden" name="date" value={date} />

      <div className="rounded-md bg-muted p-4 text-sm">
        <p className="font-semibold text-primary">{resource.name}</p>
        <p className="text-muted-foreground">
          {resource.typeLabel} · <span className="capitalize">{dateLabel}</span>
        </p>
        <p className="mt-2 inline-flex items-center gap-1.5 font-medium text-primary">
          {resource.mode === 'instant' ? <CheckIcon size={20} /> : <ClockIcon size={20} />}
          {portalModeLabels[resource.mode]}
        </p>
      </div>

      {accounts.length > 1 ? (
        <div>
          <label htmlFor="clientId" className={labelClass}>
            Entreprise
          </label>
          <select
            id="clientId"
            name="clientId"
            value={clientId}
            required
            onChange={(event) => setClientId(event.target.value)}
            aria-invalid={errors.clientId ? true : undefined}
            aria-describedby={errors.clientId ? 'clientId-error' : 'clientId-hint'}
            className={fieldClass}
          >
            <option value="">Choisir l’entreprise</option>
            {accounts.map((account) => (
              <option key={account.clientId} value={account.clientId}>
                {account.clientName}
              </option>
            ))}
          </select>
          <p id="clientId-hint" className="mt-1 text-xs text-muted-foreground">
            Le tarif est celui de son contrat ; la réservation figurera sur sa facture.
          </p>
          <FieldError name="clientId" error={errors.clientId} />
        </div>
      ) : (
        <input type="hidden" name="clientId" value={clientId} />
      )}

      {starts.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
          Plus aucun créneau libre ce jour-là. Choisissez une autre date ou un autre espace.
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="startTime" className={labelClass}>
              Heure de début
            </label>
            <select
              id="startTime"
              name="startTime"
              value={startTime}
              required
              onChange={(event) => {
                setStartTime(event.target.value)
                setEndTime('')
              }}
              aria-invalid={errors.startTime ? true : undefined}
              aria-describedby={errors.startTime ? 'startTime-error' : undefined}
              className={`${fieldClass} tabular`}
            >
              <option value="">Choisir</option>
              {starts.map((at) => (
                <option key={at.toISOString()} value={formatTime(at, timeZone)}>
                  {formatTime(at, timeZone)}
                </option>
              ))}
            </select>
            <FieldError name="startTime" error={errors.startTime} />
          </div>
          <div>
            <label htmlFor="endTime" className={labelClass}>
              Heure de fin
            </label>
            <select
              id="endTime"
              name="endTime"
              value={endTime}
              required
              disabled={!startTime}
              onChange={(event) => setEndTime(event.target.value)}
              aria-invalid={errors.endTime ? true : undefined}
              aria-describedby={errors.endTime ? 'endTime-error' : 'endTime-hint'}
              className={`${fieldClass} tabular`}
            >
              <option value="">{startTime ? 'Choisir' : 'Choisissez d’abord le début'}</option>
              {ends.map((at) => (
                <option key={at.toISOString()} value={formatTime(at, timeZone)}>
                  {formatTime(at, timeZone)} ·{' '}
                  {formatMinutes((at.getTime() - (start ? start.getTime() : 0)) / 60_000)}
                </option>
              ))}
            </select>
            <p id="endTime-hint" className="mt-1 text-xs text-muted-foreground">
              Seuls les horaires libres sont proposés, à l’heure du centre.
            </p>
            <FieldError name="endTime" error={errors.endTime} />
          </div>
        </div>
      )}

      <div>
        <label htmlFor="title" className={labelClass}>
          Objet <span className="font-normal text-muted-foreground">(facultatif)</span>
        </label>
        <input
          id="title"
          name="title"
          type="text"
          autoComplete="off"
          maxLength={MAX_PORTAL_TITLE_LENGTH}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          aria-invalid={errors.title ? true : undefined}
          aria-describedby={errors.title ? 'title-error' : 'title-hint'}
          className={fieldClass}
        />
        <p id="title-hint" className="mt-1 text-xs text-muted-foreground">
          Réunion d’équipe, entretien… Sans objet, le nom de l’entreprise est affiché à l’accueil.
        </p>
        <FieldError name="title" error={errors.title} />
      </div>

      <div>
        <label htmlFor="notes" className={labelClass}>
          Précisions pour l’accueil <span className="font-normal text-muted-foreground">(facultatif)</span>
        </label>
        <textarea
          id="notes"
          name="notes"
          rows={3}
          maxLength={MAX_PORTAL_NOTES_LENGTH}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          aria-invalid={errors.notes ? true : undefined}
          aria-describedby={errors.notes ? 'notes-error' : undefined}
          className={fieldClass}
        />
        <FieldError name="notes" error={errors.notes} />
      </div>

      {/* Place tenue pendant le calcul : pas de saut de mise en page. */}
      <section
        aria-labelledby="montant"
        aria-live="polite"
        aria-busy={Boolean(previewKey) && !quote}
        className="min-h-32 rounded-md border border-border p-4"
      >
        <h3 id="montant" className="mb-2 text-sm font-medium">
          Montant et confirmation
        </h3>
        {!previewKey ? (
          <p className="text-sm text-muted-foreground">
            Choisissez {accounts.length > 1 ? 'l’entreprise et ' : ''}vos horaires pour connaître le
            montant.
          </p>
        ) : !quote ? (
          <p className="text-sm text-muted-foreground">Calcul du montant…</p>
        ) : quote.status === 'error' ? (
          <p className="text-sm text-destructive">{quote.message}</p>
        ) : (
          <>
            {quote.status === 'priced' ? (
              <>
                <QuoteSummary quote={quote.quote} />
                <p className="mt-2 text-xs text-muted-foreground">
                  {quote.fromContract ? 'Tarif de votre contrat. ' : ''}Ce montant est figé sur votre
                  réservation dès l’envoi.
                </p>
              </>
            ) : null}
            <p className="mt-3 flex items-start gap-2 text-sm font-medium text-primary">
              {quote.outcome === 'confirmed' ? (
                <CheckIcon size={20} className="shrink-0" />
              ) : (
                <ClockIcon size={20} className="shrink-0" />
              )}
              <span>{quote.notice}</span>
            </p>
          </>
        )}
      </section>

      <div className="flex flex-col gap-3 border-t border-border pt-5 sm:flex-row sm:items-center">
        <button
          type="submit"
          disabled={pending || !ready}
          className={`inline-flex min-h-11 items-center justify-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50 ${focusClass}`}
        >
          {pending ? 'Envoi…' : submitLabel}
        </button>
        <p aria-live="polite" className="text-sm text-muted-foreground">
          {pending ? 'Envoi en cours.' : ''}
        </p>
      </div>
    </form>
  )
}

function FieldError({ name, error }: { name: string; error?: string }) {
  if (!error) return null
  return (
    <p id={`${name}-error`} className="mt-1 text-sm text-destructive">
      {error}
    </p>
  )
}
