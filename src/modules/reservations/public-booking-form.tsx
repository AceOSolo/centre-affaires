'use client'

import Image from 'next/image'
import { useActionState, useEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react'

import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import { PreuveHumaine, preuveEnCours, preuvePrete } from '../../components/ui/preuve-humaine.tsx'
import { BuildingIcon, CarIcon, CheckIcon } from '../../components/ui/icons.tsx'
import { addDaysToIsoDate, formatLongDate, formatMinutes, formatTime } from '../../lib/dates.ts'
import { QuoteSummary } from '../facturation/devis-resume.tsx'
import { rateUnitSuffixes } from '../facturation/labels.ts'
import type { ProposalStatus } from '../facturation/schema-devis.ts'
import { formatCents, type RateCandidate } from '../facturation/tarifs.ts'
import { resourceTypePluralLabels } from '../ressources/labels.ts'
import type { Resource, ResourceType } from '../ressources/schema.ts'
import { ChampPiege, chipClass, fieldClass, focusClass, primaryClass, RecapBlock, showStep, StepActions, StepHeader } from './etapes-demande.tsx'
import { loadPublicDayAction, loadPublicQuoteAction, requestBookingAction, type PublicDayAvailability, type PublicFormState, type PublicQuote } from './public-actions.ts'
import { availableEnds, availableStarts, fitsFreeRange, publicSelection } from './public-selection.ts'
import { errorsByField, QuestionnaireFields, questionnaireErrorLabels } from './questionnaire-fields.tsx'
import { ANSWER_FIELD_PREFIX, describeAnswers, parseAnswers, type Answers } from './questionnaires.ts'
import { contactRejections, MAX_REQUEST_MINUTES, MIN_REQUEST_MINUTES, rejectionMessages } from './requests.ts'
import { requestPolicyMessage, type RequestPolicy } from './request-policy.ts'

/** Produits réservés sur un créneau du calendrier (ADR 043). */
export type SlotProduct = 'espace' | 'vehicule'

/** Ce qui change d'un produit à l'autre : les mots, l'icône. */
const wording = {
  espace: {
    legend: 'Espace',
    pick: 'Choisissez un espace pour continuer.',
    closed: 'Le centre est fermé ce jour-là.',
    titlePlaceholder: 'Réunion d’équipe, formation…',
    Icon: BuildingIcon,
  },
  vehicule: {
    legend: 'Véhicule',
    pick: 'Choisissez un véhicule pour continuer.',
    closed: 'Le véhicule n’est pas disponible ce jour-là.',
    titlePlaceholder: 'Déménagement, livraison…',
    Icon: CarIcon,
  },
} as const

/**
 * Trois étapes au lieu de cinq. L'espace et son horaire se choisissent d'un
 * même regard ; le « paiement » n'offrait qu'une option possible, le devis, et
 * le récapitulatif tient au-dessus des coordonnées.
 */
const titles = ['Votre créneau', 'Votre besoin', 'Vos coordonnées'] as const
type Step = 1 | 2 | 3
const QUESTIONS_STEP = 2
const CONTACT_STEP = 3

/**
 * Le serveur numérote encore les cinq étapes d'origine (`public-actions.ts`) :
 * espace et créneau (1, 2), besoin (3), coordonnées et envoi (4, 5).
 */
function fromServerStep(step: number | undefined): Step | undefined {
  if (!step) return undefined
  return step <= 2 ? 1 : step === 3 ? QUESTIONS_STEP : CONTACT_STEP
}

const contactFields = [
  { key: 'name', label: 'Nom et prénom', type: 'text', autoComplete: 'name', required: true },
  { key: 'email', label: 'Adresse e-mail', type: 'email', autoComplete: 'email', required: true },
  { key: 'phone', label: 'Téléphone', type: 'tel', autoComplete: 'tel', required: true },
  { key: 'company', label: 'Société', type: 'text', autoComplete: 'organization', required: false },
  { key: 'title', label: 'Objet de la réservation', type: 'text', autoComplete: 'off', required: true },
] as const
type ContactKey = (typeof contactFields)[number]['key']
const contactId = (key: string) => `booking-${key}`
const contactLabels = Object.fromEntries(contactFields.map((field) => [contactId(field.key), field.label]))

/** Jours proposés d'un geste avant de passer par le calendrier. */
const QUICK_DAYS = 6
/** Le jour d'une date murale, lu sans fuseau : midi UTC ne change jamais de date. */
const weekdayFormat = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', timeZone: 'UTC' })
const dayFormat = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short', timeZone: 'UTC' })

/** Erreurs rangées par nom de champ (`q.participants`) ramenées au nom de la question. */
function byQuestion(fieldErrors: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(fieldErrors ?? {}).map(([field, message]) => [field.startsWith(ANSWER_FIELD_PREFIX) ? field.slice(ANSWER_FIELD_PREFIX.length) : field, message]))
}

