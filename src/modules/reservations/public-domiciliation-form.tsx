'use client'

import { useActionState, useEffect, useRef, useState, type FormEvent } from 'react'

import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import { ArrowRightIcon, CheckIcon, FileTextIcon } from '../../components/ui/icons.tsx'
import { requestDomiciliationAction, type PublicFormState } from './public-actions.ts'
import { RequestSent } from './public-booking-form.tsx'
import { errorsByField, QuestionnaireFields, questionnaireErrorLabels } from './questionnaire-fields.tsx'
import { ANSWER_FIELD_PREFIX, describeAnswers, parseAnswers, type Answers } from './questionnaires.ts'
import { contactRejections, rejectionMessages, type ContactInput } from './requests.ts'

const fieldClass = 'w-full min-h-12 rounded-sm border border-border bg-background px-3 py-2.5 text-base outline-none transition-colors focus:border-primary focus:ring-2 focus:ring-accent/40'
const focusClass = 'focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary'
const primaryClass = `inline-flex min-h-12 items-center justify-center gap-2 rounded-md bg-primary px-5 py-3 font-medium text-primary-foreground transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50 ${focusClass}`

const steps = [
  { label: 'Votre société', title: 'Parlez-nous de votre société', description: 'Ces réponses nous permettent de préparer votre devis de domiciliation.' },
  { label: 'Vos coordonnées', title: 'Comment vous joindre ?', description: 'Ces coordonnées permettront à notre équipe de vous répondre.' },
  { label: 'Envoi', title: 'Vérifiez votre demande', description: 'Relisez vos réponses, puis demandez votre devis.' },
] as const
type Step = 1 | 2 | 3

const contactFields = [
  { key: 'name', label: 'Nom et prénom', type: 'text', autoComplete: 'name', placeholder: 'Camille Dupont' },
  { key: 'email', label: 'Adresse e-mail', type: 'email', autoComplete: 'email', placeholder: 'camille@entreprise.fr' },
  { key: 'phone', label: 'Téléphone', type: 'tel', autoComplete: 'tel', placeholder: '06 12 34 56 78' },
] as const satisfies readonly { key: keyof ContactInput; label: string; type: string; autoComplete: string; placeholder: string }[]

/** Identifiant du champ : le lien du résumé d'erreurs y mène. */
const contactId = (key: string) => `domiciliation-${key}`
const contactLabels = Object.fromEntries(contactFields.map((field) => [contactId(field.key), field.label]))

/** Erreurs rangées par nom de champ (`q.siren`) ramenées au nom de la question. */
function byQuestion(fieldErrors: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(fieldErrors ?? {}).map(([field, message]) => [field.startsWith(ANSWER_FIELD_PREFIX) ? field.slice(ANSWER_FIELD_PREFIX.length) : field, message]))
}

/**
 * Demande de devis de domiciliation (ADR 043) : pas de créneau, trois étapes.
 * Les questions viennent de `questionnaires.domiciliation`, que le serveur
 * relit par `parseAnswers`. Aucune pièce n'est déposée ici : l'accueil les
 * demande avant la signature (RGPD, minimisation).
 */
