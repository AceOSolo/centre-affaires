'use client'

import { useActionState, useEffect, useRef, useState, type FormEvent } from 'react'

import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import { FieldLabel, RequiredNote } from '../../components/ui/obligatoire.tsx'
import { PreuveHumaine, preuveEnCours, preuvePrete } from '../../components/ui/preuve-humaine.tsx'
import { FileTextIcon } from '../../components/ui/icons.tsx'
import { formatCents } from '../facturation/tarifs.ts'
import type { KnownContact } from './coordonnees-connues.ts'
import { domiciliationTotal, UNPRICED_MESSAGE, type DomiciliationOffer } from './domiciliation-tarif.ts'
import { ChampPiege, fieldClass, RecapBlock, showStep, StepActions, StepHeader } from './etapes-demande.tsx'
import { requestDomiciliationAction, type PublicFormState } from './public-actions.ts'
import { RequestSent } from './public-booking-form.tsx'
import { QuestionnaireFields } from './questionnaire-fields.tsx'
import {
  ANSWER_FIELD_PREFIX,
  describeAnswers,
  errorsByField,
  parseAnswers,
  questionnaireErrorLabels,
  SERVICES_ANSWER_KEY,
  type Answers,
  type Questionnaire,
} from './questionnaires.ts'
import { contactRejections, rejectionMessages } from './requests.ts'
import { joinName, nameErrors } from '../clients/prenom-nom.ts'

/** Deux étapes : la société et ses options, puis les coordonnées avec le récapitulatif. */
const titles = ['Votre société', 'Vos coordonnées'] as const
type Step = 1 | 2

/** Prénom et nom séparés (recette du 17/11, ADR 074, ADR 084). */
const contactFields = [
  { key: 'firstName', label: 'Prénom', type: 'text', autoComplete: 'given-name', maxLength: 100 },
  { key: 'lastName', label: 'Nom', type: 'text', autoComplete: 'family-name', maxLength: 100 },
  { key: 'email', label: 'Adresse e-mail', type: 'email', autoComplete: 'email', maxLength: 200 },
  { key: 'phone', label: 'Téléphone', type: 'tel', autoComplete: 'tel', maxLength: 40 },
] as const
type ContactKey = (typeof contactFields)[number]['key']

/** Identifiant du champ : le lien du résumé d'erreurs y mène. */
const contactId = (key: string) => `domiciliation-${key}`
const contactLabels = Object.fromEntries(contactFields.map((field) => [contactId(field.key), field.label]))

/** Erreurs rangées par nom de champ (`q.siret`) ramenées au nom de la question. */
function byQuestion(fieldErrors: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(fieldErrors ?? {}).map(([field, message]) => [field.startsWith(ANSWER_FIELD_PREFIX) ? field.slice(ANSWER_FIELD_PREFIX.length) : field, message]))
}

/** Les mêmes règles que le serveur (`contactFromNames`), avant l'envoi. */
function contactErrorsOf(contact: Record<ContactKey, string>): Record<string, string> {
  const errors: Record<string, string> = Object.fromEntries(Object.entries(nameErrors(contact)).map(([field, message]) => [contactId(field), message]))
  for (const [field, rejection] of Object.entries(contactRejections({ name: joinName(contact) || '-', email: contact.email, phone: contact.phone }))) {
    if (rejection) errors[contactId(field)] = rejectionMessages[rejection]
  }
  return errors
}

const piecesDemandees = 'Rien à envoyer pour l’instant. Avant la signature du contrat, notre équipe vous demandera la pièce d’identité du dirigeant, un justificatif de domicile et les statuts ou l’extrait Kbis de la société.'

/**
 * Demande de devis de domiciliation (ADR 043, ADR 074) : pas de créneau. Les
 * questions viennent du formulaire réglé par le centre, que le serveur relit
 * par `parseAnswers` ; elles s'adaptent à la situation de la société (en
 * création ou immatriculée). Les options sont des services du catalogue reçus
 * de Dolibarr, choisies par le centre : le total mensuel se recalcule à chaque
 * choix. Aucune pièce n'est déposée ici : l'accueil les demande avant la
 * signature (RGPD, minimisation).
 */
