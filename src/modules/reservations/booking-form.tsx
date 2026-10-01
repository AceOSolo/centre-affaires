'use client'

import { useActionState, useEffect, useMemo, useState } from 'react'

import Link from 'next/link'

import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import { CheckIcon, ClockIcon } from '../../components/ui/icons.tsx'
import { formatMinutes, formatTime, toIsoDate, wallClockToUtc } from '../../lib/dates.ts'
import { formatContractDays, lastContractDay } from '../contrats/occupation.ts'
import { QuoteSummary, quotePlanLabel } from '../facturation/devis-resume.tsx'
import type { Resource } from '../ressources/schema.ts'
import { createBookingAction, type FormState } from './actions.ts'
import { overlaps, type TimeRange } from './availability.ts'
import { previewBookingQuoteAction, type BookingQuotePreview } from './devis-actions.ts'
import { describeBusyBooking } from './occupation.ts'
import { bookingContractProblem, type AttachableContract } from './rattachement.ts'
import type { BookingKind } from './schema.ts'
import { isSelectable, rangeMinutes } from './selection.ts'
import { WeekCalendar, type CalendarDay } from './week-calendar.tsx'

const fieldClass =
  'w-full rounded-sm border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/40 aria-[invalid=true]:border-destructive'
const labelClass = 'block text-sm font-medium text-foreground'

/** Libellés repris par le résumé d'erreurs, identiques à ceux des champs. */
const fieldLabels: Record<string, string> = {
  date: 'Jour',
  startTime: 'Début',
  endTime: 'Fin',
  title: 'Objet',
  clientId: 'Client',
  contractId: 'Contrat',
  discountValue: 'Remise',
  notes: 'Notes',
}

/** Contrat actif proposé au rattachement (R05). */
export type ContractOption = AttachableContract & { id: string; reference: string }

