'use client'

import { useEffect, useRef } from 'react'

import { RequiredMark } from '../../components/ui/obligatoire.tsx'
import {
  answerFieldName,
  answerTokens,
  askedQuestions,
  isShown,
  OTHER_LABEL,
  OTHER_MAX_LENGTH,
  OTHER_VALUE,
  otherAnswerKey,
  otherFieldName,
  type Answers,
  type Question,
  type Questionnaire,
} from './questionnaires.ts'

/**
 * Les questions d'un formulaire (ADR 043, ADR 074), montées d'après le
 * questionnaire du centre : la page publique, l'espace client et le
 * back-office posent les mêmes, que le serveur relit par `parseAnswers`.
 *
 * Formulaire dynamique, sans JavaScript d'abord : une question conditionnelle
 * et le champ libre de « Autre » sont masqués par une règle CSS (`:has()`) qui
 * les montre dès que la réponse qui les ouvre est cochée — sans JavaScript, le
 * formulaire reste complet et le serveur trie. Avec JavaScript, un champ
 * masqué est en plus désactivé : il ne part pas avec la demande.
 *
 * Champs non contrôlés : ils doivent rester montés tant que le formulaire vit
 * (une étape masquée les cache par `hidden`, sans les démonter), sinon leurs
 * réponses ne partent pas.
 *
 * `density` : `comfortable` sur le portail (cibles de 44 px, mobile d'abord),
 * `compact` au back-office (dense, desktop d'abord).
 */
