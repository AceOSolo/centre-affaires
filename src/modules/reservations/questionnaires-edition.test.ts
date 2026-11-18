import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  conditionSources,
  describeCondition,
  moveQuestion,
  neverShown,
  putQuestion,
  questionFormValues,
  questionFromForm,
  questionnaireProblem,
  readQuestionForm,
  setQuestionHidden,
  slugName,
  slugValue,
  storedQuestions,
  type QuestionFormValues,
} from './questionnaires-edition.ts'
import { defaultQuestionnaires, type Question } from './questionnaires.ts'

const domiciliation = [...defaultQuestionnaires.domiciliation.questions]
const salle = [...defaultQuestionnaires.salle.questions]

const values = (changes: Partial<QuestionFormValues>): QuestionFormValues => ({ ...questionFormValues(), ...changes })

/** Un formulaire minimal : `get` et `getAll`, comme `FormData`. */
function form(entries: Record<string, string | string[]>) {
  return {
    get: (name: string) => {
      const value = entries[name]
      return Array.isArray(value) ? value[0] : value ?? null
    },
    getAll: (name: string) => {
      const value = entries[name]
      return value === undefined ? [] : Array.isArray(value) ? value : [value]
    },
  }
}

describe('noms et valeurs stables (ADR 074)', () => {
  it('nomme une question d’après son libellé, sans heurter un nom pris ni un nom réservé', () => {
    assert.equal(slugName('Nombre de postes', new Set()), 'nombreDePostes')
    assert.equal(slugName('Écran supplémentaire ?', new Set()), 'ecranSupplementaire')
    assert.equal(slugName('Nombre de postes', new Set(['nombreDePostes'])), 'nombreDePostes2')
    assert.equal(slugName('2 roues', new Set()), 'q2Roues')
    assert.equal(slugName('Services', new Set()), 'services2')
  })

  it('donne à un choix une valeur simple, jamais « autre »', () => {
    assert.equal(slugValue('Bureau fermé', new Set()), 'bureau-ferme')
    assert.equal(slugValue('Bureau fermé', new Set(['bureau-ferme'])), 'bureau-ferme-2')
    assert.equal(slugValue('Autre', new Set()), 'autre-2')
    assert.equal(slugValue('!!!', new Set()), 'choix')
  })
})

describe('questionFromForm', () => {
  it('crée une question à choix, avec « Autre » et ses choix tirés des lignes', () => {
    const result = questionFromForm(
      values({ label: 'Type de bureau', kind: 'choice', required: true, allowOther: true, newChoices: 'Bureau fermé\n\nOpen space\n' }),
      salle,
    )
    assert.ok(result.question)
    assert.deepEqual(result.question, {
      name: 'typeDeBureau',
      label: 'Type de bureau',
      kind: 'choice',
      required: true,
      allowOther: true,
      choices: [
        { value: 'bureau-ferme', label: 'Bureau fermé' },
        { value: 'open-space', label: 'Open space' },
      ],
    })
  })

  it('garde le nom et la valeur des choix d’une question modifiée, renomme un choix, en retire un', () => {
    const usage = salle.find((question) => question.name === 'usage')!
    const current = questionFormValues(usage)
    const result = questionFromForm(
      { ...current, label: 'Motif', choiceLabels: { ...current.choiceLabels, reunion: 'Réunion d’équipe' }, removedChoices: ['seminaire'] },
      salle,
      usage,
    )
    assert.ok(result.question)
    assert.equal(result.question.name, 'usage')
    assert.equal(result.question.label, 'Motif')
    assert.deepEqual(result.question.choices?.map((choice) => choice.value), ['reunion', 'formation', 'entretien', 'travail'])
    assert.equal(result.question.choices?.[0].label, 'Réunion d’équipe')
  })

  it('refuse une question sans libellé, un choix sans choix, des bornes inversées', () => {
    assert.equal(questionFromForm(values({ label: '', kind: 'text' }), salle).errors?.label, 'Saisissez la question.')
    assert.equal(questionFromForm(values({ label: 'Couleur', kind: 'choice' }), salle).errors?.choices, 'Proposez au moins un choix.')
    assert.equal(questionFromForm(values({ label: 'Âge', kind: 'integer', min: '10', max: '2' }), salle).errors?.max, 'Le maximum est inférieur au minimum.')
    assert.equal(questionFromForm(values({ label: 'Âge', kind: 'integer', min: 'dix' }), salle).errors?.min, 'Saisissez un nombre entier.')
  })

  it('accepte une condition sur une question à choix posée avant, et la refuse sur deux questions', () => {
    const shown = questionFromForm(values({ label: 'Code APE', kind: 'text', condition: ['situation:immatriculee'] }), domiciliation)
    assert.deepEqual(shown.question?.showWhen, { question: 'situation', values: ['immatriculee'] })
    const twice = questionFromForm(values({ label: 'Code APE', kind: 'text', condition: ['situation:immatriculee', 'forme:sas'] }), domiciliation)
    assert.match(twice.errors?.condition ?? '', /Une seule question/)
    const unknown = questionFromForm(values({ label: 'Code APE', kind: 'text', condition: ['situation:transfert'] }), domiciliation)
    assert.match(unknown.errors?.condition ?? '', /Choisissez des réponses/)
    // Pas de chaîne : une question conditionnelle ne conditionne pas.
    const chained = questionFromForm(values({ label: 'Greffe', kind: 'text', condition: ['nomProjet:x'] }), domiciliation)
    assert.match(chained.errors?.condition ?? '', /posée avant elle, sans condition/)
  })

  it('ne retire pas un choix dont une autre question dépend', () => {
    const situation = domiciliation.find((question) => question.name === 'situation')!
    const result = questionFromForm({ ...questionFormValues(situation), removedChoices: ['creation'] }, domiciliation, situation)
    assert.match(result.errors?.choices ?? '', /ne s’affiche que selon un choix/)
  })

  it('lit le formulaire d’écran', () => {
    const usage = salle.find((question) => question.name === 'usage')!
    const read = readQuestionForm(
      form({ label: ' Motif ', kind: 'choice', required: 'on', 'choix.reunion': 'Réunion', retirer: ['travail'], newChoices: 'Atelier', condition: [] }),
      usage,
    )
    assert.equal(read.label, 'Motif')
    assert.equal(read.required, true)
    assert.equal(read.allowOther, false)
    assert.equal(read.choiceLabels.reunion, 'Réunion')
    assert.deepEqual(read.removedChoices, ['travail'])
  })
})

