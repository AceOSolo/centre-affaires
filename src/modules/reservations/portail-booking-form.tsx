'use client'

import { useActionState, useEffect, useRef, useState } from 'react'

import Link from 'next/link'

import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import { CheckIcon, ClockIcon } from '../../components/ui/icons.tsx'
import { formatTime } from '../../lib/dates.ts'
import { QuoteSummary, formatQuoteQuantity } from '../facturation/devis-resume.tsx'
import { formatCents } from '../facturation/tarifs.ts'
import { formatDays } from './durees.ts'
import { totalWithOptions } from './options.ts'
import {
  periodDuration,
  periodEndDates,
  periodEnds,
  revivePeriod,
  type SerializedPeriodAvailability,
} from './periode.ts'
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
import { availableStarts, periodSelection, publicSelection } from './public-selection.ts'
import type { ProposalProduct } from '../facturation/schema-devis.ts'
import { QuestionnaireFields, questionnaireErrorLabels } from './questionnaire-fields.tsx'

const fieldClass =
  'mt-1 w-full min-h-11 rounded-sm border border-border bg-white px-3 py-2 text-base outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-accent/40 aria-[invalid=true]:border-destructive disabled:bg-muted disabled:text-muted-foreground'
const labelClass = 'block text-sm font-medium'
const focusClass = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary'