/** Ajoute des minutes à une heure murale « 09:00 », sans quitter la journée. */
function addMinutes(time: string, minutes: number): string {
  const [hour, minute] = time.split(':').map(Number)
  const total = Math.min(hour * 60 + minute + minutes, 23 * 60 + 59)
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

/** Ce qu'il faut d'une réservation existante pour nommer un conflit. */
export type BusyBooking = TimeRange & { id: string; title: string; kind?: BookingKind }

/**
 * Saisie d'une réservation.
 *
 * Les heures sont saisies en heure murale du centre ; la conversion en instants
 * UTC a lieu dans l'action serveur (décision 4).
 *
 * Le créneau se prend au calendrier ou au clavier, indifféremment : les trois
 * champs restent la seule vérité, la grille les écrit et les relit.
 *
 * La disponibilité est annoncée avant l'envoi, à partir des réservations déjà
 * posées — mais elle n'est pas l'autorité : c'est la contrainte d'exclusion qui
 * tranche, et l'action renvoie le nom de la réservation qui occupe la place
 * (décision 3). Un créneau hors ouverture reste saisissable : le staff doit
 * pouvoir ouvrir exceptionnellement une salle un jour férié.
 */
export function BookingForm({
  resource,
  resources,
  days,
  busy,
  timeZone,
  today,
  defaultDate,
  defaultStartTime,
  clients = [],
  defaultClientId,
  contracts = [],
}: {
  /** Ressource affichée par le calendrier ; le choix se fait au-dessus. */
  resource: Resource
  resources: Resource[]
  /** Entreprises clientes, pour rattacher la réservation (ADR 015). */
  clients?: { id: string; name: string }[]
  /** Contrats actifs du centre, proposés selon le client choisi (R05). */
  contracts?: ContractOption[]
  days: CalendarDay[]
  /** Réservations de cette ressource, pour nommer le créneau qui bloque. */
  busy: BusyBooking[]
  timeZone: string
  today: string
  defaultDate: string
  defaultStartTime?: string
  /** Client pré-choisi, quand on vient d'un planning filtré sur lui (ADR 017). */
  defaultClientId?: string
}) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(createBookingAction, null)
  const [date, setDate] = useState(defaultDate)
  const [startTime, setStartTime] = useState(defaultStartTime ?? '09:00')
  const [endTime, setEndTime] = useState(addMinutes(defaultStartTime ?? '09:00', 60))
  // Le contrat dépend du client : les deux sont tenus ici pour que la liste
  // des contrats suive le client choisi.
  const [clientId, setClientId] = useState(defaultClientId ?? '')
  const [contractId, setContractId] = useState('')
  // Prix (R11) : la remise et l'usage interne nourrissent le devis annoncé.
  const [discountKind, setDiscountKind] = useState('')
  const [discountValue, setDiscountValue] = useState('')
  const [internal, setInternal] = useState(false)
  const errors = state?.fieldErrors ?? {}
  const values = state?.values

  const clientContracts = contracts.filter((contract) => contract.clientId === clientId)
  const contract = clientContracts.find((candidate) => candidate.id === contractId)

  const selection = useMemo<TimeRange | undefined>(() => {
    if (!date || !startTime || !endTime || endTime <= startTime) return undefined
    return {
      startsAt: wallClockToUtc(`${date}T${startTime}`, timeZone),
      endsAt: wallClockToUtc(`${date}T${endTime}`, timeZone),
    }
  }, [date, startTime, endTime, timeZone])

  const preview = useQuotePreview({
    enabled: Boolean(selection) && !internal,
    resourceId: resource.id,
    date,
    startTime,
    endTime,
    clientId,
    contractId,
    discountKind,
    discountValue,
  })
  const discountError =
    errors.discountValue ??
    (preview?.status === 'invalid' && preview.field === 'discountValue' ? preview.message : undefined)

  function onSelect(range: TimeRange | undefined) {
    if (!range) return
    setDate(toIsoDate(range.startsAt, timeZone))
    setStartTime(formatTime(range.startsAt, timeZone))
    setEndTime(formatTime(range.endsAt, timeZone))
  }

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

      {/* Remonté après un échec pour reprendre l'objet et les notes saisis :
          React réinitialise les champs non contrôlés à la fin de l'envoi. */}
      <form
        key={JSON.stringify(values ?? {})}
        action={formAction}
        className="flex w-full flex-col gap-5 lg:max-w-sm"
      >
        <ErrorSummary errors={state?.fieldErrors} labels={fieldLabels} message={state?.error} />

        <input type="hidden" name="resourceId" value={resource.id} />

        <AvailabilityVerdict selection={selection} days={days} busy={busy} timeZone={timeZone} />

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
            aria-invalid={errors.date ? true : undefined}
            aria-describedby={errors.date ? 'date-error' : undefined}
            className={`${fieldClass} mt-1`}
          />
          <FieldError name="date" error={errors.date} />
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
                // La fin suit le début tant qu'elle lui est antérieure : la base
                // refuserait un intervalle vide, autant ne pas le proposer.
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
              aria-invalid={errors.endTime ? true : undefined}
              aria-describedby={errors.endTime ? 'endTime-error' : undefined}
              className={`${fieldClass} mt-1 tabular`}
            />
            <FieldError name="endTime" error={errors.endTime} />
          </div>
        </div>
        <p className="-mt-2 text-xs text-muted-foreground">
          Fin exclue : une réservation qui finit à 10h00 laisse le créneau de 10h00 libre.
        </p>

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
            defaultValue={values?.title ?? ''}
            aria-invalid={errors.title ? true : undefined}
            aria-describedby={errors.title ? 'title-error' : undefined}
            className={`${fieldClass} mt-1`}
          />
          <FieldError name="title" error={errors.title} />
        </div>

        {clients.length > 0 && (
          <div>
            <label className={labelClass} htmlFor="clientId">
              Client <span className="font-normal text-muted-foreground">(facultatif)</span>
            </label>
            <select
              id="clientId"
              name="clientId"
              value={clientId}
              onChange={(event) => {
                setClientId(event.target.value)
                // Le contrat d'un autre client ne peut pas rester choisi.
                setContractId('')
              }}
              aria-invalid={errors.clientId ? true : undefined}
              aria-describedby={`clientId-hint${errors.clientId ? ' clientId-error' : ''}`}
              className={`${fieldClass} mt-1`}
            >
              <option value="">Aucun</option>
              {clients.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </select>
            <p id="clientId-hint" className="mt-1 text-xs text-muted-foreground">
              La réservation apparaît dans l’espace de ce client.
            </p>
            <FieldError name="clientId" error={errors.clientId} />
          </div>
        )}

        {clientId && (
          <ContractField
            contracts={clientContracts}
            contract={contract}
            contractId={contractId}
            onChange={setContractId}
            selection={selection}
            clientId={clientId}
            timeZone={timeZone}
            error={errors.contractId}
          />
        )}

        <fieldset className="flex flex-col gap-3 rounded-md border border-border px-4 py-3">
          <legend className="px-1 text-sm font-medium text-foreground">Prix</legend>

          <QuotePanel internal={internal} selection={selection} preview={preview} />

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass} htmlFor="discountKind">
                Remise <span className="font-normal text-muted-foreground">(facultatif)</span>
              </label>
              <select
                id="discountKind"
                name="discountKind"
                value={discountKind}
                disabled={internal}
                onChange={(event) => setDiscountKind(event.target.value)}
                className={`${fieldClass} mt-1 disabled:bg-muted`}
              >
                <option value="">Aucune</option>
                <option value="percent">En pourcentage</option>
                <option value="amount">En euros</option>
              </select>
            </div>
            <div>
              <label className={labelClass} htmlFor="discountValue">
                {discountKind === 'amount' ? 'Montant HT (€)' : 'Taux (%)'}
              </label>
              <input
                id="discountValue"
                name="discountValue"
                inputMode="decimal"
                value={discountValue}
                disabled={internal || discountKind === ''}
                onChange={(event) => setDiscountValue(event.target.value)}
                aria-invalid={discountError ? true : undefined}
                aria-describedby={discountError ? 'discountValue-error' : undefined}
                className={`${fieldClass} mt-1 tabular disabled:bg-muted`}
              />
            </div>
          </div>
          <FieldError name="discountValue" error={discountError} />

          <div className="flex items-start gap-2">
            <input
              id="internal"
              name="internal"
              type="checkbox"
              checked={internal}
              onChange={(event) => setInternal(event.target.checked)}
              aria-describedby="internal-hint"
              className="mt-1"
            />
            <div>
              <label htmlFor="internal" className="text-sm font-medium text-foreground">
                Usage interne : ne pas chiffrer
              </label>
              <p id="internal-hint" className="text-xs text-muted-foreground">
                La réservation n’aura pas de prix et ne sera pas facturée.
              </p>
            </div>
          </div>
        </fieldset>

        <div>
          <label className={labelClass} htmlFor="notes">
            Notes <span className="font-normal text-muted-foreground">(facultatif)</span>
          </label>
          <textarea
            id="notes"
            name="notes"
            rows={3}
            defaultValue={values?.notes ?? ''}
            className={`${fieldClass} mt-1`}
          />
        </div>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={pending}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-hover disabled:opacity-50"
          >
            {pending ? 'Enregistrement…' : 'Réserver'}
          </button>
          <Link
            href={`/reservations?date=${date}`}
            className="text-sm text-muted-foreground hover:underline"
          >
            Annuler
          </Link>
        </div>
      </form>
    </div>
  )
}