export function PublicDomiciliationForm({ questionnaire, offer, knownContact, onClose, onSent }: {
  questionnaire: Questionnaire
  /** Coordonnées de la personne connectée à son espace, modifiables (ADR 084). */
  knownContact?: KnownContact
  /** Forfait et options tarifées du centre (`loadDomiciliationOffer`). */
  offer: DomiciliationOffer
  /** Ferme le dialogue qui contient le formulaire. */
  onClose: () => void
  onSent?: () => void
}) {
  const [state, formAction, pending] = useActionState<PublicFormState, FormData>(requestDomiciliationAction, { status: 'idle' })
  const [step, setStep] = useState<Step>(1)
  // Contrôlées : React réinitialise le formulaire après chaque envoi, un échec
  // ne doit rien faire retaper.
  const [contact, setContact] = useState<Record<ContactKey | 'notes', string>>(() => ({
    firstName: knownContact?.firstName ?? '',
    lastName: knownContact?.lastName ?? '',
    email: knownContact?.email ?? '',
    phone: knownContact?.phone ?? '',
    notes: '',
  }))
  const [services, setServices] = useState<string[]>([])
  // Les questions sont non contrôlées : elles repartent des réponses validées.
  const [answers, setAnswers] = useState<Answers>({})
  const [questionErrors, setQuestionErrors] = useState<Record<string, string>>()
  const [contactErrors, setContactErrors] = useState<Record<string, string>>()
  const [showServerError, setShowServerError] = useState(true)
  const [seenState, setSeenState] = useState(state)
  const [localError, setLocalError] = useState('')
  const [essai, setEssai] = useState(0)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const errorRef = useRef<HTMLDivElement>(null)
  const error = localError || (showServerError && state.status === 'error' && !state.fieldErrors ? state.message : '')
  const describedAnswers = describeAnswers(questionnaire, answers)
  const total = domiciliationTotal(offer, services)
  const chosenOptions = offer.options.filter((option) => services.includes(option.code))
  const showsPrice = Boolean(offer.base) || offer.options.length > 0

  // Refus du serveur champ par champ : retour à l'étape concernée. Le serveur
  // numérote encore trois étapes ; la deuxième et la troisième n'en font plus qu'une.
  if (state !== seenState) {
    setSeenState(state)
    // La réponse anti-robot envoyée est consommée : un calcul neuf pour le prochain envoi.
    setEssai((value) => value + 1)
    if (state.status === 'error' && state.fieldErrors) {
      if (state.step && state.step >= 2) {
        setStep(2)
        setContactErrors(Object.fromEntries(Object.entries(state.fieldErrors).map(([field, message]) => [contactId(field), message])))
      } else {
        setStep(1)
        setQuestionErrors(state.fieldErrors)
      }
    }
  }

  // À l'ouverture, le focus va au titre : le bouton qui a choisi le produit
  // vient de disparaître, le lecteur d'écran annonce où l'on arrive.
  useEffect(() => showStep(headingRef), [])
  useEffect(() => { if (error) errorRef.current?.focus() }, [error])
  useEffect(() => {
    if (state.status !== 'sent') return
    headingRef.current?.focus()
    onSent?.()
  }, [state, onSent])

  function goTo(next: Step) {
    setStep(next)
    setShowServerError(false)
    showStep(headingRef)
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    if (pending) { event.preventDefault(); return }
    setLocalError('')
    if (step === 1) {
      event.preventDefault()
      // Les mêmes règles que le serveur, avant de passer à la suite.
      const parsed = parseAnswers(questionnaire, new FormData(event.currentTarget))
      if (Object.keys(parsed.errors).length > 0) { setQuestionErrors(errorsByField(parsed.errors)); return }
      setQuestionErrors(undefined)
      setAnswers(parsed.answers)
      goTo(2)
      return
    }
    const rejections = contactErrorsOf(contact)
    if (Object.keys(rejections).length > 0) {
      event.preventDefault()
      setContactErrors(rejections)
      return
    }
    setContactErrors(undefined)
    if (!preuvePrete(event.currentTarget)) { event.preventDefault(); setLocalError(preuveEnCours); return }
    setShowServerError(true)
  }

  if (state.status === 'sent') {
    return (
      <RequestSent headingRef={headingRef} summary={state.summary} proposal={state.proposal} email={contact.email} onClose={onClose}>
        <p className="mt-3 max-w-prose text-sm text-muted-foreground">Avant la signature, notre équipe vous demandera la pièce d’identité du dirigeant, un justificatif de domicile et les statuts ou l’extrait Kbis de la société.</p>
      </RequestSent>
    )
  }

  return (
    <form action={formAction} onSubmit={handleSubmit} noValidate className="flex min-h-full flex-col">
      <div className="flex-1 px-5 pb-8 pt-5 sm:px-8">
        <StepHeader step={step} titles={titles} headingRef={headingRef} description={step === 1 ? 'Ces réponses nous permettent de préparer votre devis.' : undefined} />
        <RequiredNote className="mt-2" />

        {error && (
          <div ref={errorRef} tabIndex={-1} role="alert" className="mt-5 rounded-sm border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive outline-none focus:ring-2 focus:ring-destructive/30">
            <p>{error}</p>
          </div>
        )}
        {step === 1 && questionErrors && <div className="mt-5"><ErrorSummary errors={questionErrors} labels={{ ...questionnaireErrorLabels(questionnaire), [SERVICES_ANSWER_KEY]: 'Vos options' }} /></div>}
        {step === 2 && contactErrors && <div className="mt-5"><ErrorSummary errors={contactErrors} labels={contactLabels} /></div>}

        <ChampPiege />
        {services.map((code) => <input key={code} type="hidden" name={SERVICES_ANSWER_KEY} value={code} />)}

        {/* Toujours montées : des champs non contrôlés démontés ne partiraient pas avec la demande. */}
        <div hidden={step !== 1} className="mt-6">
          <QuestionnaireFields key={JSON.stringify(answers)} questionnaire={questionnaire} defaults={answers} errors={byQuestion(questionErrors)} />

          {showsPrice && (
            <fieldset id={SERVICES_ANSWER_KEY} tabIndex={-1} className="mt-6">
              <legend className="text-base font-medium">Vos options</legend>
              {offer.options.length > 0 ? (
                <ul className="mt-2 grid gap-2">
                  {offer.options.map((option) => (
                    <li key={option.code}>
                      <label className="flex min-h-11 items-start gap-3 rounded-sm border border-border bg-background px-3 py-2 text-base has-[:checked]:border-primary has-[:checked]:bg-accent/10">
                        <input
                          type="checkbox"
                          checked={services.includes(option.code)}
                          onChange={(event) => setServices((current) => event.target.checked ? [...current, option.code] : current.filter((code) => code !== option.code))}
                          className="mt-1 size-4 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-baseline justify-between gap-x-3">
                            <span>{option.label}</span>
                            <span className="text-sm tabular text-muted-foreground">{formatCents(option.amountCents, offer.currency)} HT par mois</span>
                          </span>
                          {option.description && <span className="mt-0.5 block text-sm text-muted-foreground">{option.description}</span>}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-sm text-muted-foreground">Aucune option en plus du forfait.</p>
              )}
              {questionErrors?.[SERVICES_ANSWER_KEY] && <p role="alert" className="mt-1 text-sm text-destructive">{questionErrors[SERVICES_ANSWER_KEY]}</p>}
              <PriceSummary offer={offer} total={total} />
            </fieldset>
          )}

          <p className="mt-6 flex items-start gap-3 rounded-md bg-muted p-4 text-sm text-muted-foreground">
            <FileTextIcon size={20} className="mt-0.5 shrink-0 text-primary" />
            {piecesDemandees}
          </p>
        </div>

        {/* `hidden` sur un enveloppant sans `display` : une classe `grid` l'emporterait. */}
        <div hidden={step !== 2} className="mt-6"><div className="space-y-6">
          {describedAnswers.length > 0 && (
            <RecapBlock title="Votre société" onEdit={() => goTo(1)} pending={pending}>
              <dl className="space-y-1">
                {describedAnswers.map((answer) => <div key={answer.name}><dt className="inline text-muted-foreground">{answer.label} : </dt><dd className="inline break-words">{answer.value}</dd></div>)}
                {chosenOptions.length > 0 && <div><dt className="inline text-muted-foreground">Options : </dt><dd className="inline">{chosenOptions.map((option) => option.label).join(', ')}</dd></div>}
                {showsPrice && <div><dt className="inline text-muted-foreground">Tarif estimé : </dt><dd className="inline tabular">{total.status === 'priced' ? `${formatCents(total.netCents, offer.currency)} HT, soit ${formatCents(total.grossCents, offer.currency)} TTC par mois` : UNPRICED_MESSAGE}</dd></div>}
              </dl>
            </RecapBlock>
          )}
          <div className="grid gap-5 sm:grid-cols-2">
            {contactFields.map((field) => {
              const id = contactId(field.key)
              const fieldError = contactErrors?.[id]
              return (
                <div key={field.key}>
                  <FieldLabel htmlFor={id} required className="block text-sm font-medium">{field.label}</FieldLabel>
                  <input
                    id={id}
                    name={field.key}
                    type={field.type}
                    autoComplete={field.autoComplete}
                    required
                    aria-required="true"
                    maxLength={field.maxLength}
                    aria-invalid={fieldError ? true : undefined}
                    aria-describedby={fieldError ? `${id}-error` : undefined}
                    value={contact[field.key]}
                    onChange={(event) => setContact({ ...contact, [field.key]: event.target.value })}
                    className={`${fieldClass} mt-2`}
                  />
                  {fieldError && <p id={`${id}-error`} role="alert" className="mt-1.5 text-sm text-destructive">{fieldError}</p>}
                </div>
              )
            })}
            <div className="sm:col-span-2">
              <label htmlFor="domiciliation-notes" className="block text-sm font-medium">Précisions</label>
              <textarea id="domiciliation-notes" name="notes" rows={3} maxLength={2000} value={contact.notes} onChange={(event) => setContact({ ...contact, notes: event.target.value })} className={`${fieldClass} mt-2`} />
            </div>
          </div>
          <PreuveHumaine key={essai} />
          <p className="text-sm text-muted-foreground">Notre équipe vérifie chaque demande de domiciliation, puis vous envoie votre devis par e-mail. Sans engagement, aucun paiement maintenant.</p>
        </div></div>
      </div>

      <StepActions
        onBack={step > 1 ? () => goTo(1) : undefined}
        pending={pending}
        label={step === 2 ? 'Demander mon devis' : 'Continuer'}
        last={step === 2}
        hint="Sans engagement"
      />
    </form>
  )
}

/**
 * Total mensuel estimé, recalculé à chaque option : le forfait, les options,
 * HT puis TTC. Sans forfait connu, il n'invente rien. La place est tenue,
 * l'annonce est polie (`aria-live`).
 */
function PriceSummary({ offer, total }: { offer: DomiciliationOffer; total: ReturnType<typeof domiciliationTotal> }) {
  return (
    <div aria-live="polite" className="mt-4 rounded-md bg-muted p-4 text-sm">
      {total.status === 'unpriced' ? (
        <p className="text-muted-foreground">{UNPRICED_MESSAGE}</p>
      ) : (
        <>
          <dl className="space-y-1">
            {total.lines.map((line) => (
              <div key={line.label} className="flex items-baseline justify-between gap-3">
                <dt>{line.label}</dt>
                <dd className="tabular">{formatCents(line.amountCents, offer.currency)} HT</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 flex items-baseline justify-between gap-3 border-t border-border pt-3 font-medium text-primary">
            <span>Total estimé par mois</span>
            <span className="tabular">{formatCents(total.netCents, offer.currency)} HT</span>
          </p>
          <p className="mt-1 flex items-baseline justify-between gap-3 text-muted-foreground">
            <span>Soit, TVA comprise</span>
            <span className="tabular">{formatCents(total.grossCents, offer.currency)} TTC</span>
          </p>
          <p className="mt-2 text-xs text-muted-foreground">Montant indicatif, confirmé par notre équipe dans votre devis.</p>
        </>
      )}
    </div>
  )
}
