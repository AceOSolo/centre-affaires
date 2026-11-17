import type { ProposalProduct } from '../facturation/schema-devis.ts'
import type { ResourceType } from '../ressources/schema.ts'

/**
 * Questions posées au demandeur, par formulaire (ADR 043, ADR 074).
 *
 * Un formulaire par service vendu : salle, bureau, camion, matériel,
 * domiciliation. Le centre règle ses questions à l'écran (Réglages >
 * Formulaires de demande) ; ce qui est écrit ici est la valeur par défaut,
 * servie tant que le centre n'y a pas touché (`questionnaires-queries.ts`).
 *
 * Une seule description sert au formulaire (page publique, espace client,
 * back-office) et à la validation côté serveur (`parseAnswers`). Le module est
 * pur, pour être éprouvé par `node --test`.
 *
 * Les réponses sont rangées dans `proposals.answers`, et leur version en clair
 * (`describeAnswers`) est figée sur le devis à l'envoi
 * (`proposals.described_answers`) : un devis ancien reste lisible quand le
 * centre change ses questions.
 *
 * **Rien ne demande plus que ce qu'il faut pour chiffrer** (RGPD,
 * minimisation) : les pièces d'une domiciliation et le permis du conducteur se
 * vérifient à la signature et à la remise des clés, pas au devis.
 */

/** Les formulaires de demande, un par service vendu (ADR 074). */
export const formulaires = ['salle', 'bureau', 'vehicule', 'materiel', 'domiciliation'] as const
export type Formulaire = (typeof formulaires)[number]

export function isFormulaire(value: unknown): value is Formulaire {
  return typeof value === 'string' && (formulaires as readonly string[]).includes(value)
}

export const questionKinds = ['integer', 'text', 'textarea', 'choice', 'multi', 'yesno', 'date', 'siret'] as const
export type QuestionKind = (typeof questionKinds)[number]

export const questionKindLabels: Record<QuestionKind, string> = {
  integer: 'Nombre entier',
  text: 'Texte court',
  textarea: 'Texte long',
  choice: 'Choix unique',
  multi: 'Choix multiple',
  yesno: 'Oui ou non',
  date: 'Date',
  siret: 'Numéro SIRET',
}

export type Choice = { value: string; label: string }

/** « Affichée et obligatoire si » : la réponse à `question` est l'une de `values`. */
export type Condition = { question: string; values: readonly string[] }

export type Question = {
  /** Clé stable de la réponse : ne change jamais, même si le libellé change. */
  name: string
  label: string
  kind: QuestionKind
  required?: boolean
  hint?: string
  min?: number
  max?: number
  maxLength?: number
  /** Valeurs admises (`choice`, `multi`), avec leur libellé. */
  choices?: readonly Choice[]
  /** Propose « Autre », qui ouvre un champ libre (`choice`, `multi`). */
  allowOther?: boolean
  /** Affichée seulement si une autre réponse vaut l'une de ces valeurs ; masquée, ni envoyée ni exigée. */
  showWhen?: Condition
  /** Date qui ne peut pas être passée, quand l'appelant donne le jour du centre (`today`). */
  notBeforeToday?: boolean
  /** Masquée par le centre : plus posée, mais ses réponses anciennes restent lisibles. */
  hidden?: boolean
}

export type Questionnaire = {
  form: Formulaire
  product: ProposalProduct
  /** Nom du service tel que le visiteur le choisit. */
  label: string
  description: string
  questions: readonly Question[]
}

/**
 * Ce qui ne se règle pas à l'écran : le produit du devis de chaque formulaire,
 * les types de ressource qu'il réserve, et si son devis part seul vers
 * Dolibarr. **À valider par le centre** (ADR 043) : le camion passe par
 * l'accueil (permis, caution), la domiciliation aussi (vérifications légales
 * du domiciliataire).
 */
export const requestProducts: Record<
  ProposalProduct,
  { label: string; description: string; resourceTypes: readonly ResourceType[]; autoValidate: boolean; forms: readonly Formulaire[] }
