'use client'

import { useActionState, useEffect, useRef, useState, type FormEvent } from 'react'

import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import { FileTextIcon } from '../../components/ui/icons.tsx'
import { fieldClass, RecapBlock, showStep, StepActions, StepHeader } from './etapes-demande.tsx'
import { requestDomiciliationAction, type PublicFormState } from './public-actions.ts'
import { RequestSent } from './public-booking-form.tsx'
import { errorsByField, QuestionnaireFields, questionnaireErrorLabels } from './questionnaire-fields.tsx'
import { ANSWER_FIELD_PREFIX, describeAnswers, parseAnswers, type Answers } from './questionnaires.ts'
import { contactRejections, rejectionMessages, type ContactInput } from './requests.ts'

/** Deux étapes : la société, puis les coordonnées avec le récapitulatif. */
const titles = ['Votre société', 'Vos coordonnées'] as const
type Step = 1 | 2

const contactFields = [
  { key: 'name', label: 'Nom et prénom', type: 'text', autoComplete: 'name' },
  { key: 'email', label: 'Adresse e-mail', type: 'email', autoComplete: 'email' },
  { key: 'phone', label: 'Téléphone', type: 'tel', autoComplete: 'tel' },
] as const satisfies readonly { key: keyof ContactInput; label: string; type: string; autoComplete: string }[]

/** Identifiant du champ : le lien du résumé d'erreurs y mène. */
const contactId = (key: string) => `domiciliation-${key}`
const contactLabels = Object.fromEntries(contactFields.map((field) => [contactId(field.key), field.label]))

/** Erreurs rangées par nom de champ (`q.siren`) ramenées au nom de la question. */
function byQuestion(fieldErrors: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(fieldErrors ?? {}).map(([field, message]) => [field.startsWith(ANSWER_FIELD_PREFIX) ? field.slice(ANSWER_FIELD_PREFIX.length) : field, message]))
}

const piecesDemandees = 'Rien à envoyer pour l’instant. Avant la signature du contrat, notre équipe vous demandera la pièce d’identité du dirigeant, un justificatif de domicile et les statuts ou l’extrait Kbis de la société.'

/**
 * Demande de devis de domiciliation (ADR 043) : pas de créneau. Les questions
 * viennent de `questionnaires.domiciliation`, que le serveur relit par
 * `parseAnswers`. Aucune pièce n'est déposée ici : l'accueil les demande avant
 * la signature (RGPD, minimisation).
 */
export function PublicDomiciliationForm({ onClose, onSent }: {
  /** Ferme le dialogue qui contient le formulaire. */
  onClose: () => void
  onSent?: () => void
}) {
  const [state, formAction, pending] = useActionState<PublicFormState, FormData>(requestDomiciliationAction, { status: 'idle' })
  const [step, setStep] = useState<Step>(1)
  // Contrôlées : React réinitialise le formulaire après chaque envoi, un échec
  // ne doit rien faire retaper.
  const [contact, setContact] = useState({ name: '', email: '', phone: '', notes: '' })
  // Les questions sont non contrôlées : elles repartent des réponses validées.
  const [answers, setAnswers] = useState<Answers>({})
  const [questionErrors, setQuestionErrors] = useState<Record<string, string>>()
  const [contactErrors, setContactErrors] = useState<Record<string, string>>()
  const [showServerError, setShowServerError] = useState(true)
  const [seenState, setSeenState] = useState(state)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const errorRef = useRef<HTMLDivElement>(null)
  const error = showServerError && state.status === 'error' && !state.fieldErrors ? state.message : ''
  const describedAnswers = describeAnswers('domiciliation', answers)

  // Refus du serveur champ par champ : retour à l'étape concernée. Le serveur
  // numérote encore trois étapes ; la deuxième et la troisième n'en font plus qu'une.
  if (state !== seenState) {
    setSeenState(state)
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
    if (step === 1) {
      event.preventDefault()
      // Les mêmes règles que le serveur, avant de passer à la suite.
      const parsed = parseAnswers('domiciliation', new FormData(event.currentTarget))
      if (Object.keys(parsed.errors).length > 0) { setQuestionErrors(errorsByField(parsed.errors)); return }
      setQuestionErrors(undefined)
      setAnswers(parsed.answers)
      goTo(2)
      return
    }
    const rejections = contactRejections(contact)
    if (Object.keys(rejections).length > 0) {
      event.preventDefault()
      setContactErrors(Object.fromEntries(Object.entries(rejections).map(([field, rejection]) => [contactId(field), rejectionMessages[rejection]])))
      return
    }
    setContactErrors(undefined)
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
        <StepHeader step={step} titles={titles} headingRef={headingRef} description={step === 1 ? 'Ces réponses nous permettent de préparer votre devis. Les questions sans mention « facultatif » sont obligatoires.' : undefined} />

        {error && (
          <div ref={errorRef} tabIndex={-1} role="alert" className="mt-5 rounded-sm border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive outline-none focus:ring-2 focus:ring-destructive/30">
            <p>{error}</p>
          </div>
        )}
        {step === 1 && questionErrors && <div className="mt-5"><ErrorSummary errors={questionErrors} labels={questionnaireErrorLabels('domiciliation')} /></div>}
        {step === 2 && contactErrors && <div className="mt-5"><ErrorSummary errors={contactErrors} labels={contactLabels} /></div>}

        {/* Toujours montées : des champs non contrôlés démontés ne partiraient pas avec la demande. */}
        <div hidden={step !== 1} className="mt-6">
          <QuestionnaireFields key={JSON.stringify(answers)} product="domiciliation" defaults={answers} errors={byQuestion(questionErrors)} />
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
                  <label htmlFor={id} className="block text-sm font-medium">{field.label}</label>
                  <input
                    id={id}
                    name={field.key}
                    type={field.type}
                    autoComplete={field.autoComplete}
                    required
                    maxLength={field.key === 'phone' ? 40 : 200}
                    aria-invalid={fieldError ? true : undefined}
                    aria-describedby={fieldError ? `${id}-error` : undefined}
                    value={contact[field.key]}
                    onChange={(event) => setContact({ ...contact, [field.key]: event.target.value })}
                    className={`${fieldClass} mt-2`}
                  />
                  {fieldError && <p id={`${id}-error`} className="mt-1.5 text-sm text-destructive">{fieldError}</p>}
                </div>
              )
            })}
            <div className="sm:col-span-2">
              <label htmlFor="domiciliation-notes" className="block text-sm font-medium">Précisions <span className="font-normal text-muted-foreground">(facultatif)</span></label>
              <textarea id="domiciliation-notes" name="notes" rows={3} maxLength={2000} value={contact.notes} onChange={(event) => setContact({ ...contact, notes: event.target.value })} className={`${fieldClass} mt-2`} />
            </div>
          </div>
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
