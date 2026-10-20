'use client'

import Image from 'next/image'
import { useActionState, useEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react'

import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import { ArrowRightIcon, BuildingIcon, CalendarIcon, CarIcon, CheckIcon, ClockIcon, CreditCardIcon, FileTextIcon, UsersIcon } from '../../components/ui/icons.tsx'
import { addDaysToIsoDate, formatLongDate, formatMinutes, formatTime } from '../../lib/dates.ts'
import { QuoteSummary } from '../facturation/devis-resume.tsx'
import { rateUnitSuffixes } from '../facturation/labels.ts'
import type { ProposalStatus } from '../facturation/schema-devis.ts'
import { formatCents, type RateCandidate } from '../facturation/tarifs.ts'
import { describeAttributes, resourceTypeLabels } from '../ressources/labels.ts'
import type { Resource } from '../ressources/schema.ts'
import { loadPublicDayAction, loadPublicQuoteAction, requestBookingAction, type PublicDayAvailability, type PublicFormState, type PublicQuote } from './public-actions.ts'
import { availableEnds, availableStarts, fitsFreeRange, publicSelection } from './public-selection.ts'
import { errorsByField, QuestionnaireFields, questionnaireErrorLabels } from './questionnaire-fields.tsx'
import { ANSWER_FIELD_PREFIX, describeAnswers, parseAnswers, type Answers } from './questionnaires.ts'
import { contactRejections, MAX_REQUEST_MINUTES, MIN_REQUEST_MINUTES, rejectionMessages } from './requests.ts'
import { requestPolicyMessage, type RequestPolicy } from './request-policy.ts'

const fieldClass = 'w-full min-h-12 rounded-sm border border-border bg-background px-3 py-2.5 text-base outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-accent/40'
const focusClass = 'focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary'
const primaryClass = `inline-flex min-h-12 items-center justify-center gap-2 rounded-md bg-primary px-5 py-3 font-medium text-primary-foreground transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50 ${focusClass}`

/** Produits réservés sur un créneau du calendrier (ADR 043). */
export type SlotProduct = 'espace' | 'vehicule'

/** Ce qui change d'un produit à l'autre : les mots, l'icône. */
const wording = {
  espace: {
    label: 'Salle',
    title: 'Choisissez votre salle',
    description: 'Comparez les espaces et sélectionnez celui qui vous convient.',
    legend: 'Salle à réserver',
    pick: 'Sélectionnez une salle pour continuer.',
    closed: 'L’espace est fermé ce jour-là.',
    other: 'Choisissez une autre date ou un autre espace.',
    who: 'À qui réserver la salle ?',
    titlePlaceholder: 'Réunion d’équipe, formation…',
    rate: 'Tarif de l’espace',
    Icon: BuildingIcon,
  },
  vehicule: {
    label: 'Véhicule',
    title: 'Choisissez votre véhicule',
    description: 'Comparez les véhicules et sélectionnez celui qui vous convient.',
    legend: 'Véhicule à réserver',
    pick: 'Sélectionnez un véhicule pour continuer.',
    closed: 'Le véhicule n’est pas disponible ce jour-là.',
    other: 'Choisissez une autre date ou un autre véhicule.',
    who: 'À qui réserver le véhicule ?',
    titlePlaceholder: 'Déménagement, livraison…',
    rate: 'Tarif du véhicule',
    Icon: CarIcon,
  },
} as const

function stepsFor(product: SlotProduct) {
  const words = wording[product]
  return [
    { label: words.label, title: words.title, description: words.description },
    { label: 'Créneau', title: 'Quand souhaitez-vous venir ?', description: 'Choisissez une date, puis vos heures de début et de fin.' },
    { label: 'Votre besoin', title: 'Parlez-nous de votre besoin', description: 'Ces réponses nous permettent de préparer un devis juste.' },
    { label: 'Vos infos', title: words.who, description: 'Ces coordonnées permettront à notre équipe de vous répondre.' },
    { label: 'Paiement', title: 'Comment souhaitez-vous réserver ?', description: 'Vérifiez votre sélection, puis choisissez comment poursuivre.' },
  ] as const
}
type Step = 1 | 2 | 3 | 4 | 5
const QUESTIONS_STEP = 3
const CONTACT_STEP = 4
const LAST_STEP = 5

/** Erreurs rangées par nom de champ (`q.participants`) ramenées au nom de la question. */
function byQuestion(fieldErrors: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(fieldErrors ?? {}).map(([field, message]) => [field.startsWith(ANSWER_FIELD_PREFIX) ? field.slice(ANSWER_FIELD_PREFIX.length) : field, message]))
}