> = {
  espace: {
    label: 'Salle de réunion ou bureau',
    description: 'Une salle pour une réunion, une formation, un entretien, ou un bureau à la journée.',
    resourceTypes: ['salle', 'bureau'],
    autoValidate: true,
    forms: ['salle', 'bureau'],
  },
  vehicule: {
    label: 'Camion ou utilitaire',
    description: 'Un véhicule à l’heure, à la journée ou sur plusieurs jours.',
    resourceTypes: ['vehicule'],
    autoValidate: false,
    forms: ['vehicule'],
  },
  domiciliation: {
    label: 'Domiciliation',
    description: 'L’adresse de votre siège social et la gestion de votre courrier.',
    resourceTypes: [],
    autoValidate: false,
    forms: ['domiciliation'],
  },
  // Le matériel loué seul (ADR 062) ; loué avec une salle, il s'ajoute au
  // devis de la salle et ne pose pas ces questions.
  materiel: {
    label: 'Location de matériel',
    description: 'Une télévision, une climatisation, un vidéoprojecteur… à la journée ou sur plusieurs jours.',
    resourceTypes: ['materiel'],
    autoValidate: false,
    forms: ['materiel'],
  },
}

/** Types de ressource réservés par chaque formulaire ; vide : sans calendrier. */
export const formResourceTypes: Record<Formulaire, readonly ResourceType[]> = {
  salle: ['salle'],
  bureau: ['bureau'],
  vehicule: ['vehicule'],
  materiel: ['materiel'],
  domiciliation: [],
}

export function productOfForm(form: Formulaire): ProposalProduct {
  return form === 'salle' || form === 'bureau' ? 'espace' : form
}

/** Le produit d'une ressource réservable ; `undefined` pour un casier ou une boîte aux lettres. */
export function productForResourceType(type: ResourceType): ProposalProduct | undefined {
  const form = formForResourceType(type)
  return form ? productOfForm(form) : undefined
}

/** Le formulaire d'une ressource réservable : une salle a le sien, un bureau le sien. */
export function formForResourceType(type: ResourceType): Formulaire | undefined {
  return formulaires.find((form) => formResourceTypes[form].includes(type))
}

/** La valeur de « Autre » dans les réponses ; le texte libre suit sous `<nom>.autre`. */
export const OTHER_VALUE = 'autre'
export const OTHER_LABEL = 'Autre'

/**
 * Clés de réponse que le code relit (ADR 074) : la raison sociale ou le projet
 * nomment le demandeur, le SIRET part vers Dolibarr. Un centre peut masquer
 * ces questions ; il ne peut pas les renommer.
 */
export const DOMICILIATION_KEYS = {
  situation: 'situation',
  projectName: 'nomProjet',
  companyName: 'raisonSociale',
  siret: 'siret',
} as const

/** Réservé aux options tarifées de la domiciliation (`domiciliation-tarif.ts`). */
export const SERVICES_ANSWER_KEY = 'services'

