import {
  OTHER_LABEL,
  OTHER_VALUE,
  questionKinds,
  SERVICES_ANSWER_KEY,
  type Choice,
  type Condition,
  type Question,
  type QuestionKind,
} from './questionnaires.ts'

/**
 * Édition des questionnaires par le centre (ADR 074) : ce qu'un formulaire
 * d'écran dit d'une question, les déplacements, et les règles qui gardent un
 * questionnaire lisible par `parseAnswers` — noms stables et uniques, choix
 * cohérents, conditions qui pointent une question à choix posée avant.
 *
 * Module pur, éprouvé par `questionnaires-edition.test.ts`.
 */

export const QUESTION_NAME = /^[a-zA-Z][a-zA-Z0-9]{0,39}$/
export const CHOICE_VALUE = /^[a-z0-9]+(-[a-z0-9]+)*$/
export const MAX_QUESTIONS = 40
export const MAX_CHOICES = 30
export const LABEL_MAX_LENGTH = 200
export const CHOICE_LABEL_MAX_LENGTH = 120
export const HINT_MAX_LENGTH = 300
export const TEXT_MAX_LENGTH = 2000
const INTEGER_BOUND = 1_000_000

/** Noms de réponse que le code se réserve : jamais celui d'une question créée à l'écran. */
const reservedNames = new Set([SERVICES_ANSWER_KEY])

const kindsWithChoices = new Set<QuestionKind>(['choice', 'multi'])
/** Les questions dont la réponse peut conditionner l'affichage d'une autre. */
const kindsThatCondition = new Set<QuestionKind>(['choice', 'multi', 'yesno'])

/** Mots sans accents ni signes : « Écran supplémentaire » → [« ecran », « supplementaire »]. */
function words(label: string): string[] {
  return label
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

function unique(base: string, taken: ReadonlySet<string>, join: (base: string, rank: number) => string): string {
  if (!taken.has(base)) return base
  for (let rank = 2; ; rank++) {
    const candidate = join(base, rank)
    if (!taken.has(candidate)) return candidate
  }
}

/** Nom stable d'une nouvelle question, tiré de son libellé : « Nombre de postes » → `nombreDePostes`. */
export function slugName(label: string, taken: ReadonlySet<string>): string {
  const parts = words(label)
  let base = parts.map((part, index) => (index === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1))).join('')
  if (!/^[a-z]/.test(base)) base = `q${base.charAt(0).toUpperCase()}${base.slice(1)}`
  base = base.slice(0, 36)
  const blocked = new Set([...taken, ...reservedNames])
  return unique(base, blocked, (stem, rank) => `${stem}${rank}`)
}

/** Valeur stable d'un nouveau choix : « Bureau fermé » → `bureau-ferme`. « autre » reste à « Autre ». */
export function slugValue(label: string, taken: ReadonlySet<string>): string {
  const base = words(label).join('-').slice(0, 36).replace(/-+$/, '') || 'choix'
  return unique(base, new Set([...taken, OTHER_VALUE]), (stem, rank) => `${stem}-${rank}`)
}

/** Les réponses possibles d'une question, telles qu'une condition les nomme. */
export function questionTokens(question: Question): Choice[] {
  if (question.kind === 'yesno') return [{ value: 'oui', label: 'Oui' }, { value: 'non', label: 'Non' }]
  const choices = [...(question.choices ?? [])]
  if (question.allowOther) choices.push({ value: OTHER_VALUE, label: OTHER_LABEL })
  return choices
}

/**
 * Les questions qui peuvent conditionner `name` : à choix ou oui/non, posées
 * avant elle, sans condition elles-mêmes (pas de chaîne de conditions).
 */
export function conditionSources(questions: readonly Question[], name?: string): Question[] {
  const index = name ? questions.findIndex((question) => question.name === name) : questions.length
  const before = questions.slice(0, index === -1 ? questions.length : index)
  return before.filter((question) => kindsThatCondition.has(question.kind) && !question.showWhen)
}

/**
 * Ce qui ne va pas dans une question, vue au milieu des autres, par champ du
 * formulaire d'édition. Vide : la question est bonne.
 */