export function PublicDomiciliationForm() {
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

  // Refus du serveur champ par champ : retour à l'étape concernée.
  if (state !== seenState) {
    setSeenState(state)
    if (state.status === 'error' && state.fieldErrors) {
      if (state.step === 2) {
        setStep(2)
        setContactErrors(Object.fromEntries(Object.entries(state.fieldErrors).map(([field, message]) => [contactId(field), message])))
      } else {
        setStep(1)
        setQuestionErrors(state.fieldErrors)
      }
    }
  }

  useEffect(() => { if (error) errorRef.current?.focus() }, [error])
  useEffect(() => { if (state.status === 'sent') headingRef.current?.focus() }, [state])

  function goTo(next: Step) {
    setStep(next)
    setShowServerError(false)
    requestAnimationFrame(() => {
      headingRef.current?.focus({ preventScroll: true })
      headingRef.current?.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
    })
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    if (pending) { event.preventDefault(); return }
    if (step === 3) { setShowServerError(true); return }
    event.preventDefault()
    if (step === 1) {
      // Les mêmes règles que le serveur, avant de passer à la suite.
      const parsed = parseAnswers('domiciliation', new FormData(event.currentTarget))
      if (Object.keys(parsed.errors).length > 0) { setQuestionErrors(errorsByField(parsed.errors)); return }
      setQuestionErrors(undefined)
      setAnswers(parsed.answers)
    }
    if (step === 2) {
      const rejections = contactRejections(contact)
      if (Object.keys(rejections).length > 0) {
        setContactErrors(Object.fromEntries(Object.entries(rejections).map(([field, rejection]) => [contactId(field), rejectionMessages[rejection]])))
        return
      }
      setContactErrors(undefined)
    }
    goTo((step + 1) as Step)
  }

  if (state.status === 'sent') {
    return (
      <RequestSent headingRef={headingRef} summary={state.summary} proposal={state.proposal} email={contact.email}>
        <p className="mt-3 max-w-2xl text-sm text-muted-foreground">Avant la signature, notre équipe vous demandera la pièce d’identité du dirigeant, un justificatif de domicile et les statuts ou l’extrait Kbis de la société.</p>
      </RequestSent>
    )
  }

  return (
    <div data-booking-active={step > 1} className="overflow-hidden rounded-xl border border-border bg-background">
      <nav aria-label="Étapes de la demande" className="border-b border-border bg-muted/60 px-3 py-5 sm:px-8">
        <ol className="grid grid-cols-3 gap-2 sm:gap-4">
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

      <form action={formAction} onSubmit={handleSubmit} noValidate className="mx-auto max-w-3xl p-5 sm:p-8">
        <div className="mb-6">
          <p className="mb-2 text-sm font-medium text-primary">Étape {step} sur 3</p>
          <h3 ref={headingRef} tabIndex={-1} className="scroll-mt-40 text-2xl font-semibold tracking-tight text-primary outline-none sm:scroll-mt-28">{steps[step - 1].title}</h3>
          <p className="mt-2 text-sm text-muted-foreground">{steps[step - 1].description}</p>
        </div>

        {error && (
          <div ref={errorRef} tabIndex={-1} role="alert" className="mb-5 rounded-sm border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive outline-none focus:ring-2 focus:ring-destructive/30">
            <p>{error}</p>
          </div>
        )}
        {step === 1 && questionErrors && <div className="mb-5"><ErrorSummary errors={questionErrors} labels={questionnaireErrorLabels('domiciliation')} /></div>}
        {step === 2 && contactErrors && <div className="mb-5"><ErrorSummary errors={contactErrors} labels={contactLabels} /></div>}

        {/* Toujours montées : des champs non contrôlés démontés ne partiraient pas avec la demande. */}
        <div hidden={step !== 1}>
          <p className="mb-5 text-sm text-muted-foreground">Les questions sans mention « facultatif » sont obligatoires.</p>
          <QuestionnaireFields key={JSON.stringify(answers)} product="domiciliation" defaults={answers} errors={byQuestion(questionErrors)} />
        </div>

        {/* `hidden` sur un enveloppant sans `display` : une classe `grid` l'emporterait. */}
        <div hidden={step !== 2}><div className="grid gap-5 sm:grid-cols-2">
          <p className="text-sm text-muted-foreground sm:col-span-2">Tous les champs sont obligatoires, sauf les précisions.</p>
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
                  placeholder={field.placeholder}
                  required
                  maxLength={field.key === 'phone' ? 40 : 200}
                  aria-invalid={fieldError ? true : undefined}
                  aria-describedby={fieldError ? `${id}-error` : undefined}
                  value={contact[field.key]}
                  onChange={(event) => setContact({ ...contact, [field.key]: event.target.value })}
                  className={`${fieldClass} mt-2`}
                />
                {fieldError && <p id={`${id}-error`} className="mt-1 text-sm text-destructive">{fieldError}</p>}
              </div>
            )
          })}
          <div className="sm:col-span-2">
            <label htmlFor="domiciliation-notes" className="block text-sm font-medium">Précisions <span className="font-normal text-muted-foreground">(facultatif)</span></label>
            <textarea id="domiciliation-notes" name="notes" rows={3} maxLength={2000} value={contact.notes} onChange={(event) => setContact({ ...contact, notes: event.target.value })} placeholder="Une question, un besoin particulier…" className={`${fieldClass} mt-2`} />
          </div>
        </div></div>

        {step === 3 && <div className="space-y-5">
          <div className="rounded-md border border-border p-4 text-sm">
            <div className="flex items-start justify-between gap-3"><p className="font-medium">Votre société</p><button type="button" onClick={() => goTo(1)} disabled={pending} className={`min-h-11 text-primary underline ${focusClass}`}>Modifier</button></div>
            <dl className="space-y-1">
              {describedAnswers.map((answer) => <div key={answer.label}><dt className="inline text-muted-foreground">{answer.label} : </dt><dd className="inline break-words">{answer.value}</dd></div>)}
            </dl>
          </div>
          <div className="rounded-md border border-border p-4 text-sm">
            <div className="flex items-start justify-between gap-3"><p className="font-medium">Vos coordonnées</p><button type="button" onClick={() => goTo(2)} disabled={pending} className={`min-h-11 text-primary underline ${focusClass}`}>Modifier</button></div>
            <p>{contact.name}</p>
            <p className="mt-1 break-all text-muted-foreground">{contact.email} · {contact.phone}</p>
            {contact.notes && <p className="mt-2 whitespace-pre-line break-words text-muted-foreground">{contact.notes}</p>}
          </div>
          <p className="text-sm text-muted-foreground">Notre équipe vérifie chaque demande de domiciliation, puis vous envoie votre devis par e-mail. Sans engagement, aucun paiement maintenant.</p>
        </div>}

        <div className="mt-8 flex flex-col-reverse gap-3 border-t border-border pt-5 sm:flex-row sm:items-center sm:justify-between">
          {step > 1 ? <button type="button" disabled={pending} onClick={() => goTo((step - 1) as Step)} className={`inline-flex min-h-12 items-center justify-center gap-2 rounded-md border border-border px-5 py-3 text-sm font-medium text-primary hover:bg-muted disabled:opacity-50 ${focusClass}`}><ArrowRightIcon size={18} className="rotate-180" />Retour</button> : <span className="text-center text-xs text-muted-foreground sm:text-left">Sans engagement</span>}
          <button type="submit" disabled={pending} className={primaryClass}>
            {pending ? 'Envoi de votre demande…' : step === 3 ? 'Demander mon devis' : step === 1 ? 'Renseigner mes coordonnées' : 'Vérifier ma demande'}
            {step < 3 && <ArrowRightIcon size={18} />}
          </button>
        </div>

        <div className="mt-6 flex items-start gap-3 rounded-md bg-muted p-4 text-sm text-muted-foreground">
          <FileTextIcon size={20} className="mt-0.5 shrink-0 text-primary" />
          <p>
            Rien à envoyer pour l’instant. Avant la signature du contrat, notre équipe vous demandera la pièce d’identité du dirigeant,
            un justificatif de domicile et les statuts ou l’extrait Kbis de la société.
          </p>
        </div>
      </form>
    </div>
  )
}