describe('ordre, masquage et règles du questionnaire', () => {
  it('monte et descend une question, sans sortir de la liste', () => {
    const names = (questions: readonly Question[]) => questions.map((question) => question.name)
    assert.deepEqual(names(moveQuestion(salle, 'usage', 'up')).slice(0, 2), ['usage', 'participants'])
    assert.deepEqual(names(moveQuestion(salle, 'participants', 'up')), names(salle))
    assert.deepEqual(names(moveQuestion(salle, 'accessibilite', 'down')), names(salle))
  })

  it('refuse un questionnaire où une condition passerait avant sa question', () => {
    const moved = moveQuestion(domiciliation, 'nomProjet', 'up')
    assert.match(questionnaireProblem(moved) ?? '', /Nom du projet/)
    assert.equal(questionnaireProblem(domiciliation), undefined)
  })

  it('masque et repose une question ; celles qui en dépendent ne s’affichent plus', () => {
    const hidden = setQuestionHidden(domiciliation, 'situation', true)
    assert.equal(hidden.find((question) => question.name === 'situation')?.hidden, true)
    assert.deepEqual([...neverShown(hidden)].sort(), ['dateImmatriculation', 'nomProjet', 'raisonSociale', 'siret'])
    const back = setQuestionHidden(hidden, 'situation', false)
    assert.equal('hidden' in back.find((question) => question.name === 'situation')!, false)
  })

  it('remplace une question par son nom, ou l’ajoute à la fin', () => {
    const changed = putQuestion(salle, { ...salle[0], label: 'Combien serez-vous ?' })
    assert.equal(changed[0].label, 'Combien serez-vous ?')
    assert.equal(changed.length, salle.length)
    assert.equal(putQuestion(salle, { name: 'parking', label: 'Parking ?', kind: 'yesno' }).length, salle.length + 1)
  })

  it('dit une condition en clair et propose les seules questions qui peuvent conditionner', () => {
    const siret = domiciliation.find((question) => question.name === 'siret')!
    assert.equal(describeCondition(siret, domiciliation), 'Si « Votre société » : Est déjà immatriculée')
    assert.deepEqual(conditionSources(domiciliation, 'siret').map((question) => question.name), ['situation'])
  })
})

describe('storedQuestions', () => {
  it('relit des questions rangées en base, et refuse une forme bancale', () => {
    assert.deepEqual(storedQuestions(JSON.parse(JSON.stringify(domiciliation))), domiciliation)
    assert.equal(storedQuestions({}), undefined)
    assert.equal(storedQuestions([{ name: 'x' }]), undefined)
    assert.equal(storedQuestions([{ name: 'a', label: 'A', kind: 'choice', choices: [] }]), undefined)
    assert.equal(storedQuestions([{ name: 'a', label: 'A', kind: 'inconnu' }]), undefined)
  })
})