export type PublicBookingResource = Pick<Resource, 'id' | 'name' | 'resourceType' | 'description' | 'capacity' | 'photoPath' | 'attributes'> & {
  rates: Pick<RateCandidate, 'unit' | 'amountCents'>[]
}

export function PublicBookingForm({ product, resources, timeZone, currency, policy, defaultResourceId, defaultDate, minDate, maxDate, defaultStartTime = '', defaultEndTime = '' }: {
  product: SlotProduct
  /** Ressources du seul produit choisi. */
  resources: PublicBookingResource[]
  timeZone: string
  currency: string
  policy: RequestPolicy
  defaultResourceId?: string
  defaultDate: string
  minDate: string
  maxDate: string
  defaultStartTime?: string
  defaultEndTime?: string
}) {
  const [state, formAction, pending] = useActionState<PublicFormState, FormData>(requestBookingAction, { status: 'idle' })
  const steps = stepsFor(product)
  const words = wording[product]
  const [step, setStep] = useState<Step>(1)
  const [resourceId, setResourceId] = useState(defaultResourceId ?? '')
  const [showAllSpaces, setShowAllSpaces] = useState(
    !resources.some((item) => item.resourceType === 'salle') || Boolean(defaultResourceId && resources.find((item) => item.id === defaultResourceId)?.resourceType !== 'salle'),
  )
  const [date, setDate] = useState(defaultDate)
  const [startTime, setStartTime] = useState(defaultStartTime)
  const [endTime, setEndTime] = useState(defaultEndTime)
  const [contact, setContact] = useState({ name: '', email: '', phone: '', company: '', title: '', notes: '' })
  // Réponses validées au passage de l'étape « Votre besoin ». Les questions sont
  // des champs non contrôlés, que React réinitialise après chaque envoi : elles
  // repartent de ces valeurs par défaut, un échec ne fait rien retaper.
  const [answers, setAnswers] = useState<Answers>({})
  const [questionErrors, setQuestionErrors] = useState<Record<string, string>>()
  const [localError, setLocalError] = useState('')
  const [showServerError, setShowServerError] = useState(true)
  const [revision, setRevision] = useState(0)
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
  // Les erreurs par champ ont leur résumé à l'étape des questions : pas de double annonce.
  const error = localError || (showServerError && state.status === 'error' && !state.fieldErrors ? state.message : '')
  // Montant du créneau choisi (R11), demandé au moteur de devis du serveur : le même qui le figera sur la demande.
  const quoteKey = validSlot ? `${resourceId}/${date}/${startTime}/${endTime}` : ''
  const [quoteLoaded, setQuoteLoaded] = useState<{ key: string; result: PublicQuote }>()
  const quote = quoteKey && quoteLoaded?.key === quoteKey ? quoteLoaded.result : undefined
  const describedAnswers = describeAnswers(product, answers)

  // Réponses refusées par le serveur : retour à l'étape des questions, erreurs en ligne et en résumé.
  if (state !== seenState) {
    setSeenState(state)
    if (state.status === 'error' && state.fieldErrors) {
      setStep(state.step ?? QUESTIONS_STEP)
      setQuestionErrors(state.fieldErrors)
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
  useEffect(() => { if (state.status === 'sent') headingRef.current?.focus() }, [state])

  function goTo(next: Step) {
    setStep(next)
    setLocalError('')
    setShowServerError(false)
    requestAnimationFrame(() => {
      headingRef.current?.focus({ preventScroll: true })
      headingRef.current?.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
    })
  }

  function changeDate(value: string) {
    setDate(value)
    setStartTime('')
    setEndTime('')
    setLocalError('')
    setShowServerError(false)
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    if (pending) { event.preventDefault(); return }
    setLocalError('')
    if (step < LAST_STEP) {
      event.preventDefault()
      if (step === 1 && !resource) { setLocalError(words.pick); return }
      if (step === 2 && !validSlot) { setLocalError('Choisissez une date et des horaires disponibles pour continuer.'); return }
      if (step === QUESTIONS_STEP) {
        // Les mêmes règles que le serveur (`parseAnswers`), avant de passer à la suite.
        const parsed = parseAnswers(product, new FormData(event.currentTarget))
        if (Object.keys(parsed.errors).length > 0) { setQuestionErrors(errorsByField(parsed.errors)); return }
        setQuestionErrors(undefined)
        setAnswers(parsed.answers)
      }
      if (step === CONTACT_STEP) {
        const rejection = Object.values(contactRejections(contact))[0]
        if (rejection || !contact.title.trim()) {
          setLocalError(rejection ? rejectionMessages[rejection] : rejectionMessages['objet-manquant']); return
        }
      }
      goTo((step + 1) as Step)
      return
    }
    setShowServerError(true)
  }

  if (state.status === 'sent') {
    return (
      <RequestSent headingRef={headingRef} summary={state.summary} proposal={state.proposal} email={contact.email}>
        <p className="mt-3 text-sm text-muted-foreground">Le créneau est bloqué provisoirement pendant le traitement de votre demande. Aucun paiement n’a été effectué.</p>
      </RequestSent>
    )
  }

  return (
    <div data-booking-active={step > 1} className="overflow-hidden rounded-xl border border-border bg-background">
      <nav aria-label="Étapes de la réservation" className="border-b border-border bg-muted/60 px-3 py-5 sm:px-8">
        <ol className="grid grid-cols-5 gap-1 sm:gap-4">
          {steps.map((item, index) => {
            const number = (index + 1) as Step
            return (
              <li key={item.label}>
                <button type="button" aria-current={step === number ? 'step' : undefined} disabled={number > step || pending} onClick={() => goTo(number)} className={`flex min-h-12 w-full flex-col items-center gap-2 rounded-md text-center text-xs font-medium sm:flex-row sm:text-left sm:text-sm ${focusClass} disabled:cursor-not-allowed ${number <= step ? 'text-primary' : 'text-muted-foreground'}`}>
                  <span className={`flex size-8 shrink-0 items-center justify-center rounded-full border text-sm ${step === number ? 'border-primary bg-primary text-white' : number < step ? 'border-primary bg-accent/10' : 'border-border bg-background'}`}>
                    {number < step ? <><CheckIcon size={18} /><span className="sr-only">Étape {number} terminée</span></> : number}
                  </span>
                  {item.label}
                </button>
              </li>
            )
          })}
        </ol>
      </nav>

      <div className="grid lg:grid-cols-[minmax(0,1fr)_300px]">
        <form action={formAction} onSubmit={handleSubmit} noValidate className="min-w-0 p-5 sm:p-8">
          <div className="mb-6">
            <p className="mb-2 text-sm font-medium text-primary">Étape {step} sur {LAST_STEP}</p>
            <h3 ref={headingRef} tabIndex={-1} className="scroll-mt-40 text-2xl font-semibold tracking-tight text-primary outline-none sm:scroll-mt-28">{steps[step - 1].title}</h3>
            <p className="mt-2 text-sm text-muted-foreground">{steps[step - 1].description}</p>
          </div>
          {error && (
            <div ref={errorRef} tabIndex={-1} role="alert" className="mb-5 rounded-sm border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive outline-none focus:ring-2 focus:ring-destructive/30">
              <p>{error}</p>
              {showServerError && state.status === 'error' && state.step && state.step !== step && <button type="button" className={`mt-2 min-h-11 underline ${focusClass}`} onClick={() => { if (state.step === 2) setRevision((value) => value + 1); goTo(state.step ?? 2) }}>Revenir à l’étape {state.step} pour corriger</button>}
            </div>
          )}
          {step === QUESTIONS_STEP && questionErrors && (
            <div className="mb-5">
              <ErrorSummary errors={questionErrors} labels={questionnaireErrorLabels(product)} />
            </div>
          )}
          <input type="hidden" name="product" value={product} />
          <input type="hidden" name="resourceId" value={resourceId} />
          <input type="hidden" name="date" value={date} />
          <input type="hidden" name="startTime" value={startTime} />
          <input type="hidden" name="endTime" value={endTime} />
          <input type="hidden" name="paymentMethod" value="quote" />
          {Object.entries(contact).map(([key, value]) => <input key={key} type="hidden" name={key} value={value} />)}

          {step === 1 && <fieldset>
            <legend className="sr-only">{words.legend}</legend>
            {resources.some((item) => item.resourceType === 'salle') && resources.some((item) => item.resourceType !== 'salle') && (
              <div className="mb-5 flex flex-wrap gap-2" aria-label="Types d’espaces">
                {[{ label: 'Salles de réunion', all: false }, { label: 'Tous les espaces', all: true }].map((filter) => (
                  <button key={filter.label} type="button" aria-pressed={showAllSpaces === filter.all} onClick={() => {
                    setShowAllSpaces(filter.all)
                    if (!filter.all && resource?.resourceType !== 'salle') { setResourceId(''); setStartTime(''); setEndTime('') }
                  }} className={`min-h-11 rounded-md border px-4 text-sm font-medium ${focusClass} ${showAllSpaces === filter.all ? 'border-primary bg-accent/10 text-primary' : 'border-border text-muted-foreground hover:border-primary'}`}>{filter.label}</button>
                ))}
              </div>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              {resources.filter((item) => showAllSpaces || item.resourceType === 'salle').map((item) => <label key={item.id} className="relative flex cursor-pointer">
                <input type="radio" name="roomChoice" value={item.id} checked={resourceId === item.id} onChange={() => { setResourceId(item.id); setStartTime(''); setEndTime(''); setLocalError('') }} className="peer sr-only" />
                <span className={`flex w-full flex-col overflow-hidden rounded-lg border-2 transition-colors peer-focus-visible:outline-2 peer-focus-visible:outline-offset-4 peer-focus-visible:outline-primary ${resourceId === item.id ? 'border-primary bg-accent/5' : 'border-border hover:border-primary/50'}`}>
                  <span className="relative block h-32 bg-muted">
                    {item.photoPath ? <Image src={item.photoPath} alt="" fill sizes="(max-width: 640px) 90vw, 340px" className="object-cover" /> : <span className="flex h-full items-center justify-center text-primary/40"><words.Icon size={40} /></span>}
                    <span className={`absolute right-3 top-3 flex size-7 items-center justify-center rounded-full border ${resourceId === item.id ? 'border-primary bg-primary text-white' : 'border-border bg-white'}`}>{resourceId === item.id && <CheckIcon size={18} />}</span>
                  </span>
                  <span className="flex flex-1 flex-col p-4">
                    <span className="text-xs text-muted-foreground">{resourceTypeLabels[item.resourceType]}</span>
                    <span className="mt-1 text-lg font-semibold text-primary">{item.name}</span>
                    {!!item.capacity && <span className="mt-2 flex items-center gap-2 text-sm"><UsersIcon size={18} />Jusqu’à {item.capacity} personnes</span>}
                    {item.description && <span className="mt-2 hidden text-sm text-muted-foreground sm:line-clamp-2">{item.description}</span>}
                    {describeAttributes(item.attributes) && <span className="mt-2 hidden text-xs text-muted-foreground sm:line-clamp-2">{describeAttributes(item.attributes)}</span>}
                    <span className="mt-auto block pt-4 text-sm font-medium text-primary"><Rates resource={item} currency={currency} /></span>
                  </span>
                </span>
              </label>)}
            </div>
          </fieldset>}

          {step === 2 && <div className="space-y-6">
            <p className="text-sm text-muted-foreground">{requestPolicyMessage(policy)}</p>
            <div className="flex items-center gap-3 rounded-md bg-muted p-4 text-sm"><words.Icon className="shrink-0 text-primary" /><span className="font-medium">{resource?.name}</span><button type="button" onClick={() => goTo(1)} className={`ml-auto min-h-11 text-primary underline ${focusClass}`}>Changer</button></div>
            <div>
              <label htmlFor="booking-date" className="block text-sm font-medium">Date de votre réservation</label>
              <input id="booking-date" type="date" required min={minDate} max={maxDate} value={date} onChange={(event) => changeDate(event.target.value)} className={`${fieldClass} mt-2 sm:max-w-xs`} />
              <div className="mt-3 flex flex-wrap gap-2">
                {[{ value: minDate, label: 'Première date possible' }, { value: addDaysToIsoDate(minDate, 1), label: 'Jour suivant' }].filter((day) => day.value <= maxDate).map((day) => <button key={day.value} type="button" aria-pressed={date === day.value} onClick={() => changeDate(day.value)} className={`min-h-11 rounded-md border px-4 text-sm ${focusClass} ${date === day.value ? 'border-primary bg-accent/10 text-primary' : 'border-border text-muted-foreground hover:border-primary'}`}>{day.label}</button>)}
              </div>
            </div>
            <div aria-live="polite" aria-busy={!availability && Boolean(date)}>
              {!date || date < minDate || date > maxDate ? <p className="text-sm text-muted-foreground">{requestPolicyMessage(policy)}</p> : !availability ? <p className="rounded-md bg-muted p-5 text-sm text-muted-foreground">Recherche des horaires disponibles…</p> : availability.status === 'error' ? (
                <div className="rounded-md border border-border p-4 text-sm"><p>{availability.message}</p><button type="button" onClick={() => setRevision((value) => value + 1)} className={`mt-2 min-h-11 text-primary underline ${focusClass}`}>Réessayer</button></div>
              ) : !starts.length ? (
                <div className="rounded-md border border-dashed border-border bg-muted p-5"><p className="font-medium text-primary">{availability.closed ? words.closed : 'Aucun créneau disponible ce jour-là.'}</p><p className="mt-2 text-sm text-muted-foreground">{words.other}</p>{date < maxDate && <button type="button" onClick={() => changeDate(addDaysToIsoDate(date, 1))} className={`mt-3 min-h-11 text-sm font-medium text-primary underline ${focusClass}`}>Voir le jour suivant</button>}</div>
              ) : <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="booking-start" className="block text-sm font-medium">Heure de début</label>
                  <select id="booking-start" value={startTime} required onChange={(event) => { setStartTime(event.target.value); setEndTime(''); setLocalError('') }} className={`${fieldClass} mt-2`}>
                    <option value="">Choisir une heure</option>
                    {starts.map((at) => <option key={at.toISOString()} value={formatTime(at, timeZone)}>{formatTime(at, timeZone)}</option>)}
                  </select>
                </div>
                <div>
                  <label htmlFor="booking-end" className="block text-sm font-medium">Heure de fin</label>
                  <select id="booking-end" value={endTime} required disabled={!startTime} onChange={(event) => { setEndTime(event.target.value); setLocalError('') }} className={`${fieldClass} mt-2 disabled:bg-muted disabled:text-muted-foreground`}>
                    <option value="">{startTime ? 'Choisir une heure' : 'Choisissez d’abord le début'}</option>
                    {ends.map((at) => <option key={at.toISOString()} value={formatTime(at, timeZone)}>{formatTime(at, timeZone)} · {formatMinutes((at.getTime() - (start ? start.getTime() : 0)) / 60_000)}</option>)}
                  </select>
                </div>
                <p className="text-xs text-muted-foreground sm:col-span-2">Seuls les horaires disponibles sont proposés. De 30 minutes à 8 heures, heures du centre ({timeZone}).</p>
              </div>}
            </div>
            {validSlot && <p className="flex items-center gap-2 rounded-md bg-accent/10 p-4 text-sm font-medium text-primary"><CheckIcon className="shrink-0" />{startTime} – {endTime} · {formatMinutes(duration)}</p>}
            {validSlot && <div className="rounded-md border border-border p-4"><p className="mb-2 text-sm font-medium">Montant de votre réservation</p><QuoteAmount quote={quote} /></div>}
            {!!startTime && !!endTime && availability?.status === 'ready' && !validSlot && <p role="alert" className="text-sm text-destructive">Ces horaires ne sont plus disponibles. Sélectionnez un nouveau créneau.</p>}
          </div>}

          {/* Toujours montées : des champs non contrôlés démontés ne partiraient pas avec la demande. */}
          <div hidden={step !== QUESTIONS_STEP}>
            <p className="mb-5 text-sm text-muted-foreground">Les questions sans mention « facultatif » sont obligatoires.</p>
            <QuestionnaireFields key={JSON.stringify(answers)} product={product} defaults={answers} errors={byQuestion(questionErrors)} />
          </div>

          {step === CONTACT_STEP && <div className="grid gap-5 sm:grid-cols-2">
            <p className="text-sm text-muted-foreground sm:col-span-2">Tous les champs sont obligatoires, sauf la société et les précisions.</p>
            {[
              { key: 'name', label: 'Nom et prénom', type: 'text', autoComplete: 'name', placeholder: 'Camille Dupont', required: true },
              { key: 'email', label: 'Adresse e-mail', type: 'email', autoComplete: 'email', placeholder: 'camille@entreprise.fr', required: true },
              { key: 'phone', label: 'Téléphone', type: 'tel', autoComplete: 'tel', placeholder: '06 12 34 56 78', required: true },
              { key: 'company', label: 'Société', type: 'text', autoComplete: 'organization', placeholder: 'Votre entreprise', required: false },
              { key: 'title', label: 'Objet de la réservation', type: 'text', autoComplete: 'off', placeholder: words.titlePlaceholder, required: true },
            ].map((field) => <div key={field.key}>
              <label htmlFor={`booking-${field.key}`} className="block text-sm font-medium">{field.label}{!field.required && <span className="font-normal text-muted-foreground"> (facultatif)</span>}</label>
              <input id={`booking-${field.key}`} type={field.type} autoComplete={field.autoComplete} placeholder={field.placeholder} required={field.required} maxLength={field.key === 'phone' ? 40 : 200} value={contact[field.key as keyof typeof contact]} onChange={(event) => setContact({ ...contact, [field.key]: event.target.value })} className={`${fieldClass} mt-2`} />
            </div>)}
            <div className="sm:col-span-2">
              <label htmlFor="booking-notes" className="block text-sm font-medium">Précisions <span className="font-normal text-muted-foreground">(facultatif)</span></label>
              <textarea id="booking-notes" rows={3} maxLength={2000} value={contact.notes} onChange={(event) => setContact({ ...contact, notes: event.target.value })} placeholder="Une question, un besoin particulier…" className={`${fieldClass} mt-2`} />
            </div>
          </div>}

          {step === LAST_STEP && <div className="space-y-5">
            <div className="rounded-md bg-muted p-4 text-sm lg:hidden">
              <p className="font-semibold text-primary">{resource?.name}</p>
              <p className="mt-2 capitalize">{formatLongDate(date, timeZone)}</p>
              <p className="mt-1">{startTime} – {endTime} · {formatMinutes(duration)}</p>
              <div className="mt-3 border-t border-border pt-3"><QuoteAmount quote={quote} /></div>
              <button type="button" disabled={pending} onClick={() => goTo(2)} className={`mt-2 min-h-11 text-primary underline ${focusClass}`}>Modifier le créneau</button>
            </div>
            {describedAnswers.length > 0 && (
              <div className="rounded-md border border-border p-4 text-sm">
                <div className="flex items-start justify-between gap-3"><p className="font-medium">Votre besoin</p><button type="button" onClick={() => goTo(QUESTIONS_STEP)} disabled={pending} className={`min-h-11 text-primary underline ${focusClass}`}>Modifier</button></div>
                <dl className="space-y-1">
                  {describedAnswers.map((answer) => <div key={answer.label}><dt className="inline text-muted-foreground">{answer.label} : </dt><dd className="inline break-words">{answer.value}</dd></div>)}
                </dl>
              </div>
            )}
            <div className="rounded-md border border-border p-4 text-sm">
              <div className="flex items-start justify-between gap-3"><p className="font-medium">Vos coordonnées</p><button type="button" onClick={() => goTo(CONTACT_STEP)} disabled={pending} className={`min-h-11 text-primary underline ${focusClass}`}>Modifier</button></div>
              <p>{contact.name}{contact.company && <span className="text-muted-foreground"> · {contact.company}</span>}</p><p className="mt-1 break-all text-muted-foreground">{contact.email} · {contact.phone}</p>
              <p className="mt-3 text-muted-foreground">{contact.title}</p>
              {contact.notes && <p className="mt-2 whitespace-pre-line break-words text-muted-foreground">{contact.notes}</p>}
            </div>
            <fieldset className="space-y-3">
              <legend className="mb-3 text-sm font-medium">Paiement ou devis</legend>
              <label className="flex cursor-not-allowed items-start gap-3 rounded-lg border border-border bg-muted p-5">
                <input type="radio" name="paymentChoice" value="card" disabled className="mt-1 size-4 shrink-0" />
                <CreditCardIcon className="mt-0.5 shrink-0 text-muted-foreground" />
                <span><span className="block font-medium">Payer maintenant par CB</span><span className="mt-1 block text-xs font-medium text-muted-foreground">Bientôt disponible</span><span className="mt-2 block text-sm text-muted-foreground">Le paiement en ligne n’est pas encore disponible. Vous pouvez demander un devis ci-dessous.</span></span>
              </label>
              <label className="flex cursor-pointer items-start gap-3 rounded-lg border-2 border-primary bg-accent/5 p-5">
                <input type="radio" name="paymentChoice" value="quote" defaultChecked className="mt-1 size-4 shrink-0 accent-primary" />
                <FileTextIcon className="mt-0.5 shrink-0 text-primary" />
                <span><span className="block font-medium text-primary">Recevoir un devis</span><span className="mt-2 block text-sm text-muted-foreground">Notre équipe vous adresse un devis par e-mail. Aucun paiement maintenant, sans engagement.</span></span>
              </label>
            </fieldset>
            <p className="text-sm text-muted-foreground">Votre créneau sera bloqué provisoirement dès l’envoi, le temps que notre équipe traite votre demande.</p>
          </div>}

          <div className="mt-8 flex flex-col-reverse gap-3 border-t border-border pt-5 sm:flex-row sm:items-center sm:justify-between">
            {step > 1 ? <button type="button" disabled={pending} onClick={() => goTo((step - 1) as Step)} className={`inline-flex min-h-12 items-center justify-center gap-2 rounded-md border border-border px-5 py-3 text-sm font-medium text-primary hover:bg-muted disabled:opacity-50 ${focusClass}`}><ArrowRightIcon size={18} className="rotate-180" />Retour</button> : <span className="text-center text-xs text-muted-foreground sm:text-left">Aucun paiement à cette étape</span>}
            <button type="submit" disabled={pending || (step === 2 && !validSlot)} className={primaryClass}>
              {pending ? 'Envoi de votre demande…' : step === LAST_STEP ? 'Demander mon devis' : ['Choisir le créneau', 'Décrire mon besoin', 'Renseigner mes infos', 'Passer au paiement'][step - 1]}
              {step < LAST_STEP && <ArrowRightIcon size={18} />}
            </button>
          </div>
        </form>

        <aside aria-label="Récapitulatif de votre réservation" className="hidden min-w-0 border-l border-border bg-muted/60 p-6 lg:block">
          <div className="lg:sticky lg:top-28">
            <h3 className="text-lg font-semibold text-primary">Votre réservation</h3>
            <p className="mt-1 text-xs text-muted-foreground">Votre sélection, au fil des étapes.</p>
            <dl className="mt-6 space-y-5 text-sm">
              <div><dt className="flex items-center gap-2 text-muted-foreground"><words.Icon size={18} />{words.label}</dt><dd className="mt-2 font-medium text-primary">{resource?.name ?? 'À choisir'}</dd>{!!resource?.capacity && <dd className="mt-1 text-muted-foreground">Jusqu’à {resource.capacity} personnes</dd>}</div>
              <div className="border-t border-border pt-5"><dt className="flex items-center gap-2 text-muted-foreground"><CalendarIcon size={18} />Date</dt><dd className="mt-2 font-medium capitalize">{resource && publicSelection(date, '09:00', '10:00', timeZone) ? formatLongDate(date, timeZone) : 'À choisir'}</dd></div>
              <div><dt className="flex items-center gap-2 text-muted-foreground"><ClockIcon size={18} />Horaires</dt><dd className="mt-2 font-medium tabular">{selection ? `${startTime} – ${endTime}` : 'À choisir'}</dd>{selection && <dd className="mt-1 text-muted-foreground">Durée : {formatMinutes(duration)}</dd>}</div>
              <div className="border-t border-border pt-5"><dt className="text-muted-foreground">{words.rate}</dt><dd className="mt-2 space-y-1 font-medium text-primary tabular"><Rates resource={resource} currency={currency} /></dd></div>
              <div className="border-t border-border pt-5"><dt className="text-muted-foreground">Montant</dt><dd className="mt-2"><QuoteAmount quote={quote} live={false} pendingLabel={validSlot ? undefined : 'Choisissez un créneau pour connaître le montant.'} /></dd></div>
            </dl>
            <p className="mt-6 rounded-md border border-border bg-background p-4 text-xs leading-relaxed text-muted-foreground">Un doute ou un besoin particulier ? Précisez-le à l’étape « Vos infos ». Notre équipe vous accompagne.</p>
          </div>
        </aside>
      </div>
    </div>
  )
}

/**
 * Confirmation d'une demande publique, avec le numéro du devis né avec elle
 * (ADR 043) et ce qui se passe ensuite : un devis prêt part seul vers le
 * demandeur, un brouillon passe d'abord par l'accueil.
 */
export function RequestSent({ headingRef, summary, proposal, email, children }: {
  headingRef: RefObject<HTMLHeadingElement | null>
  summary: string
  proposal?: { number: string; status: ProposalStatus }
  email: string
  children?: ReactNode
}) {
  return (
    <div data-booking-active="true" className="rounded-xl border border-border bg-muted p-6 sm:p-10" role="status">
      <span className="flex size-12 items-center justify-center rounded-full bg-primary text-white"><CheckIcon size={24} /></span>
      <h3 ref={headingRef} tabIndex={-1} className="mt-5 text-2xl font-semibold text-primary outline-none">Votre demande de devis est envoyée</h3>
      <p className="mt-3 font-medium">{summary}</p>
      {proposal ? (
        <p className="mt-4 max-w-2xl text-muted-foreground">
          {proposal.status === 'ready'
            ? <>Votre devis <strong className="font-medium text-foreground tabular">{proposal.number}</strong> vous sera envoyé par courriel</>
            : <>Notre équipe vérifie votre demande et vous envoie votre devis <strong className="font-medium text-foreground tabular">{proposal.number}</strong></>}
          {' '}à <strong className="break-all font-medium text-foreground">{email}</strong>{proposal.status === 'ready' ? '.' : ', en général sous un jour ouvré.'}
        </p>
      ) : (
        <p className="mt-4 max-w-2xl text-muted-foreground">Notre équipe préparera votre devis et vous répondra à <strong className="break-all font-medium text-foreground">{email}</strong>, en général sous un jour ouvré.</p>
      )}
      {children}
      <button type="button" onClick={() => window.location.reload()} className={`${primaryClass} mt-6`}>Faire une autre demande</button>
    </div>
  )
}

/**
 * Montant du créneau : HT, TVA, TTC, et le détail de l'unité retenue. La
 * place est tenue pendant le calcul ; un créneau que la grille ne tarife pas
 * le dit, sans inventer de prix.
 */
function QuoteAmount({ quote, pendingLabel, live = true }: { quote?: PublicQuote; pendingLabel?: string; live?: boolean }) {
  // Le récapitulatif latéral redit le montant de l'étape en cours : une seule annonce suffit.
  return (
    <div aria-live={live ? 'polite' : undefined} aria-busy={live ? !quote && !pendingLabel : undefined} className="min-h-[5rem] text-sm">
      {pendingLabel ? <p className="text-muted-foreground">{pendingLabel}</p>
        : !quote ? <p className="text-muted-foreground">Calcul du montant…</p>
        : quote.status === 'unpriced' ? <p className="text-muted-foreground">{quote.message}</p>
        : <>
          <QuoteSummary quote={quote.quote} />
          <p className="mt-2 text-xs text-muted-foreground">{quote.fromContract ? 'Tarif de votre contrat. ' : ''}Montant retenu sur votre demande, confirmé par notre équipe.</p>
        </>}
    </div>
  )
}

function Rates({ resource, currency }: { resource?: PublicBookingResource; currency: string }) {
  return resource?.rates.length ? resource.rates.map((rate) => <span key={rate.unit} className="block tabular">{formatCents(rate.amountCents, currency)} HT {rateUnitSuffixes[rate.unit]}</span>) : 'Tarif sur devis'
}