export type PublicBookingResource = Pick<Resource, 'id' | 'name' | 'resourceType' | 'description' | 'capacity' | 'photoPath' | 'attributes'> & {
  rates: Pick<RateCandidate, 'unit' | 'amountCents'>[]
}

export function PublicBookingForm({ product, resources, timeZone, currency, policy, defaultResourceId, defaultType, defaultDate, minDate, maxDate, defaultStartTime = '', defaultEndTime = '', onClose, onSent }: {
  product: SlotProduct
  /** Ressources du seul produit choisi. */
  resources: PublicBookingResource[]
  timeZone: string
  currency: string
  policy: RequestPolicy
  defaultResourceId?: string
  /** Famille ouverte d'emblée quand aucun espace n'est désigné : salles ou bureaux. */
  defaultType?: ResourceType
  defaultDate: string
  minDate: string
  maxDate: string
  defaultStartTime?: string
  defaultEndTime?: string
  /** Ferme le dialogue qui contient le formulaire. */
  onClose: () => void
  onSent?: () => void
}) {
  const [state, formAction, pending] = useActionState<PublicFormState, FormData>(requestBookingAction, { status: 'idle' })
  const words = wording[product]
  const types = [...new Set(resources.map((item) => item.resourceType))]
  const preselected = resources.find((item) => item.id === defaultResourceId)
  const [type, setType] = useState<ResourceType | undefined>(preselected?.resourceType ?? (defaultType && types.includes(defaultType) ? defaultType : types[0]))
  const ofType = resources.filter((item) => item.resourceType === type)
  // Un seul espace dans la famille : il n'y a rien à choisir.
  const [resourceId, setResourceId] = useState(preselected?.id ?? (ofType.length === 1 ? ofType[0].id : ''))
  const [step, setStep] = useState<Step>(1)
  const [date, setDate] = useState(defaultDate)
  const [startTime, setStartTime] = useState(defaultStartTime)
  const [endTime, setEndTime] = useState(defaultEndTime)
  const [contact, setContact] = useState<Record<ContactKey | 'notes', string>>({ name: '', email: '', phone: '', company: '', title: '', notes: '' })
  // Réponses validées au passage de l'étape « Votre besoin ». Les questions sont
  // des champs non contrôlés, que React réinitialise après chaque envoi : elles
  // repartent de ces valeurs par défaut, un échec ne fait rien retaper.
  const [answers, setAnswers] = useState<Answers>({})
  const [questionErrors, setQuestionErrors] = useState<Record<string, string>>()
  const [contactErrors, setContactErrors] = useState<Record<string, string>>()
  const [localError, setLocalError] = useState('')
  const [showServerError, setShowServerError] = useState(true)
  const [revision, setRevision] = useState(0)
  // Change à chaque réponse du serveur : la case anti-robot repart d'un défi neuf.
  const [essai, setEssai] = useState(0)
  const [loaded, setLoaded] = useState<{ key: string; result: PublicDayAvailability; now: Date }>()
  const [seenState, setSeenState] = useState(state)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const errorRef = useRef<HTMLDivElement>(null)
  const resource = resources.find((item) => item.id === resourceId)
  const availabilityKey = `${resourceId}/${date}/${revision}`
  const availability = loaded?.key === availabilityKey ? loaded.result : undefined
  const free = availability?.status === 'ready' ? availability.free : []
  const selection = publicSelection(date, startTime, endTime, timeZone)
  const duration = selection ? (selection.endsAt.getTime() - selection.startsAt.getTime()) / 60_000 : 0
  const latestStart = availability?.status === 'ready' ? availability.latestStart : undefined
  const validSlot = Boolean(selection && loaded && latestStart && selection.startsAt <= latestStart && selection.startsAt > loaded.now && fitsFreeRange(selection, free) && duration >= MIN_REQUEST_MINUTES && duration <= MAX_REQUEST_MINUTES)
  const starts = availableStarts(free, loaded?.now ?? new Date(0), latestStart)
  const start = startTime && publicSelection(date, startTime, '23:59', timeZone)?.startsAt
  const ends = start ? availableEnds(start, free, timeZone) : []
  const serverError = showServerError && state.status === 'error' ? state : undefined
  const serverStep = fromServerStep(serverError?.step)
  // Les erreurs par champ ont leur propre résumé : pas de double annonce.
  const error = localError || (serverError && !serverError.fieldErrors ? serverError.message : '')
  // Montant du créneau choisi (R11), demandé au moteur de devis du serveur : le même qui le figera sur la demande.
  const quoteKey = validSlot ? `${resourceId}/${date}/${startTime}/${endTime}` : ''
  const [quoteLoaded, setQuoteLoaded] = useState<{ key: string; result: PublicQuote }>()
  const quote = quoteKey && quoteLoaded?.key === quoteKey ? quoteLoaded.result : undefined
  const describedAnswers = describeAnswers(product, answers)
  const quickDays = Array.from({ length: QUICK_DAYS }, (_, index) => addDaysToIsoDate(minDate, index)).filter((day) => day <= maxDate)

  // Réponses refusées par le serveur : retour à l'étape concernée, erreurs en ligne et en résumé.
  if (state !== seenState) {
    setSeenState(state)
    // La réponse anti-robot envoyée est consommée : un calcul neuf pour le prochain envoi.
    setEssai((value) => value + 1)
    if (state.status === 'error' && state.fieldErrors) {
      const at = fromServerStep(state.step) ?? QUESTIONS_STEP
      setStep(at)
      if (at === CONTACT_STEP) setContactErrors(Object.fromEntries(Object.entries(state.fieldErrors).map(([field, message]) => [contactId(field), message])))
      else setQuestionErrors(state.fieldErrors)
    }
  }

  useEffect(() => {
    if (!resourceId || !date || date < minDate || date > maxDate) return
    let cancelled = false
    loadPublicDayAction(resourceId, date).then(
      (result) => { if (!cancelled) setLoaded({ key: availabilityKey, result, now: new Date() }) },
      () => { if (!cancelled) setLoaded({ key: availabilityKey, result: { status: 'error', message: 'Les disponibilités n’ont pas pu être chargées. Réessayez.' }, now: new Date() }) },
    )
    return () => { cancelled = true }
  }, [resourceId, date, minDate, maxDate, availabilityKey])

  useEffect(() => {
    if (!quoteKey) return
    let cancelled = false
    loadPublicQuoteAction(resourceId, date, startTime, endTime).then(
      (result) => { if (!cancelled) setQuoteLoaded({ key: quoteKey, result }) },
      () => { if (!cancelled) setQuoteLoaded({ key: quoteKey, result: { status: 'unpriced', message: 'Le montant n’a pas pu être calculé. Notre équipe vous le précisera.' } }) },
    )
    return () => { cancelled = true }
  }, [quoteKey, resourceId, date, startTime, endTime])

  useEffect(() => { if (error) errorRef.current?.focus() }, [error])
  useEffect(() => {
    if (state.status !== 'sent') return
    headingRef.current?.focus()
    onSent?.()
  }, [state, onSent])

  function goTo(next: Step) {
    setStep(next)
    setLocalError('')
    setShowServerError(false)
    showStep(headingRef)
  }

  function resetSlot() {
    setStartTime('')
    setEndTime('')
    setLocalError('')
    setShowServerError(false)
  }

  function chooseType(next: ResourceType) {
    setType(next)
    const candidates = resources.filter((item) => item.resourceType === next)
    setResourceId(candidates.length === 1 ? candidates[0].id : '')
    resetSlot()
  }

  function chooseResource(id: string) {
    setResourceId(id)
    resetSlot()
  }

  function changeDate(value: string) {
    setDate(value)
    resetSlot()
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    if (pending) { event.preventDefault(); return }
    setLocalError('')
    if (step === 1) {
      event.preventDefault()
      if (!resource) { setLocalError(words.pick); return }
      if (!validSlot) { setLocalError('Choisissez une date et des horaires disponibles pour continuer.'); return }
      goTo(QUESTIONS_STEP)
      return
    }
    if (step === QUESTIONS_STEP) {
      event.preventDefault()
      // Les mêmes règles que le serveur (`parseAnswers`), avant de passer à la suite.
      const parsed = parseAnswers(product, new FormData(event.currentTarget))
      if (Object.keys(parsed.errors).length > 0) { setQuestionErrors(errorsByField(parsed.errors)); return }
      setQuestionErrors(undefined)
      setAnswers(parsed.answers)
      goTo(CONTACT_STEP)
      return
    }
    const rejections: Record<string, string> = Object.fromEntries(Object.entries(contactRejections(contact)).map(([field, rejection]) => [contactId(field), rejectionMessages[rejection]]))
    if (!contact.title.trim()) rejections[contactId('title')] = rejectionMessages['objet-manquant']
    if (Object.keys(rejections).length > 0) { event.preventDefault(); setContactErrors(rejections); return }
    setContactErrors(undefined)
    if (!preuvePrete(event.currentTarget)) { event.preventDefault(); setLocalError(preuveEnCours); return }
    setShowServerError(true)
  }

  if (state.status === 'sent') {
    return (
      <RequestSent headingRef={headingRef} summary={state.summary} proposal={state.proposal} email={contact.email} onClose={onClose}>
        <p className="mt-3 max-w-prose text-sm text-muted-foreground">Le créneau vous est réservé le temps de traiter votre demande. Aucun paiement n’a été effectué.</p>
      </RequestSent>
    )
  }

  return (
    <form action={formAction} onSubmit={handleSubmit} noValidate className="flex min-h-full flex-col">
      <div className="flex-1 px-5 pb-8 pt-5 sm:px-8">
        <StepHeader step={step} titles={titles} headingRef={headingRef} description={step === QUESTIONS_STEP ? 'Quelques questions pour préparer un devis juste. Celles sans mention « facultatif » sont obligatoires.' : undefined} />

        {error && (
          <div ref={errorRef} tabIndex={-1} role="alert" className="mt-5 rounded-sm border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive outline-none focus:ring-2 focus:ring-destructive/30">
            <p>{error}</p>
            {serverStep && serverStep !== step && <button type="button" className={`mt-2 min-h-11 underline ${focusClass}`} onClick={() => { if (serverStep === 1) setRevision((value) => value + 1); goTo(serverStep) }}>Revenir à l’étape « {titles[serverStep - 1]} »</button>}
          </div>
        )}
        {step === QUESTIONS_STEP && questionErrors && <div className="mt-5"><ErrorSummary errors={questionErrors} labels={questionnaireErrorLabels(product)} /></div>}
        {step === CONTACT_STEP && contactErrors && <div className="mt-5"><ErrorSummary errors={contactErrors} labels={contactLabels} /></div>}

        <input type="hidden" name="product" value={product} />
        <input type="hidden" name="resourceId" value={resourceId} />
        <input type="hidden" name="date" value={date} />
        <input type="hidden" name="startTime" value={startTime} />
        <input type="hidden" name="endTime" value={endTime} />
        <input type="hidden" name="paymentMethod" value="quote" />
        <ChampPiege />
        {Object.entries(contact).map(([key, value]) => <input key={key} type="hidden" name={key} value={value} />)}

        {step === 1 && <div className="mt-6 space-y-8">
          {types.length > 1 && (
            <div role="group" aria-label="Type d’espace" className="flex flex-wrap gap-2">
              {types.map((item) => <button key={item} type="button" aria-pressed={type === item} onClick={() => chooseType(item)} className={`min-h-11 rounded-full px-4 ${chipClass(type === item)}`}>{resourceTypePluralLabels[item]}</button>)}
            </div>
          )}

          <fieldset>
            <legend className="text-base font-semibold text-foreground">{words.legend}</legend>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {ofType.map((item) => {
                const checked = resourceId === item.id
                return (
                  <label key={item.id} className="relative flex cursor-pointer">
                    <input type="radio" name="roomChoice" value={item.id} checked={checked} onChange={() => chooseResource(item.id)} className="peer sr-only" />
                    <span className={`flex w-full items-center gap-3 rounded-lg border-2 p-2.5 transition-colors peer-focus-visible:outline-2 peer-focus-visible:outline-offset-4 peer-focus-visible:outline-primary ${checked ? 'border-primary bg-accent/5' : 'border-border hover:border-primary/50'}`}>
                      <span className="relative size-16 shrink-0 overflow-hidden rounded-sm bg-muted">
                        {item.photoPath ? <Image src={item.photoPath} alt="" fill sizes="64px" className="object-cover" /> : <span className="flex h-full items-center justify-center text-primary/50"><words.Icon size={24} /></span>}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium text-primary">{item.name}</span>
                        <span className="mt-0.5 block text-sm text-muted-foreground">{item.capacity ? `${item.capacity} pers. · ` : ''}<FirstRate resource={item} currency={currency} /></span>
                      </span>
                      <span className={`mr-1 flex size-6 shrink-0 items-center justify-center rounded-full border ${checked ? 'border-primary bg-primary text-white' : 'border-border bg-white'}`}>
                        {checked && <><CheckIcon size={16} /><span className="sr-only">Sélectionné</span></>}
                      </span>
                    </span>
                  </label>
                )
              })}
            </div>
          </fieldset>

          <fieldset disabled={!resource} className="disabled:opacity-50">
            <legend className="text-base font-semibold text-foreground">Date</legend>
            <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-6">
              {quickDays.map((day) => {
                const at = new Date(`${day}T12:00:00Z`)
                return (
                  <button key={day} type="button" aria-pressed={date === day} onClick={() => changeDate(day)} className={`flex min-h-16 flex-col items-center justify-center px-2 ${chipClass(date === day)}`}>
                    <span className="text-xs capitalize opacity-80">{weekdayFormat.format(at)}</span>
                    <span className="tabular">{dayFormat.format(at)}</span>
                  </button>
                )
              })}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <label htmlFor="booking-date" className="text-sm text-muted-foreground">Autre date</label>
              <input id="booking-date" type="date" min={minDate} max={maxDate} value={date} onChange={(event) => changeDate(event.target.value)} className={`${fieldClass} min-w-0 sm:max-w-56`} />
            </div>
          </fieldset>

          {resource && <div aria-live="polite" aria-busy={!availability && Boolean(date)}>
            <p className="text-base font-semibold text-foreground first-letter:uppercase">{date >= minDate && date <= maxDate ? formatLongDate(date, timeZone) : 'Horaires'}</p>
            <div className="mt-3">
              {!date || date < minDate || date > maxDate ? <p className="text-sm text-muted-foreground">{requestPolicyMessage(policy)}</p> : !availability ? <p className="min-h-24 rounded-md bg-muted p-5 text-sm text-muted-foreground">Recherche des horaires libres…</p> : availability.status === 'error' ? (
                <div className="rounded-md border border-border p-4 text-sm"><p>{availability.message}</p><button type="button" onClick={() => setRevision((value) => value + 1)} className={`mt-2 min-h-11 text-primary underline ${focusClass}`}>Réessayer</button></div>
              ) : !starts.length ? (
                <div className="min-h-24 rounded-md border border-dashed border-border bg-muted p-5"><p className="font-medium text-primary">{availability.closed ? words.closed : 'Plus de créneau libre ce jour-là.'}</p>{date < maxDate && <button type="button" onClick={() => changeDate(addDaysToIsoDate(date, 1))} className={`mt-2 min-h-11 text-sm font-medium text-primary underline ${focusClass}`}>Voir le jour suivant</button>}</div>
              ) : <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="booking-start" className="block text-sm font-medium">Arrivée</label>
                  <select id="booking-start" value={startTime} onChange={(event) => { setStartTime(event.target.value); setEndTime(''); setLocalError('') }} className={`${fieldClass} mt-2`}>
                    <option value="">Choisir une heure</option>
                    {starts.map((at) => <option key={at.toISOString()} value={formatTime(at, timeZone)}>{formatTime(at, timeZone)}</option>)}
                  </select>
                </div>
                <div>
                  <label htmlFor="booking-end" className="block text-sm font-medium">Départ</label>
                  <select id="booking-end" value={endTime} disabled={!startTime} onChange={(event) => { setEndTime(event.target.value); setLocalError('') }} className={`${fieldClass} mt-2 disabled:bg-muted disabled:text-muted-foreground`}>
                    <option value="">{startTime ? 'Choisir une heure' : 'Choisissez d’abord l’arrivée'}</option>
                    {ends.map((at) => <option key={at.toISOString()} value={formatTime(at, timeZone)}>{formatTime(at, timeZone)} · {formatMinutes((at.getTime() - (start ? start.getTime() : 0)) / 60_000)}</option>)}
                  </select>
                </div>
                <p className="text-xs text-muted-foreground sm:col-span-2">Seuls les horaires libres sont proposés, de 30 minutes à 8 heures. {requestPolicyMessage(policy)}</p>
              </div>}
            </div>
            {!!startTime && !!endTime && availability?.status === 'ready' && !validSlot && <p role="alert" className="mt-3 text-sm text-destructive">Ces horaires ne sont plus disponibles. Choisissez un autre créneau.</p>}
          </div>}

          {validSlot && <div className="rounded-lg bg-muted p-5">
            <p className="flex items-center gap-2 font-medium text-primary"><CheckIcon size={20} className="shrink-0" />{resource?.name} · <span className="tabular">{startTime} – {endTime}</span> · {formatMinutes(duration)}</p>
            <div className="mt-3 border-t border-border pt-3"><QuoteAmount quote={quote} /></div>
          </div>}
        </div>}

        {/* Toujours montées : des champs non contrôlés démontés ne partiraient pas avec la demande. */}
        <div hidden={step !== QUESTIONS_STEP} className="mt-6">
          <QuestionnaireFields key={JSON.stringify(answers)} product={product} defaults={answers} errors={byQuestion(questionErrors)} />
        </div>

        {step === CONTACT_STEP && <div className="mt-6 space-y-6">
          <RecapBlock title="Votre créneau" onEdit={() => goTo(1)} pending={pending}>
            <p className="font-semibold text-primary">{resource?.name}</p>
            <p className="mt-1 first-letter:uppercase">{formatLongDate(date, timeZone)}</p>
            <p className="mt-0.5 tabular">{startTime} – {endTime} · {formatMinutes(duration)}</p>
            <div className="mt-3 border-t border-border pt-3"><QuoteAmount quote={quote} live={false} /></div>
          </RecapBlock>
          {describedAnswers.length > 0 && (
            <RecapBlock title="Votre besoin" onEdit={() => goTo(QUESTIONS_STEP)} pending={pending}>
              <dl className="space-y-1">
                {describedAnswers.map((answer) => <div key={answer.label}><dt className="inline text-muted-foreground">{answer.label} : </dt><dd className="inline break-words">{answer.value}</dd></div>)}
              </dl>
            </RecapBlock>
          )}

          <div className="grid gap-5 sm:grid-cols-2">
            {contactFields.map((field) => {
              const id = contactId(field.key)
              const fieldError = contactErrors?.[id]
              return (
                <div key={field.key}>
                  <label htmlFor={id} className="block text-sm font-medium">{field.label}{!field.required && <span className="font-normal text-muted-foreground"> (facultatif)</span>}</label>
                  <input id={id} type={field.type} autoComplete={field.autoComplete} required={field.required} maxLength={field.key === 'phone' ? 40 : 200} placeholder={field.key === 'title' ? words.titlePlaceholder : undefined} aria-invalid={fieldError ? true : undefined} aria-describedby={fieldError ? `${id}-error` : undefined} value={contact[field.key]} onChange={(event) => setContact({ ...contact, [field.key]: event.target.value })} className={`${fieldClass} mt-2`} />
                  {fieldError && <p id={`${id}-error`} className="mt-1.5 text-sm text-destructive">{fieldError}</p>}
                </div>
              )
            })}
            <div className="sm:col-span-2">
              <label htmlFor="booking-notes" className="block text-sm font-medium">Précisions <span className="font-normal text-muted-foreground">(facultatif)</span></label>
              <textarea id="booking-notes" rows={3} maxLength={2000} value={contact.notes} onChange={(event) => setContact({ ...contact, notes: event.target.value })} className={`${fieldClass} mt-2`} />
            </div>
          </div>

          <PreuveHumaine key={essai} />

          <p className="text-sm text-muted-foreground">Nous vous envoyons un devis par e-mail, sans engagement. Aucun paiement maintenant : le créneau vous est réservé le temps de traiter votre demande.</p>
        </div>}
      </div>

      <StepActions
        onBack={step > 1 ? () => goTo((step - 1) as Step) : undefined}
        pending={pending}
        disabled={step === 1 && !validSlot}
        label={step === CONTACT_STEP ? 'Demander mon devis' : 'Continuer'}
        last={step === CONTACT_STEP}
        hint="Aucun paiement à cette étape"
      />
    </form>
  )
}

