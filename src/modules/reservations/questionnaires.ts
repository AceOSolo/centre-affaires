import type { ProposalProduct } from '../facturation/schema-devis.ts'
import type { ResourceType } from '../ressources/schema.ts'

/**
 * Questions posées au demandeur, par produit (ADR 043).
 *
 * Une seule description sert au formulaire (page publique, espace client,
 * back-office) et à la validation côté serveur : une question ajoutée ici
 * apparaît partout et se valide de la même façon. Le module est pur, pour être
 * éprouvé par `node --test`.
 *
 * Les réponses sont rangées dans `proposals.answers` et transmises à
 * Dolibarr avec leur libellé (`describeAnswers`) : l'accueil et Dolibarr lisent
 * « Nombre de participants : 8 », jamais une clé technique.
 *
 * **Toutes les questions sont à valider par le centre.** Rien ici ne demande
 * plus que ce qu'il faut pour chiffrer (RGPD, minimisation) : les pièces d'une
 * domiciliation et le permis du conducteur se vérifient à la signature et à la
 * remise des clés, pas au devis.
 */

type QuestionKind = 'integer' | 'text' | 'textarea' | 'choice' | 'multi' | 'yesno' | 'date' | 'siren'

export type Question = {
  name: string
  label: string
  kind: QuestionKind
  required?: boolean
  /**
   * Obligatoire seulement si une autre réponse vaut l'une de ces valeurs :
   * le SIREN d'une société déjà immatriculée, pas celui d'un projet.
   */
  requiredWhen?: { question: string; values: readonly string[] }
  hint?: string
  min?: number
  max?: number
  maxLength?: number
  /** Valeurs admises (`choice`, `multi`), avec leur libellé. */
  choices?: readonly { value: string; label: string }[]
}

export type Questionnaire = {
  product: ProposalProduct
  /** Nom du produit tel que le visiteur le choisit. */
  label: string
  description: string
  /** Types de ressources réservables pour ce produit ; vide : sans calendrier. */
  resourceTypes: readonly ResourceType[]
  /**
   * Un devis chiffré automatiquement part tout seul vers Dolibarr ; sinon
   * l'accueil le relit et le valide. **À valider par le centre** : le camion
   * passe par l'accueil (permis, caution), la domiciliation aussi
   * (vérifications légales du domiciliataire).
   */
  autoValidate: boolean
  questions: readonly Question[]
}

const yesNo = [
  { value: 'oui', label: 'Oui' },
  { value: 'non', label: 'Non' },
] as const