export function questionProblems(question: Question, questions: readonly Question[]): Record<string, string> {
  const problems: Record<string, string> = {}
  const label = question.label.trim()
  if (!label) problems.label = 'Saisissez la question.'
  else if (label.length > LABEL_MAX_LENGTH) problems.label = `${LABEL_MAX_LENGTH} caractères au plus.`
  if (!(questionKinds as readonly string[]).includes(question.kind)) problems.kind = 'Choisissez un type de réponse.'
  if (question.hint && question.hint.length > HINT_MAX_LENGTH) problems.hint = `${HINT_MAX_LENGTH} caractères au plus.`
  if (!QUESTION_NAME.test(question.name) || reservedNames.has(question.name)) problems.label = 'Cette question n’a pas de nom utilisable.'

  if (kindsWithChoices.has(question.kind)) {
    const choices = question.choices ?? []
    const values = choices.map((choice) => choice.value)
    if (choices.length === 0) problems.choices = 'Proposez au moins un choix.'
    else if (choices.length > MAX_CHOICES) problems.choices = `${MAX_CHOICES} choix au plus.`
    else if (new Set(values).size !== values.length) problems.choices = 'Deux choix portent le même libellé.'
    else if (choices.some((choice) => !CHOICE_VALUE.test(choice.value) || choice.value.length > 40)) problems.choices = 'Un choix n’a pas de valeur utilisable.'
    else if (choices.some((choice) => !choice.label.trim() || choice.label.length > CHOICE_LABEL_MAX_LENGTH)) problems.choices = `Chaque choix a un libellé, de ${CHOICE_LABEL_MAX_LENGTH} caractères au plus.`
    else if (question.allowOther && values.includes(OTHER_VALUE)) problems.choices = '« Autre » est déjà proposé : retirez ce choix.'
  } else if (question.choices?.length || question.allowOther) {
    problems.kind = 'Ce type de réponse ne propose pas de choix.'
  }

  if (question.kind === 'integer') {
    for (const key of ['min', 'max'] as const) {
      const bound = question[key]
      if (bound !== undefined && (!Number.isInteger(bound) || Math.abs(bound) > INTEGER_BOUND)) problems[key] = 'Saisissez un nombre entier.'
    }
    if (!problems.min && !problems.max && question.min !== undefined && question.max !== undefined && question.min > question.max) {
      problems.max = 'Le maximum est inférieur au minimum.'
    }
  } else if (question.min !== undefined || question.max !== undefined) {
    problems.kind = 'Seul un nombre a un minimum et un maximum.'
  }

  if (question.maxLength !== undefined) {
    if (question.kind !== 'text' && question.kind !== 'textarea') problems.kind = 'Seul un texte a une longueur maximale.'
    else if (!Number.isInteger(question.maxLength) || question.maxLength < 1 || question.maxLength > TEXT_MAX_LENGTH) {
      problems.maxLength = `Entre 1 et ${TEXT_MAX_LENGTH.toLocaleString('fr-FR')} caractères.`
    }
  }
  if (question.notBeforeToday && question.kind !== 'date') problems.kind = 'Seule une date peut refuser les jours passés.'

  const condition = question.showWhen
  if (condition) {
    const source = conditionSources(questions, question.name).find((candidate) => candidate.name === condition.question)
    if (!source) problems.condition = 'La question qui conditionne celle-ci doit être une question à choix, posée avant elle, sans condition elle-même.'
    else {
      const tokens = new Set(questionTokens(source).map((token) => token.value))
      if (condition.values.length === 0 || condition.values.some((value) => !tokens.has(value))) {
        problems.condition = `Choisissez des réponses de « ${source.label} ».`
      }
    }
  }
  return problems
}

/**
 * Le questionnaire entier : noms uniques, chaque question bonne, et aucune
 * condition rompue par un déplacement ou un choix retiré. Rend le premier
 * problème, ou `undefined`.
 */
export function questionnaireProblem(questions: readonly Question[]): string | undefined {
  if (questions.length > MAX_QUESTIONS) return `${MAX_QUESTIONS} questions au plus.`
  const names = questions.map((question) => question.name)
  if (new Set(names).size !== names.length) return 'Deux questions portent le même nom.'
  for (const question of questions) {
    const problems = questionProblems(question, questions)
    const first = Object.values(problems)[0]
    if (first) return `« ${question.label || question.name} » : ${first}`
  }
  return undefined
}

/** Ce que le formulaire d'édition renvoie. */
export type QuestionFormValues = {
  label: string
  kind: string
  hint: string
  required: boolean
  allowOther: boolean
  notBeforeToday: boolean
  min: string
  max: string
  maxLength: string
  /** Libellés des choix existants, par valeur, et ceux à retirer. */
  choiceLabels: Record<string, string>
  removedChoices: string[]
  newChoices: string
  /** Réponses qui affichent la question : `situation:creation`. */
  condition: string[]
}

type FormSource = { get(name: string): unknown; getAll(name: string): unknown[] }

const text = (source: FormSource, key: string) => String(source.get(key) ?? '').trim()