/**
 * Confirmation d'une demande publique, avec le numéro du devis né avec elle
 * (ADR 043) et ce qui se passe ensuite : un devis prêt part seul vers le
 * demandeur, un brouillon passe d'abord par l'accueil.
 */
export function RequestSent({ headingRef, summary, proposal, email, onClose, children }: {
  headingRef: RefObject<HTMLHeadingElement | null>
  summary: string
  proposal?: { number: string; status: ProposalStatus }
  email: string
  /** Ferme le dialogue de réservation. */
  onClose: () => void
  children?: ReactNode
}) {
  return (
    <div className="p-6 sm:p-10" role="status">
      <span className="flex size-12 items-center justify-center rounded-full bg-primary text-white"><CheckIcon size={24} /></span>
      <h3 ref={headingRef} tabIndex={-1} className="mt-5 text-2xl font-semibold tracking-tight text-primary outline-none">Votre demande de devis est envoyée</h3>
      <p className="mt-3 font-medium">{summary}</p>
      {proposal ? (
        <p className="mt-4 max-w-prose text-muted-foreground">
          {proposal.status === 'ready'
            ? <>Votre devis <strong className="font-medium text-foreground tabular">{proposal.number}</strong> vous sera envoyé par courriel</>
            : <>Notre équipe vérifie votre demande et vous envoie votre devis <strong className="font-medium text-foreground tabular">{proposal.number}</strong></>}
          {' '}à <strong className="break-all font-medium text-foreground">{email}</strong>{proposal.status === 'ready' ? '.' : ', en général sous un jour ouvré.'}
        </p>
      ) : (
        <p className="mt-4 max-w-prose text-muted-foreground">Notre équipe préparera votre devis et vous répondra à <strong className="break-all font-medium text-foreground">{email}</strong>, en général sous un jour ouvré.</p>
      )}
      {children}
      <button type="button" onClick={onClose} className={`${primaryClass} mt-8`}>Fermer</button>
    </div>
  )
}