export const defaultQuestionnaires: Record<Formulaire, Questionnaire> = {
  salle: {
    form: 'salle',
    product: 'espace',
    label: 'Salle de réunion',
    description: 'Une salle pour une réunion, une formation, un entretien ou un séminaire.',
    questions: [
      { name: 'participants', label: 'Nombre de participants', kind: 'integer', required: true, min: 1, max: 500 },
      {
        name: 'usage',
        label: 'Type de rendez-vous',
        kind: 'choice',
        required: true,
        allowOther: true,
        choices: [
          { value: 'reunion', label: 'Réunion' },
          { value: 'formation', label: 'Formation' },
          { value: 'entretien', label: 'Entretien ou recrutement' },
          { value: 'seminaire', label: 'Séminaire' },
          { value: 'travail', label: 'Travail individuel' },
        ],
      },
      {
        name: 'disposition',
        label: 'Disposition souhaitée',
        kind: 'choice',
        choices: [
          { value: 'indifferent', label: 'Peu importe' },
          { value: 'table', label: 'Autour d’une table' },
          { value: 'classe', label: 'En salle de classe' },
          { value: 'u', label: 'En U' },
          { value: 'theatre', label: 'En théâtre' },
        ],
      },
      {
        name: 'equipements',
        label: 'Équipements souhaités',
        kind: 'multi',
        choices: [
          { value: 'ecran', label: 'Écran ou vidéoprojecteur' },
          { value: 'visio', label: 'Visioconférence' },
          { value: 'paperboard', label: 'Paperboard' },
        ],
      },
      {
        name: 'restauration',
        label: 'Restauration',
        kind: 'multi',
        hint: 'Chiffrée par l’accueil en complément du devis.',
        choices: [
          { value: 'cafe', label: 'Café d’accueil' },
          { value: 'petit-dejeuner', label: 'Petit-déjeuner' },
          { value: 'collation', label: 'Collation' },
          { value: 'dejeuner', label: 'Déjeuner' },
        ],
      },
      { name: 'accessibilite', label: 'Un participant a-t-il besoin d’un accès adapté (PMR) ?', kind: 'yesno' },
    ],
  },
  bureau: {
    form: 'bureau',
    product: 'espace',
    label: 'Bureau',
    description: 'Un bureau fermé ou un poste en open space, pour travailler au calme.',
    questions: [
      { name: 'participants', label: 'Nombre de personnes', kind: 'integer', required: true, min: 1, max: 50 },
      {
        name: 'espace',
        label: 'Vous cherchez',
        kind: 'choice',
        required: true,
        choices: [
          { value: 'ferme', label: 'Un bureau fermé' },
          { value: 'open-space', label: 'Un poste en open space' },
          { value: 'indifferent', label: 'Peu importe' },
        ],
      },
      {
        name: 'usage',
        label: 'Pour quel usage ?',
        kind: 'choice',
        allowOther: true,
        choices: [
          { value: 'travail', label: 'Travail individuel' },
          { value: 'equipe', label: 'Travail en équipe' },
          { value: 'rendez-vous', label: 'Rendez-vous ou entretien' },
        ],
      },
      {
        name: 'equipements',
        label: 'Équipements souhaités',
        kind: 'multi',
        choices: [
          { value: 'ecran', label: 'Écran supplémentaire' },
          { value: 'visio', label: 'Visioconférence' },
        ],
      },
      { name: 'accessibilite', label: 'Une personne a-t-elle besoin d’un accès adapté (PMR) ?', kind: 'yesno' },
    ],
  },
  vehicule: {
    form: 'vehicule',
    product: 'vehicule',
    label: 'Camion ou utilitaire',
    description: 'Un véhicule à l’heure, à la journée ou sur plusieurs jours.',
    questions: [
      {
        name: 'usage',
        label: 'Pour quel usage ?',
        kind: 'choice',
        required: true,
        allowOther: true,
        choices: [
          { value: 'demenagement', label: 'Déménagement' },
          { value: 'marchandises', label: 'Transport de marchandises' },
          { value: 'livraison', label: 'Livraison' },
        ],
      },
      { name: 'trajet', label: 'Trajet prévu', kind: 'text', required: true, maxLength: 200, hint: 'Villes de départ et d’arrivée.' },
      { name: 'kilometres', label: 'Kilomètres estimés', kind: 'integer', min: 1, max: 10_000 },
      { name: 'chargement', label: 'Que transportez-vous ?', kind: 'text', maxLength: 200, hint: 'Volume ou nature du chargement.' },
      {
        name: 'permis',
        label: 'Le conducteur a-t-il le permis B depuis au moins deux ans ?',
        kind: 'yesno',
        required: true,
        hint: 'Le permis est vérifié à la remise des clés.',
      },
    ],
  },
  // Passe par l'accueil, comme le camion : le matériel qui quitte le centre se
  // remet en main propre (ADR 062).
  materiel: {
    form: 'materiel',
    product: 'materiel',
    label: 'Location de matériel',
    description: 'Une télévision, une climatisation, un vidéoprojecteur… à la journée ou sur plusieurs jours.',
    questions: [
      {
        name: 'lieu',
        label: 'Où le matériel sera-t-il utilisé ?',
        kind: 'choice',
        required: true,
        choices: [
          { value: 'centre', label: 'Dans le centre' },
          { value: 'exterieur', label: 'À l’extérieur du centre' },
        ],
      },
      {
        name: 'installation',
        label: 'Souhaitez-vous la livraison ou l’installation ?',
        kind: 'yesno',
        hint: 'Chiffrée par l’accueil en complément du devis.',
      },
      { name: 'usage', label: 'Pour quel usage ?', kind: 'text', maxLength: 200, hint: 'Présentation, salon, événement…' },
    ],
  },
  // Deux situations seulement (recette du 17/11) : un transfert de siège est
  // une société déjà immatriculée. Plus de question sur le courrier ni de
  // « services en plus » : les options tarifées viennent du catalogue reçu de
  // Dolibarr (`domiciliation-tarif.ts`).
  domiciliation: {
    form: 'domiciliation',
    product: 'domiciliation',
    label: 'Domiciliation',
    description: 'L’adresse de votre siège social et la gestion de votre courrier.',
    questions: [
      {
        name: 'situation',
        label: 'Votre société',
        kind: 'choice',
        required: true,
        hint: 'Un transfert de siège concerne une société déjà immatriculée.',
        choices: [
          { value: 'creation', label: 'Est en cours de création' },
          { value: 'immatriculee', label: 'Est déjà immatriculée' },
        ],
      },
      {
        name: 'nomProjet',
        label: 'Nom du projet',
        kind: 'text',
        required: true,
        maxLength: 200,
        showWhen: { question: 'situation', values: ['creation'] },
      },
      {
        name: 'dateImmatriculation',
        label: 'Date prévue d’immatriculation',
        kind: 'date',
        notBeforeToday: true,
        showWhen: { question: 'situation', values: ['creation'] },
      },
      {
        name: 'raisonSociale',
        label: 'Raison sociale',
        kind: 'text',
        required: true,
        maxLength: 200,
        showWhen: { question: 'situation', values: ['immatriculee'] },
      },
      {
        name: 'siret',
        label: 'Numéro SIRET',
        kind: 'siret',
        required: true,
        hint: 'Quatorze chiffres, sur l’extrait Kbis ou l’avis de situation Insee.',
        showWhen: { question: 'situation', values: ['immatriculee'] },
      },
      {
        name: 'forme',
        label: 'Forme juridique',
        kind: 'choice',
        required: true,
        allowOther: true,
        choices: [
          { value: 'sas', label: 'SAS ou SASU' },
          { value: 'sarl', label: 'SARL ou EURL' },
          { value: 'sci', label: 'SCI' },
          { value: 'ei', label: 'Entreprise individuelle ou micro-entreprise' },
          { value: 'association', label: 'Association' },
        ],
      },
      { name: 'debut', label: 'À partir de quand ?', kind: 'date', required: true, notBeforeToday: true },
      {
        name: 'engagement',
        label: 'Durée envisagée',
        kind: 'choice',
        required: true,
        choices: [
          { value: '3', label: '3 mois' },
          { value: '6', label: '6 mois' },
          { value: '12', label: '12 mois' },
          { value: 'indefinie', label: 'Je ne sais pas encore' },
        ],
      },
    ],
  },
}