/** Un espace dans la journée : ses plages libres déjà coupées par le préavis du centre. */
export type PortalBookingFormProps = {
  resource: { id: string; name: string; typeLabel: string; mode: PortalBookingMode; product?: ProposalProduct }
  date: string
  dateLabel: string
  timeZone: string
  /** Plages libres du jour, coupées par le préavis, en instants ISO (sérialisables) : les départs. */
  free: { startsAt: string; endsAt: string }[]
  /**
   * La ressource sur les jours qu'une demande peut couvrir, à partir de ce
   * jour (ADR 061) : les fins se proposent jusqu'au bout de la période libre.
   */
  period: SerializedPeriodAvailability
  /** Jours d'affilée permis pour ce produit ; 1 : le formulaire d'une journée, comme avant. */
  maxDays: number
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

/** « mer. 4 nov. » : un jour de fin dans la liste ; midi UTC ne change jamais de date. */
const shortDay = (isoDate: string) =>
  new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(
    new Date(`${isoDate}T12:00:00Z`),
  )

/**
 * Formulaire de réservation de l'espace client (R23) : l'entreprise (si le
 * compte en représente plusieurs), les heures parmi les plages libres, l'objet.
 * Le montant est demandé au serveur dès que le créneau est complet — le devis
 * de la vague 2, celui qui sera figé — avec ce qui se passera à l'envoi :
 * confirmation immédiate ou demande à l'accueil (ADR 036).
 */
export function PortalBookingForm(props: PortalBookingFormProps) {
  const { resource, date, dateLabel, timeZone, accounts, maxDays } = props
  const [state, formAction, pending] = useActionState<PortalBookingFormState, FormData>(
    bookFromPortalAction,
    { status: 'idle' },
  )
  const [clientId, setClientId] = useState(accounts.length === 1 ? accounts[0].clientId : '')
  const [startTime, setStartTime] = useState('')
  // Jour de la fin : le jour même, sauf demande sur plusieurs jours (ADR 061).
  const [endDate, setEndDate] = useState(date)
  const [endTime, setEndTime] = useState('')
  // Contrôlés : React réinitialise le formulaire après chaque envoi, un échec
  // ne doit rien faire retaper.
  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const [preview, setPreview] = useState<{ key: string; result: PortalQuoteState }>()
  // Matériel coché en option d'une salle (ADR 062) : gardé d'un créneau à
  // l'autre tant que l'appareil y reste libre.
  const [equipmentIds, setEquipmentIds] = useState<string[]>([])
  const headingRef = useRef<HTMLHeadingElement>(null)

  const free = props.free.map((range) => ({ startsAt: new Date(range.startsAt), endsAt: new Date(range.endsAt) }))
  const period = revivePeriod(props.period)
  const starts = availableStarts(free, new Date(props.now), new Date(props.latestStart))
  const start = startTime ? publicSelection(date, startTime, '23:59', timeZone)?.startsAt : undefined
  const endDates = start ? periodEndDates(start, period, timeZone, maxDays) : []
  const ends = start ? periodEnds(start, endDate, period, timeZone, maxDays) : []
  const selection = startTime && endTime ? periodSelection(date, startTime, endDate, endTime, timeZone) : undefined

  const previewKey = selection && clientId ? `${resource.id}/${clientId}/${date}/${startTime}/${endDate}/${endTime}` : ''
  const quote = previewKey && preview?.key === previewKey ? preview.result : undefined
  const equipment = quote && quote.status !== 'error' ? quote.equipment : []
  const chosen = equipment.filter((device) => equipmentIds.includes(device.id))
  const total =
    quote?.status === 'priced' && chosen.length > 0
      ? totalWithOptions([quote.quote, ...chosen.map((device) => device.quote)])
      : undefined

  useEffect(() => {
    if (!previewKey) return
    let cancelled = false
    previewPortalBookingAction({ resourceId: resource.id, clientId, date, startTime, endDate, endTime }).then(
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
  }, [previewKey, resource.id, clientId, date, startTime, endDate, endTime])

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
        {state.options.length > 0 && (
          <div className="mt-3 text-sm">
            <p className="font-medium">Matériel réservé avec la salle</p>
            <ul className="mt-1 flex flex-col gap-1">
              {state.options.map((option, index) => (
                <li key={`${index}-${option.name}`} className="flex items-center gap-2">
                  {option.outcome === 'confirmed' ? (
                    <CheckIcon size={20} className="shrink-0 text-primary" />
                  ) : (
                    <ClockIcon size={20} className="shrink-0 text-primary" />
                  )}
                  <span>
                    {option.name} : {option.outcome === 'confirmed' ? 'réservé' : 'en attente de validation'}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-1 text-muted-foreground">Il suit la salle : si elle est annulée, il l’est aussi.</p>
          </div>
        )}
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
  const answers = state.status === 'error' ? state.answers : undefined
  // Erreurs du questionnaire, par nom de question, comme les attend le composant.
  const answerErrors = Object.fromEntries(
    Object.entries(state.status === 'error' ? (state.answerErrors ?? {}) : {}).map(([field, message]) => [
      field.replace(/^q\./, ''),
      message,
    ]),
  )
  const ready = Boolean(selection && clientId && quote && quote.status !== 'error')
  const submitLabel =
    quote && quote.status !== 'error' && quote.outcome === 'confirmed'
      ? 'Confirmer la réservation'
      : 'Envoyer la demande'

  return (
    <form action={formAction} noValidate className="flex flex-col gap-5">
      <ErrorSummary
        errors={state.status === 'error' ? { ...state.fieldErrors, ...state.answerErrors } : undefined}
        labels={resource.product ? { ...fieldLabels, ...questionnaireErrorLabels(resource.product) } : fieldLabels}
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
        <div className={`grid gap-4 ${maxDays > 1 ? 'sm:grid-cols-3' : 'sm:grid-cols-2'}`}>
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
                setEndDate(date)
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
          {/* Plusieurs jours d'affilée (ADR 061) : le jour de fin, puis son heure. */}
          {maxDays > 1 ? (
            <div>
              <label htmlFor="endDate" className={labelClass}>
                Jour de fin
              </label>
              <select
                id="endDate"
                name="endDate"
                value={endDate}
                disabled={!startTime}
                onChange={(event) => {
                  setEndDate(event.target.value)
                  setEndTime('')
                }}
                className={`${fieldClass} tabular`}
              >
                {(endDates.length > 0 ? endDates : [date]).map((day) => (
                  <option key={day} value={day}>
                    {day === date ? 'Le même jour' : shortDay(day)}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <input type="hidden" name="endDate" value={endDate} />
          )}
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
                  {formatTime(at, timeZone)} · {start ? periodDuration({ startsAt: start, endsAt: at }, timeZone) : ''}
                </option>
              ))}
            </select>
            <FieldError name="endTime" error={errors.endTime} />
          </div>
          <p id="endTime-hint" className="text-xs text-muted-foreground sm:col-span-full">
            Seuls les horaires libres sont proposés, à l’heure du centre.
            {maxDays > 1 &&
              ` Jusqu’à ${formatDays(maxDays)} d’affilée : sur plusieurs jours, la réservation court nuits comprises.`}
          </p>
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

      {resource.product && (
        <fieldset className="flex flex-col gap-4 rounded-md border border-border p-4">
          <legend className="px-1 text-sm font-semibold">Votre besoin</legend>
          <p className="text-sm text-muted-foreground">
            Ces réponses accompagnent votre devis : elles permettent à l’accueil de préparer l’espace.
          </p>
          <QuestionnaireFields
            key={JSON.stringify(answers ?? {})}
            product={resource.product}
            defaults={answers}
            errors={answerErrors}
          />
        </fieldset>
      )}

      {/* Matériel en option d'une salle (ADR 062) : les appareils libres sur le
          créneau, chiffrés ; chacun est réservé avec la salle. */}
      {equipment.length > 0 && (
        <fieldset className="flex flex-col gap-2 rounded-md border border-border p-4">
          <legend className="px-1 text-sm font-semibold">Matériel en option</legend>
          <p className="text-sm text-muted-foreground">
            Libre sur ce créneau. Réservé avec la salle, sur la même période, et annulé avec elle.
          </p>
          <ul className="flex flex-col gap-1">
            {equipment.map((device) => (
              <li key={device.id}>
                <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-sm px-1 py-2 hover:bg-muted">
                  <input
                    type="checkbox"
                    name="equipmentIds"
                    value={device.id}
                    checked={equipmentIds.includes(device.id)}
                    onChange={(event) =>
                      setEquipmentIds((current) =>
                        event.target.checked ? [...current, device.id] : current.filter((id) => id !== device.id),
                      )
                    }
                    className={`size-5 shrink-0 accent-primary ${focusClass}`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{device.name}</span>
                    {device.detail && <span className="block text-xs text-muted-foreground">{device.detail}</span>}
                  </span>
                  <span className="shrink-0 text-right text-sm tabular text-muted-foreground">
                    {device.quote
                      ? <>{formatCents(device.quote.totalCents, device.quote.currency)} TTC<span className="block text-xs">{formatQuoteQuantity(device.quote.unit, device.quote.quantity)}</span></>
                      : 'Prix précisé par l’accueil'}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      )}

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
                {total && total.currency && (
                  <p className="mt-2 text-sm tabular">
                    Avec le matériel : <span className="font-semibold">{formatCents(total.totalCents, total.currency)} TTC</span>
                    {total.unpriced > 0 && <span className="text-muted-foreground"> — hors appareil au prix précisé par l’accueil</span>}
                  </p>
                )}
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