/**
 * Devis annoncé avant l'envoi (R11), demandé au serveur — `quote()`, la
 * fonction qui le figera à l'écriture — à chaque changement du créneau, du
 * client, du contrat ou de la remise. Une réponse dépassée par une saisie plus
 * récente est ignorée.
 */
function useQuotePreview(input: {
  enabled: boolean
  resourceId: string
  date: string
  startTime: string
  endTime: string
  clientId: string
  contractId: string
  discountKind: string
  discountValue: string
}): BookingQuotePreview | undefined {
  const key = JSON.stringify(input)
  const [loaded, setLoaded] = useState<{ key: string; preview: BookingQuotePreview }>()

  useEffect(() => {
    if (!input.enabled) return
    let cancelled = false
    // Un court délai : la saisie d'une remise ne lance pas une requête par touche.
    const timer = setTimeout(() => {
      previewBookingQuoteAction(input).then(
        (preview) => {
          if (!cancelled) setLoaded({ key, preview })
        },
        () => {
          if (!cancelled) {
            setLoaded({
              key,
              preview: { status: 'unpriced', message: 'Le montant n’a pas pu être calculé. Réessayez.' },
            })
          }
        },
      )
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // `key` résume toute la saisie : relancer quand elle change, et seulement alors.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return input.enabled && loaded?.key === key ? loaded.preview : undefined
}

/**
 * Montant annoncé : unité, quantité, remise, HT, TVA, TTC. La place est
 * réservée pendant le calcul, pour que le formulaire ne saute pas.
 */
function QuotePanel({
  internal,
  selection,
  preview,
}: {
  internal: boolean
  selection: TimeRange | undefined
  preview: BookingQuotePreview | undefined
}) {
  let content: React.ReactNode
  if (internal) {
    content = <p className="text-muted-foreground">Réservation interne : aucun prix.</p>
  } else if (!selection) {
    content = <p className="text-muted-foreground">Le montant s’affiche une fois le créneau choisi.</p>
  } else if (!preview) {
    content = <p className="text-muted-foreground">Calcul du montant…</p>
  } else if (preview.status === 'priced') {
    content = (
      <>
        <QuoteSummary quote={preview.quote} />
        <p className="mt-2 text-xs text-muted-foreground">
          {quotePlanLabel(preview.quote)}. Montant figé sur la réservation à
          l’enregistrement.
        </p>
      </>
    )
  } else if (preview.status === 'unpriced') {
    content = (
      <p>
        <strong className="font-medium">Non chiffrée</strong> — {preview.message} La réservation
        sera enregistrée sans prix.
      </p>
    )
  } else {
    content = <p className="text-muted-foreground">{preview.message}</p>
  }
  return (
    <div
      aria-live="polite"
      aria-busy={Boolean(selection) && !internal && !preview}
      className="min-h-[7.5rem] rounded-md bg-muted px-3 py-2.5 text-sm"
    >
      {content}
    </div>
  )
}

function FieldError({ name, error }: { name: string; error?: string }) {
  if (!error) return null
  return (
    <p id={`${name}-error`} role="alert" className="mt-1 text-xs text-destructive">
      {error}
    </p>
  )
}

/**
 * Contrat au titre duquel la ressource est réservée (R05) : seuls les contrats
 * actifs du client choisi sont proposés.
 *
 * L'avertissement « hors période » est annoncé avant l'envoi, mais il n'est
 * pas l'autorité : `createBooking` revérifie la règle dans la transaction qui
 * écrit, et l'erreur revient sous ce champ.
 */
function ContractField({
  contracts,
  contract,
  contractId,
  onChange,
  selection,
  clientId,
  timeZone,
  error,
}: {
  contracts: ContractOption[]
  contract: ContractOption | undefined
  contractId: string
  onChange: (contractId: string) => void
  selection: TimeRange | undefined
  clientId: string
  timeZone: string
  error?: string
}) {
  if (contracts.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        Aucun contrat en cours pour ce client : la réservation ne peut pas y être rattachée.
      </p>
    )
  }

  const outside =
    contract && selection
      ? bookingContractProblem(contract, { ...selection, clientId }, timeZone) === 'hors-periode'
      : false
  const describedBy = ['contractId-hint', outside && 'contractId-warning', error && 'contractId-error']
    .filter(Boolean)
    .join(' ')

  return (
    <div>
      <label className={labelClass} htmlFor="contractId">
        Contrat <span className="font-normal text-muted-foreground">(facultatif)</span>
      </label>
      <select
        id="contractId"
        name="contractId"
        value={contractId}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={`${fieldClass} mt-1`}
      >
        <option value="">Aucun</option>
        {contracts.map((option) => (
          <option key={option.id} value={option.id}>
            {option.reference} —{' '}
            {formatContractDays({ firstDay: option.startsOn, lastDay: lastContractDay(option) })}
          </option>
        ))}
      </select>
      <p id="contractId-hint" className="mt-1 text-xs text-muted-foreground">
        Réservation comprise dans un contrat en cours de ce client. Le créneau doit tenir dans sa
        période.
      </p>
      <p id="contractId-warning" aria-live="polite" className="mt-1 text-xs text-foreground empty:hidden">
        {outside && contract
          ? `Attention : le créneau sort de la période du contrat ${contract.reference}. L’enregistrement sera refusé.`
          : ''}
      </p>
      <FieldError name="contractId" error={error} />
    </div>
  )
}

/**
 * Verdict de disponibilité du créneau saisi.
 *
 * Trois cas distincts, et non deux : libre, occupé, ou hors ouverture. Les
 * confondre ferait passer un jour férié pour un conflit, alors que le staff a
 * le droit d'y poser une réservation.
 *
 * Le libellé porte l'information ; la couleur ne fait que la redoubler.
 */
export function AvailabilityVerdict({
  selection,
  days,
  busy,
  timeZone,
}: {
  selection: TimeRange | undefined
  days: CalendarDay[]
  busy: BusyBooking[]
  timeZone: string
}) {
  const box = 'flex items-start gap-2 rounded-md px-3 py-2.5 text-sm'

  if (!selection) {
    return (
      <p aria-live="polite" className={`${box} bg-muted text-muted-foreground`}>
        <ClockIcon size={20} />
        Renseignez un début et une fin, ou choisissez le créneau dans le planning.
      </p>
    )
  }

  const conflicts = busy.filter((booking) => overlaps(selection, booking))
  const cells = days.find((day) => day.isoDate === toIsoDate(selection.startsAt, timeZone))?.cells

  const duree = formatMinutes(rangeMinutes(selection))

  if (conflicts.length > 0) {
    return (
      <p aria-live="polite" className={`${box} bg-statut-conflit/10 text-statut-conflit`}>
        <ClockIcon size={20} />
        <span>
          <strong className="font-medium">Créneau occupé</strong> par{' '}
          {conflicts
            .map((booking) =>
              // Une occupation de contrat se dit par sa période, pas par
              // « 00:00 à 00:00 » (ADR 018).
              booking.kind === 'contract'
                ? describeBusyBooking({ ...booking, kind: 'contract' }, timeZone)
                : `« ${booking.title} » de ${formatTime(booking.startsAt, timeZone)} à ${formatTime(
                    booking.endsAt,
                    timeZone,
                  )}`,
            )
            .join(', ')}
          .
        </span>
      </p>
    )
  }

  if (cells && !isSelectable(selection, cells)) {
    return (
      <p aria-live="polite" className={`${box} bg-accent/10 text-foreground`}>
        <ClockIcon size={20} />
        <span>
          <strong className="font-medium">Hors des heures d’ouverture</strong> — libre, mais en
          dehors du planning habituel. {duree}.
        </span>
      </p>
    )
  }

  return (
    <p aria-live="polite" className={`${box} bg-primary/10 text-foreground`}>
      <CheckIcon size={20} />
      <span>
        <strong className="font-medium">Créneau libre</strong> · {duree}.
      </span>
    </p>
  )
}