export type Answer = string | number | boolean | string[]
export type Answers = Record<string, Answer>

/** Préfixe des champs de formulaire : les questions ne heurtent ni `name` ni `email`. */
export const ANSWER_FIELD_PREFIX = 'q.'

export function answerFieldName(question: Pick<Question, 'name'>): string {
  return `${ANSWER_FIELD_PREFIX}${question.name}`
}

/** Clé du texte libre de « Autre » dans les réponses : `usage.autre`. */
export function otherAnswerKey(question: Pick<Question, 'name'>): string {
  return `${question.name}.${OTHER_VALUE}`
}

/** Champ du texte libre de « Autre » : `q.usage.autre`. */
export function otherFieldName(question: Pick<Question, 'name'>): string {
  return `${ANSWER_FIELD_PREFIX}${otherAnswerKey(question)}`
}

/** Longueur du texte libre de « Autre ». */
export const OTHER_MAX_LENGTH = 200

/** Ce qu'un formulaire fournit : `FormData` en a la forme, un test aussi. */
export type AnswerSource = {
  get(name: string): unknown
  getAll(name: string): unknown[]
}

export type ParsedAnswers = { answers: Answers; errors: Record<string, string> }

/** Les valeurs d'une réponse, comme une condition les compare : `oui`/`non` pour un booléen. */
export function answerTokens(answer: Answer | undefined): string[] {
  if (answer === undefined) return []
  if (Array.isArray(answer)) return answer
  if (typeof answer === 'boolean') return [answer ? 'oui' : 'non']
  return [String(answer)]
}