/**
 * Montant du créneau : HT, TVA, TTC, et le détail de l'unité retenue. La
 * place est tenue pendant le calcul ; un créneau que la grille ne tarife pas
 * le dit, sans inventer de prix.
 */
function QuoteAmount({ quote, live = true }: { quote?: PublicQuote; live?: boolean }) {
  return (
    <div aria-live={live ? 'polite' : undefined} aria-busy={live ? !quote : undefined} className="min-h-[5rem] text-sm">
      {!quote ? <p className="text-muted-foreground">Calcul du montant…</p>
        : quote.status === 'unpriced' ? <p className="text-muted-foreground">{quote.message}</p>
        : <>
          <QuoteSummary quote={quote.quote} />
          <p className="mt-2 text-xs text-muted-foreground">{quote.fromContract ? 'Tarif de votre contrat. ' : ''}Montant retenu sur votre demande, confirmé par notre équipe.</p>
        </>}
    </div>
  )
}

/** Le tarif le plus fin de l'espace : c'est « à partir de combien » qu'on cherche. */
function FirstRate({ resource, currency }: { resource: PublicBookingResource; currency: string }) {
  const rate = resource.rates[0]
  return rate ? <span className="tabular">{formatCents(rate.amountCents, currency)} HT {rateUnitSuffixes[rate.unit]}</span> : <>Tarif sur devis</>
}