/** Lit le formulaire d'édition d'une question (`questionnaire-editor.tsx`). */
export function readQuestionForm(source: FormSource, existing?: Question): QuestionFormValues {
  const choiceLabels: Record<string, string> = {}
  for (const choice of existing?.choices ?? []) choiceLabels[choice.value] = text(source, `choix.${choice.value}`)
  return {
    label: text(source, 'label'),
    kind: text(source, 'kind'),
    hint: text(source, 'hint'),
    required: source.get('required') === 'on',
    allowOther: source.get('allowOther') === 'on',
    notBeforeToday: source.get('notBeforeToday') === 'on',
    min: text(source, 'min'),
    max: text(source, 'max'),
    maxLength: text(source, 'maxLength'),
    choiceLabels,
    removedChoices: source.getAll('retirer').map(String),
    newChoices: String(source.get('newChoices') ?? ''),
    condition: source.getAll('condition').map(String),
  }
}

/** Les valeurs du formulaire d'une question existante, ou d'une nouvelle. */
export function questionFormValues(question?: Question): QuestionFormValues {
  return {
    label: question?.label ?? '',
    kind: question?.kind ?? 'text',
    hint: question?.hint ?? '',
    required: question?.required ?? false,
    allowOther: question?.allowOther ?? false,
    notBeforeToday: question?.notBeforeToday ?? false,
    min: question?.min === undefined ? '' : String(question.min),
    max: question?.max === undefined ? '' : String(question.max),
    maxLength: question?.maxLength === undefined ? '' : String(question.maxLength),
    choiceLabels: Object.fromEntries((question?.choices ?? []).map((choice) => [choice.value, choice.label])),
    removedChoices: [],
    newChoices: '',
    condition: question?.showWhen ? question.showWhen.values.map((value) => `${question.showWhen!.question}:${value}`) : [],
  }
}

function optionalInteger(raw: string): number | undefined | 'invalide' {
  if (!raw) return undefined
  const value = Number(raw.replace(/\s/g, ''))
  return Number.isInteger(value) ? value : 'invalide'
}

/**
 * Une question tirée du formulaire d'édition, ou les erreurs par champ.
 * `existing` : la question modifiée, dont le nom ne change jamais ; absente,
 * une question neuve, nommée d'après son libellé.
 */
export function questionFromForm(
  values: QuestionFormValues,
  questions: readonly Question[],
  existing?: Question,
): { question: Question; errors?: undefined } | { question?: undefined; errors: Record<string, string> } {
  const errors: Record<string, string> = {}
  const kind = values.kind as QuestionKind
  if (!(questionKinds as readonly string[]).includes(kind)) errors.kind = 'Choisissez un type de réponse.'
  const taken = new Set(questions.filter((question) => question !== existing).map((question) => question.name))
  const name = existing?.name ?? slugName(values.label, taken)

  const question: Question = { name, label: values.label, kind }
  if (values.hint) question.hint = values.hint
  if (values.required) question.required = true
  if (existing?.hidden) question.hidden = true

  if (kindsWithChoices.has(kind)) {
    const removed = new Set(values.removedChoices)
    const kept: Choice[] = (existing?.choices ?? [])
      .filter((choice) => !removed.has(choice.value))
      .map((choice) => ({ value: choice.value, label: values.choiceLabels[choice.value] ?? choice.label }))
    const takenValues = new Set(kept.map((choice) => choice.value))
    for (const line of values.newChoices.split(/\r?\n/)) {
      const label = line.trim()
      if (!label) continue
      const value = slugValue(label, takenValues)
      takenValues.add(value)
      kept.push({ value, label })
    }
    question.choices = kept
    if (values.allowOther) question.allowOther = true
  }
  if (kind === 'integer') {
    const min = optionalInteger(values.min)
    const max = optionalInteger(values.max)
    if (min === 'invalide') errors.min = 'Saisissez un nombre entier.'
    else if (min !== undefined) question.min = min
    if (max === 'invalide') errors.max = 'Saisissez un nombre entier.'
    else if (max !== undefined) question.max = max
  }
  if (kind === 'text' || kind === 'textarea') {
    const maxLength = optionalInteger(values.maxLength)
    if (maxLength === 'invalide') errors.maxLength = 'Saisissez un nombre entier.'
    else question.maxLength = maxLength ?? (kind === 'text' ? 200 : TEXT_MAX_LENGTH)
  }
  if (kind === 'date' && values.notBeforeToday) question.notBeforeToday = true

  if (values.condition.length > 0) {
    const pairs = values.condition.map((pair) => {
      const at = pair.indexOf(':')
      return { question: pair.slice(0, at), value: pair.slice(at + 1) }
    })
    const sources = new Set(pairs.map((pair) => pair.question))
    if (sources.size > 1) errors.condition = 'Une seule question peut conditionner l’affichage : cochez des réponses d’une même question.'
    else question.showWhen = { question: pairs[0].question, values: pairs.map((pair) => pair.value) } satisfies Condition
  }

  // La question à sa place, pour juger sa condition et l'unicité des noms.
  const placed = existing ? questions.map((candidate) => (candidate === existing ? question : candidate)) : [...questions, question]
  const problems = questionProblems(question, placed)
  for (const [field, message] of Object.entries(problems)) errors[field] ??= message
  if (!errors.choices && !errors.condition && !errors.label) {
    // Une autre question dont la condition reposait sur un choix retiré.
    const broken = placed.find((candidate) => candidate !== question && candidate.showWhen?.question === question.name && Object.keys(questionProblems(candidate, placed)).length > 0)
    if (broken) errors.choices = `« ${broken.label} » ne s’affiche que selon un choix de cette question : gardez-le, ou changez d’abord sa condition.`
  }
  if (!existing && questions.length >= MAX_QUESTIONS) errors.label = `${MAX_QUESTIONS} questions au plus.`
  return Object.keys(errors).length > 0 ? { errors } : { question }
}