/** Les questions posées : celles que le centre n'a pas masquées. */
export function askedQuestions(questionnaire: Pick<Questionnaire, 'questions'>): Question[] {
  return questionnaire.questions.filter((question) => !question.hidden)
}

/**
 * La question est-elle affichée, vu les réponses ? Sans condition, oui ; avec,
 * si la question dont elle dépend est posée et que sa réponse convient.
 */
export function isShown(question: Question, answers: Answers, questions: readonly Question[]): boolean {
  if (question.hidden) return false
  const condition = question.showWhen
  if (!condition) return true
  const source = questions.find((candidate) => candidate.name === condition.question)
  if (!source || source.hidden) return false
  return answerTokens(answers[condition.question]).some((token) => condition.values.includes(token))
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function isRealDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

/**
 * Lit et valide les réponses d'un formulaire. Une réponse vide à une question
 * facultative est absente des réponses, pas une chaîne vide. Une valeur hors
 * des choix est refusée : un champ se réécrit avant l'envoi. Une question
 * masquée (par le centre ou par sa condition) n'est ni gardée ni exigée.
 */
export function parseAnswers(
  questionnaire: Pick<Questionnaire, 'questions'>,
  source: AnswerSource,
  /**
   * `today` : le jour du centre (`AAAA-MM-JJ`). Donné par la page publique et
   * l'espace client, une date `notBeforeToday` passée y est refusée ; omis au
   * back-office, où l'accueil peut régulariser une date.
   */
  options: { today?: string } = {},
): ParsedAnswers {
  const answers: Answers = {}
  const errors: Record<string, string> = {}
  const questions = askedQuestions(questionnaire)

  for (const question of questions) {
    const field = answerFieldName(question)
    const raw = String(source.get(field) ?? '').trim()
    const allowed = new Set(question.choices?.map((choice) => choice.value))
    if (question.allowOther) allowed.add(OTHER_VALUE)

    switch (question.kind) {
      case 'multi': {
        const values = [...new Set(source.getAll(field).map((value) => String(value).trim()).filter(Boolean))]
        if (values.some((value) => !allowed.has(value))) errors[question.name] = 'Choix inconnu.'
        else if (values.length > 0) answers[question.name] = values
        break
      }
      case 'yesno':
        if (raw === 'oui') answers[question.name] = true
        else if (raw === 'non') answers[question.name] = false
        else if (raw) errors[question.name] = 'Répondez par oui ou par non.'
        break
      case 'integer':
        if (raw) {
          const value = Number(raw.replace(/\s/g, ''))
          if (!Number.isInteger(value)) errors[question.name] = 'Saisissez un nombre entier.'
          else if (question.min !== undefined && value < question.min) errors[question.name] = `Au moins ${question.min.toLocaleString('fr-FR')}.`
          else if (question.max !== undefined && value > question.max) errors[question.name] = `Au plus ${question.max.toLocaleString('fr-FR')}.`
          else answers[question.name] = value
        }
        break
      case 'choice':
        if (raw && !allowed.has(raw)) errors[question.name] = 'Choix inconnu.'
        else if (raw) answers[question.name] = raw
        break
      case 'date':
        if (raw && !isRealDate(raw)) errors[question.name] = 'Saisissez une date valide.'
        else if (raw && question.notBeforeToday && options.today && raw < options.today) {
          errors[question.name] = 'Choisissez une date à partir d’aujourd’hui.'
        } else if (raw) answers[question.name] = raw
        break
      case 'siret': {
        const digits = raw.replace(/[\s.]/g, '')
        if (digits && !/^\d{14}$/.test(digits)) errors[question.name] = 'Le SIRET compte quatorze chiffres.'
        else if (digits && !isValidSiret(digits)) errors[question.name] = 'Ce SIRET n’est pas valide : vérifiez les chiffres.'
        else if (digits) answers[question.name] = digits
        break
      }
      default:
        if (question.maxLength !== undefined && raw.length > question.maxLength) {
          errors[question.name] = `${question.maxLength.toLocaleString('fr-FR')} caractères au plus.`
        } else if (raw) answers[question.name] = raw
    }

    // « Autre » choisi : le texte libre qui le précise.
    if (question.allowOther && answerTokens(answers[question.name]).includes(OTHER_VALUE)) {
      const other = String(source.get(otherFieldName(question)) ?? '').trim()
      if (other.length > OTHER_MAX_LENGTH) errors[otherAnswerKey(question)] = `${OTHER_MAX_LENGTH} caractères au plus.`
      else if (other) answers[otherAnswerKey(question)] = other
      else if (question.required) errors[otherAnswerKey(question)] = 'Précisez votre réponse.'
    }
  }

  // Une question que sa condition masque n'est ni gardée ni exigée.
  for (const question of questions) {
    if (isShown(question, answers, questions)) continue
    delete answers[question.name]
    delete answers[otherAnswerKey(question)]
    delete errors[question.name]
    delete errors[otherAnswerKey(question)]
  }

  for (const question of questions) {
    if (errors[question.name] || answers[question.name] !== undefined || !question.required) continue
    if (!isShown(question, answers, questions)) continue
    errors[question.name] = question.kind === 'multi' || question.kind === 'choice' || question.kind === 'yesno'
      ? 'Choisissez une réponse.'
      : 'Ce champ est obligatoire.'
  }

  return { answers, errors }
}

/** Libellés des questions par nom de champ, pour le résumé d'erreurs (`ErrorSummary`). */
export function questionnaireErrorLabels(questionnaire: Pick<Questionnaire, 'questions'>): Record<string, string> {
  return Object.fromEntries(
    questionnaire.questions.flatMap((question) => [
      [answerFieldName(question), question.label],
      ...(question.allowOther ? [[otherFieldName(question), `${question.label} (précision)`]] : []),
    ]),
  )
}

/** Erreurs de `parseAnswers` (par question) rangées par nom de champ, comme les attend `ErrorSummary`. */
export function errorsByField(errors: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(errors).map(([question, message]) => [answerFieldName({ name: question }), message]))
}

