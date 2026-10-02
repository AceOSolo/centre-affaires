'use client'

import { useActionState, useRef, useState } from 'react'

import { ConfirmDialog } from '../../components/ui/confirm-dialog.tsx'
import { ErrorSummary } from '../../components/ui/error-summary.tsx'
import { resetTemplateAction, saveTemplateAction, type TemplateFormState } from './actions.ts'
import { eventVariables, notificationEventLabels } from './catalogue.ts'
import { TEMPLATE_BODY_MAX, TEMPLATE_SUBJECT_MAX, exampleValues, renderMessage } from './rendu.ts'
import type { NotificationEvent } from './schema.ts'

const fieldClass =
  'mt-1 w-full rounded-sm border border-border bg-white px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/40 aria-[invalid=true]:border-destructive'
const labels = { subject: 'Objet', body: 'Texte du message' }

type Field = 'subject' | 'body'

/**
 * Éditeur du modèle d'un événement (R26, ADR 038) : objet, texte, activation,
 * variables disponibles, et l'aperçu rendu avec des données d'exemple à mesure
 * de la saisie — par le même rendu que l'envoi (`rendu.ts`).
 */
export function TemplateEditor({
  event,
  initial,
  centreName,
  customized,
}: {
  event: NotificationEvent
  initial: { subject: string; body: string; active: boolean }
  centreName: string
  /** Le texte enregistré diffère du texte par défaut : le retour est proposé. */
  customized: boolean
}) {
  const [state, formAction, pending] = useActionState<TemplateFormState, FormData>(saveTemplateAction, null)
  const [subject, setSubject] = useState(initial.subject)
  const [body, setBody] = useState(initial.body)
  const [active, setActive] = useState(initial.active)
  const [lastField, setLastField] = useState<Field>('body')
  const subjectRef = useRef<HTMLInputElement>(null)
  const bodyRef = useRef<HTMLTextAreaElement>(null)

  const variables = eventVariables[event]
  const preview = renderMessage(
    { subject, body },
    { ...exampleValues(event), centre: centreName },
    notificationEventLabels[event],
  )
  const errors = state?.fieldErrors

  /** Insère `{{nom}}` au curseur du dernier champ utilisé, et y rend le focus. */
  function insert(name: string) {
    const token = `{{${name}}}`
    const element = lastField === 'subject' ? subjectRef.current : bodyRef.current
    const value = lastField === 'subject' ? subject : body
    const start = element?.selectionStart ?? value.length
    const end = element?.selectionEnd ?? value.length
    const next = `${value.slice(0, start)}${token}${value.slice(end)}`
    if (lastField === 'subject') setSubject(next)
    else setBody(next)
    requestAnimationFrame(() => {
      element?.focus()
      element?.setSelectionRange(start + token.length, start + token.length)
    })
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="flex flex-col gap-6">
        <form action={formAction} className="flex flex-col gap-4 rounded-lg border border-border bg-white px-5 py-4">
          <input type="hidden" name="event" value={event} />
          <ErrorSummary errors={errors} labels={labels} message={state?.error} />

          <div>
            <label htmlFor="subject" className="block text-sm font-medium">
              {labels.subject}
            </label>
            <p id="subject-hint" className="text-xs text-muted-foreground">
              Une ligne, {TEMPLATE_SUBJECT_MAX} caractères au plus. Il est gardé au journal des envois.
            </p>
            <input
              ref={subjectRef}
              id="subject"
              name="subject"
              value={subject}
              onChange={(change) => setSubject(change.target.value)}
              onFocus={() => setLastField('subject')}
              maxLength={TEMPLATE_SUBJECT_MAX}
              autoComplete="off"
              aria-invalid={errors?.subject ? true : undefined}
              aria-describedby={['subject-hint', errors?.subject && 'subject-error'].filter(Boolean).join(' ')}
              className={fieldClass}
            />
            {errors?.subject && (
              <p id="subject-error" role="alert" className="mt-1 text-xs text-destructive">
                {errors.subject}
              </p>
            )}
          </div>

          <div>
            <label htmlFor="body" className="block text-sm font-medium">
              {labels.body}
            </label>
            <p id="body-hint" className="text-xs text-muted-foreground">
              Texte brut. Une ligne qui cite une variable facultative vide n’est pas envoyée.
            </p>
            <textarea
              ref={bodyRef}
              id="body"
              name="body"
              value={body}
              onChange={(change) => setBody(change.target.value)}
              onFocus={() => setLastField('body')}
              rows={14}
              maxLength={TEMPLATE_BODY_MAX}
              aria-invalid={errors?.body ? true : undefined}
              aria-describedby={['body-hint', errors?.body && 'body-error'].filter(Boolean).join(' ')}
              className={`${fieldClass} leading-relaxed`}
            />
            {errors?.body && (
              <p id="body-error" role="alert" className="mt-1 text-xs text-destructive">
                {errors.body}
              </p>
            )}
          </div>

          <div className="flex items-start gap-2">
            <input
              id="active"
              name="active"
              type="checkbox"
              checked={active}
              onChange={(change) => setActive(change.target.checked)}
              aria-describedby="active-hint"
              className="mt-0.5 size-4 accent-primary"
            />
            <div>
              <label htmlFor="active" className="text-sm font-medium">
                Envoyer ce message
              </label>
              <p id="active-hint" className="text-xs text-muted-foreground">
                Décoché, rien ne part pour cet événement ; le journal l’indique « non envoyé ».
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={pending}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-hover disabled:opacity-50"
            >
              {pending ? 'Enregistrement…' : 'Enregistrer le modèle'}
            </button>
            <p role="status" className="text-sm text-primary">
              {state?.saved && !pending ? 'Modèle enregistré.' : ''}
            </p>
          </div>
        </form>

        {customized && (
          <div className="flex flex-col items-start gap-2 rounded-lg border border-border bg-white px-5 py-4">
            <p className="text-sm text-muted-foreground">
              Le texte enregistré n’est plus celui par défaut.
            </p>
            <ConfirmDialog
              triggerLabel="Revenir au texte par défaut"
              triggerClassName="rounded-md border border-border bg-white px-3 py-1.5 text-sm font-medium hover:bg-muted"
              title="Revenir au texte par défaut ?"
              confirmLabel="Revenir au texte par défaut"
              pendingLabel="Retour en cours…"
              action={resetTemplateAction}
              fields={{ event }}
            >
              <p>
                L’objet et le texte personnalisés sont remplacés par ceux fournis par l’application.
                L’envoi reste {initial.active ? 'actif' : 'désactivé'}.
              </p>
            </ConfirmDialog>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-6">
        <section aria-labelledby="preview-title" className="rounded-lg border border-border bg-white px-5 py-4">
          <h2 id="preview-title" className="text-base font-semibold tracking-tight">
            Aperçu
          </h2>
          <p className="text-xs text-muted-foreground">
            Rendu avec des données d’exemple, fictives, à mesure de la saisie.
          </p>
          {!active && (
            <p className="mt-2 text-sm font-medium">Message désactivé : il ne partira pas.</p>
          )}
          <dl className="mt-3 flex flex-col gap-3 text-sm">
            <div>
              <dt className="text-xs font-medium text-muted-foreground">Objet</dt>
              <dd className="font-medium break-words">{preview.subject}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-muted-foreground">Texte</dt>
              <dd className="mt-1 whitespace-pre-wrap break-words rounded-md bg-muted px-3 py-2 leading-relaxed">
                {preview.body || '—'}
              </dd>
            </div>
          </dl>
        </section>

        <section aria-labelledby="variables-title" className="rounded-lg border border-border bg-white px-5 py-4">
          <h2 id="variables-title" className="text-base font-semibold tracking-tight">
            Variables disponibles
          </h2>
          <p className="text-xs text-muted-foreground">
            Écrivez-les entre doubles accolades, ou insérez-les au curseur du dernier champ utilisé.
          </p>
          <ul className="mt-3 flex flex-col divide-y divide-border">
            {variables.map((variable) => (
              <li key={variable.name} className="flex flex-wrap items-start justify-between gap-2 py-2">
                <div className="min-w-0 text-sm">
                  <span className="font-medium text-primary">{`{{${variable.name}}}`}</span>
                  {variable.optional && <span className="ml-2 text-xs text-muted-foreground">facultative</span>}
                  <p className="text-xs text-muted-foreground">
                    {variable.label}. Exemple : {variable.name === 'centre' ? centreName : variable.example}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => insert(variable.name)}
                  aria-label={`Insérer {{${variable.name}}} dans ${lastField === 'subject' ? 'l’objet' : 'le texte'}`}
                  className="shrink-0 rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-muted"
                >
                  Insérer
                </button>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  )
}