export const questionnaires: Record<ProposalProduct, Questionnaire> = {
  espace: {
    product: 'espace',
    label: 'Salle de réunion ou bureau',
    description: 'Une salle pour une réunion, une formation, un entretien, ou un bureau à la journée.',
    resourceTypes: ['salle', 'bureau'],
    autoValidate: true,
    questions: [
      { name: 'participants', label: 'Nombre de participants', kind: 'integer', required: true, min: 1, max: 500 },
      {
        name: 'usage',
        label: 'Type de rendez-vous',
        kind: 'choice',
        required: true,
        choices: [
          { value: 'reunion', label: 'Réunion' },
          { value: 'formation', label: 'Formation' },
          { value: 'entretien', label: 'Entretien ou recrutement' },
          { value: 'seminaire', label: 'Séminaire' },
          { value: 'travail', label: 'Travail individuel' },
          { value: 'autre', label: 'Autre' },
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
  vehicule: {
    product: 'vehicule',
    label: 'Camion ou utilitaire',
    description: 'Un véhicule à l’heure, à la demi-journée ou à la journée.',
    resourceTypes: ['vehicule'],
    autoValidate: false,
    questions: [
      {
        name: 'usage',
        label: 'Pour quel usage ?',
        kind: 'choice',
        required: true,
        choices: [
          { value: 'demenagement', label: 'Déménagement' },
          { value: 'marchandises', label: 'Transport de marchandises' },
          { value: 'livraison', label: 'Livraison' },
          { value: 'autre', label: 'Autre' },
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
  domiciliation: {
    product: 'domiciliation',
    label: 'Domiciliation',
    description: 'L’adresse de votre siège social et la gestion de votre courrier.',
    resourceTypes: [],
    autoValidate: false,
    questions: [
      {
        name: 'situation',
        label: 'Votre société',
        kind: 'choice',
        required: true,
        choices: [
          { value: 'creation', label: 'Est en cours de création' },
          { value: 'immatriculee', label: 'Est déjà immatriculée' },
          { value: 'transfert', label: 'Transfère son siège chez nous' },
        ],
      },
      { name: 'raisonSociale', label: 'Raison sociale ou nom du projet', kind: 'text', required: true, maxLength: 200 },
      {
        name: 'forme',
        label: 'Forme juridique',
        kind: 'choice',
        required: true,
        choices: [
          { value: 'sas', label: 'SAS ou SASU' },
          { value: 'sarl', label: 'SARL ou EURL' },
          { value: 'sci', label: 'SCI' },
          { value: 'ei', label: 'Entreprise individuelle ou micro-entreprise' },
          { value: 'association', label: 'Association' },
          { value: 'autre', label: 'Autre' },
        ],
      },
      {
        name: 'siren',
        label: 'Numéro SIREN',
        kind: 'siren',
        requiredWhen: { question: 'situation', values: ['immatriculee', 'transfert'] },
        hint: 'Neuf chiffres. Pour une société déjà immatriculée.',
      },
      { name: 'debut', label: 'À partir de quand ?', kind: 'date', required: true },
      {
        name: 'courrier',
        label: 'Que faire de votre courrier ?',
        kind: 'choice',
        required: true,
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

/** Le produit d'une ressource réservable ; `undefined` pour un casier ou une boîte aux lettres. */
export function productForResourceType(type: ResourceType): ProposalProduct | undefined {
  if (type === 'salle' || type === 'bureau') return 'espace'
  if (type === 'vehicule') return 'vehicule'
  return undefined
}

export type Answer = string | number | boolean | string[]
export type Answers = Record<string, Answer>

/** Préfixe des champs de formulaire : les questions ne heurtent ni `name` ni `email`. */
export const ANSWER_FIELD_PREFIX = 'q.'

export function answerFieldName(question: Pick<Question, 'name'>): string {
  return `${ANSWER_FIELD_PREFIX}${question.name}`
}

/** Ce qu'un formulaire fournit : `FormData` en a la forme, un test aussi. */
export type AnswerSource = {
  get(name: string): unknown
  getAll(name: string): unknown[]
}

export type ParsedAnswers = { answers: Answers; errors: Record<string, string> }

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function isRealDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

/**
 * Lit et valide les réponses d'un produit. Une réponse vide à une question
 * facultative est absente des réponses, pas une chaîne vide. Une valeur hors
 * des choix est refusée : un `<select>` se réécrit avant l'envoi.
 */
export function parseAnswers(product: ProposalProduct, source: AnswerSource): ParsedAnswers {
  const answers: Answers = {}
  const errors: Record<string, string> = {}
  const { questions } = questionnaires[product]

  for (const question of questions) {
    const field = answerFieldName(question)
    const raw = String(source.get(field) ?? '').trim()
    const allowed = new Set(question.choices?.map((choice) => choice.value))

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
          else if (question.min !== undefined && value < question.min) errors[question.name] = `Au moins ${question.min}.`
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
        else if (raw) answers[question.name] = raw
        break
      case 'siren': {
        const digits = raw.replace(/\s/g, '')
        if (digits && !/^\d{9}$/.test(digits)) errors[question.name] = 'Le SIREN compte neuf chiffres.'
        else if (digits && !luhn(digits)) errors[question.name] = 'Ce SIREN n’est pas valide : vérifiez les chiffres.'
        else if (digits) answers[question.name] = digits
        break
      }
      default:
        if (question.maxLength !== undefined && raw.length > question.maxLength) {
          errors[question.name] = `${question.maxLength} caractères au plus.`
        } else if (raw) answers[question.name] = raw
    }
  }

  for (const question of questions) {
    if (errors[question.name] || answers[question.name] !== undefined) continue
    const condition = question.requiredWhen
    const required =
      question.required || (condition && condition.values.includes(String(answers[condition.question] ?? '')))
    if (required) errors[question.name] = question.kind === 'multi' || question.kind === 'choice' || question.kind === 'yesno'
      ? 'Choisissez une réponse.'
      : 'Ce champ est obligatoire.'
  }

  return { answers, errors }
}

/** Clé de Luhn du SIREN (La Poste exceptée, qui n'a pas de domiciliation). */
function luhn(digits: string): boolean {
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

/**
 * Les réponses en clair, dans l'ordre du questionnaire : ce que l'accueil lit
 * sur le devis et ce que Dolibarr reçoit en note. Une réponse dont la question
 * a disparu du questionnaire reste lisible, sous sa clé.
 */
export function describeAnswers(product: ProposalProduct, answers: Answers): { label: string; value: string }[] {
  const { questions } = questionnaires[product]
  const known = new Set(questions.map((question) => question.name))
  const choiceLabel = (question: Question, value: string) =>
    question.choices?.find((choice) => choice.value === value)?.label ?? value

  const described = questions.flatMap((question) => {
    const value = answers[question.name]
    if (value === undefined) return []
    let text: string
    if (Array.isArray(value)) text = value.map((item) => choiceLabel(question, item)).join(', ')
    else if (typeof value === 'boolean') text = value ? 'Oui' : 'Non'
    else if (question.kind === 'date' && typeof value === 'string') {
      text = new Date(`${value}T12:00:00Z`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
    } else if (typeof value === 'number') text = value.toLocaleString('fr-FR')
    else text = choiceLabel(question, value)
    return [{ label: question.label, value: text }]
  })
  const orphans = Object.entries(answers)
    .filter(([key]) => !known.has(key))
    .map(([key, value]) => ({ label: key, value: Array.isArray(value) ? value.join(', ') : String(value) }))
  return [...described, ...orphans]
}