/** Clé de Luhn, sur un SIREN (9 chiffres) comme sur un SIRET (14). */
export function luhn(digits: string): boolean {
  let sum = 0
  for (let index = 0; index < digits.length; index++) {
    let digit = Number(digits[digits.length - 1 - index])
    if (index % 2 === 1) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
  }
  return sum % 10 === 0
}

/** SIREN de La Poste, dont les établissements dérogent à la clé de Luhn. */
export const LA_POSTE_SIREN = '356000000'

/**
 * SIRET valide : quatorze chiffres, clé de Luhn. **Exception La Poste** : ses
 * milliers d'établissements partagent le SIREN 356 000 000 et leur SIRET ne
 * suit pas Luhn ; l'Insee y vérifie que la somme des quatorze chiffres est un
 * multiple de 5. Son siège (356 000 000 00048) suit Luhn, lui.
 */
export function isValidSiret(digits: string): boolean {
  if (!/^\d{14}$/.test(digits)) return false
  if (luhn(digits)) return true
  if (!digits.startsWith(LA_POSTE_SIREN)) return false
  const sum = [...digits].reduce((total, digit) => total + Number(digit), 0)
  return sum % 5 === 0
}

/** Une réponse en clair, telle que l'accueil et Dolibarr la lisent. */
export type DescribedAnswer = { name: string; label: string; value: string }

/** « 732 829 320 00074 » */
function formatSiret(digits: string): string {
  return /^\d{14}$/.test(digits) ? digits.replace(/^(\d{3})(\d{3})(\d{3})(\d{5})$/, '$1 $2 $3 $4') : digits
}

/**
 * Les réponses en clair, dans l'ordre du questionnaire : ce que l'accueil lit
 * sur le devis et ce que Dolibarr reçoit en note. Une réponse dont la question
 * a disparu du questionnaire reste lisible, sous sa clé.
 */
