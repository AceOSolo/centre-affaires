import type { ProposalProduct } from '../facturation/schema-devis.ts'
import { answerFieldName, questionnaires, type Answers, type Question } from './questionnaires.ts'

/**
 * Les questions d'un produit (ADR 043), montées d'après `questionnaires` : la
 * page publique, l'espace client et le back-office posent les mêmes, que le
 * serveur relit par `parseAnswers`.
 *
 * Champs non contrôlés : ils doivent rester montés tant que le formulaire vit
 * (une étape masquée les cache par `hidden`, sans les démonter), sinon leurs
 * réponses ne partent pas.
 *
 * `density` : `comfortable` sur le portail (cibles de 44 px, mobile d'abord),
 * `compact` au back-office (dense, desktop d'abord).
 */
export function QuestionnaireFields({
  product,
  defaults = {},
  errors = {},
  density = 'comfortable',
}: {
  product: ProposalProduct
  defaults?: Answers
  /** Erreurs par nom de question, telles que les rend `parseAnswers`. */
  errors?: Record<string, string>
  density?: 'comfortable' | 'compact'
}) {
  const compact = density === 'compact'
  const inputClass = compact
    ? 'w-full rounded-sm border border-border bg-background px-3 py-1.5 text-sm transition-colors duration-150 ease-out focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
    : 'w-full min-h-12 rounded-sm border border-border bg-background px-3 py-2.5 text-base transition-colors duration-150 ease-out focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
  const optionClass = compact
    ? 'flex min-h-6 items-center gap-2 text-sm'
    : 'flex min-h-11 items-center gap-3 rounded-sm border border-border bg-background px-3 py-2 text-base has-[:checked]:border-primary has-[:checked]:bg-accent/10'
  const labelClass = compact ? 'text-sm font-medium' : 'text-base font-medium'

  return (
    <div className={compact ? 'grid gap-4 sm:grid-cols-2' : 'flex flex-col gap-5'}>
      {questionnaires[product].questions.map((question) => (
        <QuestionField
          key={question.name}
          question={question}
          value={defaults[question.name]}
          error={errors[question.name]}
          inputClass={inputClass}
          optionClass={optionClass}
          labelClass={labelClass}
          compact={compact}
        />
      ))}
    </div>
  )
}

function Optional({ question }: { question: Question }) {
  if (question.required) return null
  if (question.requiredWhen) return <span className="font-normal text-muted-foreground"> (selon votre situation)</span>
  return <span className="font-normal text-muted-foreground"> (facultatif)</span>
}

function QuestionField({
  question,
  value,
  error,
  inputClass,
  optionClass,
  labelClass,
  compact,
}: {
  question: Question
  value: Answers[string] | undefined
  error?: string
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
  const hint = question.hint && (
    <p id={hintId} className="mt-1 text-sm text-muted-foreground">
      {question.hint}
    </p>
  )
  const errorText = error && (
    <p id={errorId} className="mt-1 text-sm text-destructive">
      {error}
    </p>
  )

  if (question.kind === 'choice' || question.kind === 'multi' || question.kind === 'yesno') {
    const choices = question.kind === 'yesno' ? [{ value: 'oui', label: 'Oui' }, { value: 'non', label: 'Non' }] : question.choices ?? []
    const selected = new Set(
      Array.isArray(value) ? value : typeof value === 'boolean' ? [value ? 'oui' : 'non'] : value === undefined ? [] : [String(value)],
    )
    const type = question.kind === 'multi' ? 'checkbox' : 'radio'
    return (
      <fieldset
        id={name}
        tabIndex={-1}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={compact && wide ? 'sm:col-span-2' : undefined}
      >
        <legend className={labelClass}>
          {question.label}
          <Optional question={question} />
        </legend>
        <div className={`mt-2 grid gap-2 ${compact ? 'sm:grid-cols-3' : question.kind === 'yesno' ? 'grid-cols-2' : 'sm:grid-cols-2'}`}>
          {choices.map((choice) => (
            <label key={choice.value} className={optionClass}>
              <input
                type={type}
                name={name}
                value={choice.value}
                defaultChecked={selected.has(choice.value)}
                required={type === 'radio' && question.required}
                className="size-4 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              />
              <span>{choice.label}</span>
            </label>
          ))}
        </div>
        {hint}
        {errorText}
      </fieldset>
    )
  }

  const common = {
    id: name,
    name,
    required: question.required,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': describedBy,
    className: `${inputClass} mt-1`,
    defaultValue: value === undefined ? '' : String(value),
  } as const

  return (
    <div className={compact && wide ? 'sm:col-span-2' : undefined}>
      <label htmlFor={name} className={labelClass}>
        {question.label}
        <Optional question={question} />
      </label>
      {question.kind === 'textarea' ? (
        <textarea {...common} rows={3} maxLength={question.maxLength} />
      ) : (
        <input
          {...common}
          type={question.kind === 'date' ? 'date' : 'text'}
          inputMode={question.kind === 'integer' || question.kind === 'siren' ? 'numeric' : undefined}
          maxLength={question.kind === 'siren' ? 11 : question.maxLength}
          autoComplete={question.kind === 'siren' ? 'off' : undefined}
          className={`${common.className} ${question.kind === 'integer' || question.kind === 'siren' ? 'tabular' : ''}`}
        />
      )}
      {hint}
      {errorText}
    </div>
  )
}

/** Libellés des questions par nom de champ, pour le résumé d'erreurs (`ErrorSummary`). */
export function questionnaireErrorLabels(product: ProposalProduct): Record<string, string> {
  return Object.fromEntries(questionnaires[product].questions.map((question) => [answerFieldName(question), question.label]))
}

/** Erreurs de `parseAnswers` (par question) rangées par nom de champ, comme les attend `ErrorSummary`. */
export function errorsByField(errors: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(errors).map(([question, message]) => [answerFieldName({ name: question }), message]))
}