/** Remplace une question par son nom, ou l'ajoute à la fin. */
export function putQuestion(questions: readonly Question[], question: Question): Question[] {
  const index = questions.findIndex((candidate) => candidate.name === question.name)
  if (index === -1) return [...questions, question]
  return questions.map((candidate, at) => (at === index ? question : candidate))
}

/** Monte ou descend une question d'un rang. Rend la liste inchangée en bout de liste. */
export function moveQuestion(questions: readonly Question[], name: string, direction: 'up' | 'down'): Question[] {
  const index = questions.findIndex((question) => question.name === name)
  const target = direction === 'up' ? index - 1 : index + 1
  if (index === -1 || target < 0 || target >= questions.length) return [...questions]
  const next = [...questions]
  ;[next[index], next[target]] = [next[target], next[index]]
  return next
}

/** Masque une question, ou la pose de nouveau. Ses réponses passées restent lisibles. */
export function setQuestionHidden(questions: readonly Question[], name: string, hidden: boolean): Question[] {
  return questions.map((question) => {
    if (question.name !== name) return question
    const rest = { ...question }
    delete rest.hidden
    return hidden ? { ...rest, hidden: true } : rest
  })
}

/** Les questions qui ne s'affichent jamais : celle dont elles dépendent est masquée. */
export function neverShown(questions: readonly Question[]): Set<string> {
  const hidden = new Set(questions.filter((question) => question.hidden).map((question) => question.name))
  return new Set(questions.filter((question) => question.showWhen && hidden.has(question.showWhen.question)).map((question) => question.name))
}

/** Une condition en clair : « si Votre société : Est en cours de création ». */
export function describeCondition(question: Question, questions: readonly Question[]): string | undefined {
  const condition = question.showWhen
  if (!condition) return undefined
  const source = questions.find((candidate) => candidate.name === condition.question)
  if (!source) return undefined
  const tokens = questionTokens(source)
  const labels = condition.values.map((value) => tokens.find((token) => token.value === value)?.label ?? value)
  return `Si « ${source.label} » : ${labels.join(' ou ')}`
}

// --- Lecture de ce qui est rangé en base ------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const optionalString = (value: unknown) => (typeof value === 'string' ? value : undefined)
const optionalNumber = (value: unknown) => (typeof value === 'number' ? value : undefined)

/**
 * Les questions rangées en base, relues comme le code les attend. `undefined`
 * si la forme ou les règles ne tiennent pas : le formulaire repart alors des
 * questions par défaut plutôt que de poser un questionnaire bancal.
 */
export function storedQuestions(json: unknown): Question[] | undefined {
  if (!Array.isArray(json)) return undefined
  const questions: Question[] = []
  for (const raw of json) {
    if (!isRecord(raw) || typeof raw.name !== 'string' || typeof raw.label !== 'string' || typeof raw.kind !== 'string') return undefined
    const question: Question = { name: raw.name, label: raw.label, kind: raw.kind as QuestionKind }
    if (raw.required === true) question.required = true
    if (raw.hidden === true) question.hidden = true
    if (raw.allowOther === true) question.allowOther = true
    if (raw.notBeforeToday === true) question.notBeforeToday = true
    const hint = optionalString(raw.hint)
    if (hint) question.hint = hint
    for (const key of ['min', 'max', 'maxLength'] as const) {
      const value = optionalNumber(raw[key])
      if (value !== undefined) question[key] = value
    }
    if (raw.choices !== undefined) {
      if (!Array.isArray(raw.choices)) return undefined
      const choices: Choice[] = []
      for (const choice of raw.choices) {
        if (!isRecord(choice) || typeof choice.value !== 'string' || typeof choice.label !== 'string') return undefined
        choices.push({ value: choice.value, label: choice.label })
      }
      question.choices = choices
    }
    if (raw.showWhen !== undefined) {
      const condition = raw.showWhen
      if (!isRecord(condition) || typeof condition.question !== 'string' || !Array.isArray(condition.values)) return undefined
      question.showWhen = { question: condition.question, values: condition.values.map(String) }
    }
    questions.push(question)
  }
  return questionnaireProblem(questions) ? undefined : questions
}