export function describeAnswers(questionnaire: Pick<Questionnaire, 'questions'>, answers: Answers): DescribedAnswer[] {
  const { questions } = questionnaire
  const known = new Set(questions.flatMap((question) => [question.name, otherAnswerKey(question)]))
  const choiceLabel = (question: Question, value: string) => {
    if (question.allowOther && value === OTHER_VALUE) {
      const other = answers[otherAnswerKey(question)]
      return typeof other === 'string' && other ? `${OTHER_LABEL} : ${other}` : OTHER_LABEL
    }
    return question.choices?.find((choice) => choice.value === value)?.label ?? value
  }

  const described = questions.flatMap((question) => {
    const value = answers[question.name]
    if (value === undefined) return []
    let text: string
    if (Array.isArray(value)) text = value.map((item) => choiceLabel(question, item)).join(', ')
    else if (typeof value === 'boolean') text = value ? 'Oui' : 'Non'
    else if (question.kind === 'date' && typeof value === 'string') {
      text = new Date(`${value}T12:00:00Z`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
    } else if (typeof value === 'number') text = value.toLocaleString('fr-FR')
    else if (question.kind === 'siret') text = formatSiret(value)
    else text = choiceLabel(question, value)
    return [{ name: question.name, label: question.label, value: text }]
  })
  const orphans = Object.entries(answers)
    .filter(([key]) => !known.has(key) && key !== SERVICES_ANSWER_KEY)
    .map(([key, value]) => ({ name: key, label: key, value: Array.isArray(value) ? value.join(', ') : String(value) }))
  return [...described, ...orphans]
}

/**
 * Questions retirées depuis (ADR 074), pour lire en clair un devis antérieur à
 * la réponse figée (`described_answers` nul) : il a été posé avec les
 * questions du code d'alors. Elles priment, par leur nom, sur celles d'aujourd'hui.
 */
const formerQuestions: Partial<Record<ProposalProduct, readonly Question[]>> = {
  domiciliation: [
    {
      name: 'situation',
      label: 'Votre société',
      kind: 'choice',
      choices: [
        { value: 'creation', label: 'Est en cours de création' },
        { value: 'immatriculee', label: 'Est déjà immatriculée' },
        { value: 'transfert', label: 'Transfère son siège chez nous' },
      ],
    },
    { name: 'raisonSociale', label: 'Raison sociale ou nom du projet', kind: 'text' },
    { name: 'siren', label: 'Numéro SIREN', kind: 'text' },
    {
      name: 'courrier',
      label: 'Que faire de votre courrier ?',
      kind: 'choice',
      choices: [
        { value: 'sur-place', label: 'Je viens le chercher' },
        { value: 'numerisation', label: 'Le numériser et me l’envoyer par courriel' },
        { value: 'reexpedition-hebdo', label: 'Le réexpédier chaque semaine' },
        { value: 'reexpedition-mensuelle', label: 'Le réexpédier chaque mois' },
      ],
    },
    {
      name: 'options',
      label: 'Services en plus',
      kind: 'multi',
      choices: [
        { value: 'standard', label: 'Permanence téléphonique' },
        { value: 'salles', label: 'Salles de réunion de temps en temps' },
        { value: 'bureau', label: 'Bureau à la journée de temps en temps' },
      ],
    },
  ],
}

/** Les questions d'avant la réponse figée, pour un produit : celles du code d'alors. */
export function formerQuestionnaire(product: ProposalProduct): Pick<Questionnaire, 'questions'> {
  // Un devis d'espace d'alors posait les questions de la salle d'aujourd'hui.
  const current = defaultQuestionnaires[requestProducts[product].forms[0]].questions
  const former = formerQuestions[product] ?? []
  const currentNames = new Set(current.map((question) => question.name))
  return {
    questions: [
      ...current.map((question) => former.find((candidate) => candidate.name === question.name) ?? question),
      ...former.filter((question) => !currentNames.has(question.name)),
    ],
  }
}

/**
 * Les réponses d'un devis en clair : figées à l'envoi (ADR 074), ou, pour un
 * devis plus ancien, lues avec les questions du code d'alors.
 */
export function answersForDisplay(proposal: {
  product: ProposalProduct
  answers: Answers
  describedAnswers?: readonly DescribedAnswer[] | null
}): DescribedAnswer[] {
  if (Array.isArray(proposal.describedAnswers)) return [...proposal.describedAnswers]
  return describeAnswers(formerQuestionnaire(proposal.product), proposal.answers)
}