export function QuestionnaireFields({
  questionnaire,
  defaults = {},
  errors = {},
  density = 'comfortable',
}: {
  questionnaire: Questionnaire
  defaults?: Answers
  /** Erreurs par nom de question (`usage`, `usage.autre`), telles que les rend `parseAnswers`. */
  errors?: Record<string, string>
  density?: 'comfortable' | 'compact'
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const compact = density === 'compact'
  const questions = askedQuestions(questionnaire)
  const inputClass = compact
    ? 'w-full rounded-sm border border-border bg-background px-3 py-1.5 text-sm transition-colors duration-150 ease-out focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
    : 'w-full min-h-12 rounded-sm border border-border bg-background px-3 py-2.5 text-base transition-colors duration-150 ease-out focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
  const optionClass = compact
    ? 'flex min-h-6 items-center gap-2 text-sm'
    : 'flex min-h-11 items-center gap-3 rounded-sm border border-border bg-background px-3 py-2 text-base has-[:checked]:border-primary has-[:checked]:bg-accent/10'
  const labelClass = compact ? 'text-sm font-medium' : 'text-base font-medium'

  // Désactive ce que les conditions masquent : un champ désactivé ne part pas.
  useEffect(() => {
    const root = rootRef.current
    const form = root?.closest('form')
    if (!root || !form) return
    const asked = askedQuestions(questionnaire)
    const sync = () => {
      const data = new FormData(form)
      const current: Answers = {}
      for (const question of asked) {
        const values = data.getAll(answerFieldName(question)).map(String)
        if (values.length > 0) current[question.name] = question.kind === 'multi' ? values : values[0]
      }
      for (const question of asked) {
        const shown = isShown(question, current, asked)
        disableWithin(root.querySelector(`[data-question="${question.name}"]`), !shown)
        if (question.allowOther) {
          const open = shown && answerTokens(current[question.name]).includes(OTHER_VALUE)
          disableWithin(root.querySelector(`[data-autre="${question.name}"]`), !open)
        }
      }
    }
    sync()
    form.addEventListener('change', sync)
    return () => form.removeEventListener('change', sync)
  }, [questionnaire])

  return (
    <div ref={rootRef} data-questionnaire={questionnaire.form} className={compact ? 'grid gap-4 sm:grid-cols-2' : 'flex flex-col gap-5'}>
      <style dangerouslySetInnerHTML={{ __html: conditionStyles(questionnaire.form, questions) }} />
      {questions.map((question) => (
        <QuestionField
          key={question.name}
          question={question}
          value={defaults[question.name]}
          other={defaults[otherAnswerKey(question)]}
          error={errors[question.name]}
          otherError={errors[otherAnswerKey(question)]}
          inputClass={inputClass}
          optionClass={optionClass}
          labelClass={labelClass}
          compact={compact}
        />
      ))}
    </div>
  )
}

function disableWithin(element: Element | null, disabled: boolean) {
  element?.querySelectorAll('input, textarea, select').forEach((control) => {
    ;(control as HTMLInputElement).disabled = disabled
  })
}

/** Noms et valeurs sont tenus à `[a-zA-Z0-9-]` par les règles du questionnaire ; une valeur autre n'entre pas dans la feuille. */
const SAFE = /^[a-zA-Z0-9-]+$/

/**
 * Feuille qui montre une question conditionnelle (ou le champ de « Autre »)
 * dès que la réponse qui l'ouvre est cochée, sans JavaScript.
 */
function conditionStyles(scope: string, questions: readonly Question[]): string {
  const root = `[data-questionnaire="${scope}"]`
  const rules = [`${root} [data-montre-si], ${root} [data-autre] { display: none; }`]
  const checked = (name: string, value: string) => `${root}:has([name="${answerFieldName({ name })}"][value="${value}"]:checked)`
  for (const question of questions) {
    if (!SAFE.test(question.name)) continue
    const condition = question.showWhen
    if (condition && SAFE.test(condition.question)) {
      const selectors = condition.values.filter((value) => SAFE.test(value)).map((value) => `${checked(condition.question, value)} [data-question="${question.name}"]`)
      if (selectors.length > 0) rules.push(`${selectors.join(', ')} { display: block; }`)
    }
    if (question.allowOther) rules.push(`${checked(question.name, OTHER_VALUE)} [data-autre="${question.name}"] { display: block; }`)
  }
  return rules.join('\n')
}

function QuestionField({
  question,
  value,
  other,
  error,
  otherError,
  inputClass,
  optionClass,
  labelClass,
  compact,
}: {
  question: Question
  value: Answers[string] | undefined
  other: Answers[string] | undefined
  error?: string
  otherError?: string
  inputClass: string
  optionClass: string
  labelClass: string
  compact: boolean
}) {
  const name = answerFieldName(question)
  const hintId = question.hint ? `${name}-hint` : undefined
  const errorId = error ? `${name}-error` : undefined
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined
  const wide = question.kind === 'multi' || question.kind === 'textarea' || (question.choices?.length ?? 0) > 3
  const required = Boolean(question.required)
  const hint = question.hint && (
    <p id={hintId} className="mt-1 text-sm text-muted-foreground">
      {question.hint}
    </p>
  )
  const errorText = error && (
    <p id={errorId} role="alert" className="mt-1 text-sm text-destructive">
      {error}
    </p>
  )
  const wrapper = {
    'data-question': question.name,
    'data-montre-si': question.showWhen ? '' : undefined,
    className: compact && wide ? 'sm:col-span-2' : undefined,
  }

  if (question.kind === 'choice' || question.kind === 'multi' || question.kind === 'yesno') {
    const choices = question.kind === 'yesno'
      ? [{ value: 'oui', label: 'Oui' }, { value: 'non', label: 'Non' }]
      : [...(question.choices ?? []), ...(question.allowOther ? [{ value: OTHER_VALUE, label: OTHER_LABEL }] : [])]
    const selected = new Set(
      Array.isArray(value) ? value : typeof value === 'boolean' ? [value ? 'oui' : 'non'] : value === undefined ? [] : [String(value)],
    )
    const type = question.kind === 'multi' ? 'checkbox' : 'radio'
    const otherName = otherFieldName(question)
    return (
      <div {...wrapper}>
        <fieldset id={name} tabIndex={-1} aria-invalid={error ? true : undefined} aria-describedby={describedBy}>
          <legend className={labelClass}>
            {question.label}
            {required && <RequiredMark />}
          </legend>
          <div className={`mt-2 grid gap-2 ${compact ? 'sm:grid-cols-3' : question.kind === 'yesno' ? 'grid-cols-2' : 'sm:grid-cols-2'}`}>
            {choices.map((choice) => (
              <label key={choice.value} className={optionClass}>
                <input
                  type={type}
                  name={name}
                  value={choice.value}
                  defaultChecked={selected.has(choice.value)}
                  required={type === 'radio' && required}
                  className="size-4 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                />
                <span>{choice.label}</span>
              </label>
            ))}
          </div>
          {question.allowOther && (
            <div data-autre={question.name} className="mt-3">
              <label htmlFor={otherName} className={compact ? 'text-sm' : 'text-sm font-medium'}>
                Précisez
                {required && <RequiredMark />}
              </label>
              <input
                id={otherName}
                name={otherName}
                type="text"
                maxLength={OTHER_MAX_LENGTH}
                required={required}
                aria-required={required || undefined}
                aria-invalid={otherError ? true : undefined}
                aria-describedby={otherError ? `${otherName}-error` : undefined}
                defaultValue={typeof other === 'string' ? other : ''}
                className={`${inputClass} mt-1`}
              />
              {otherError && (
                <p id={`${otherName}-error`} role="alert" className="mt-1 text-sm text-destructive">
                  {otherError}
                </p>
              )}
            </div>
          )}
          {hint}
          {errorText}
        </fieldset>
      </div>
    )
  }

  const common = {
    id: name,
    name,
    required,
    'aria-required': required || undefined,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': describedBy,
    className: `${inputClass} mt-1`,
    defaultValue: value === undefined ? '' : String(value),
  } as const

  return (
    <div {...wrapper}>
      <label htmlFor={name} className={labelClass}>
        {question.label}
        {required && <RequiredMark />}
      </label>
      {question.kind === 'textarea' ? (
        <textarea {...common} rows={3} maxLength={question.maxLength} />
      ) : (
        <input
          {...common}
          type={question.kind === 'date' ? 'date' : 'text'}
          inputMode={question.kind === 'integer' || question.kind === 'siret' ? 'numeric' : undefined}
          maxLength={question.kind === 'siret' ? 17 : question.maxLength}
          autoComplete={question.kind === 'siret' ? 'off' : undefined}
          className={`${common.className} ${question.kind === 'integer' || question.kind === 'siret' ? 'tabular' : ''}`}
        />
      )}
      {hint}
      {errorText}
    </div>
  )
}
