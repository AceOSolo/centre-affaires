import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { proposalProducts } from '../facturation/schema-devis.ts'
import { answerFieldName, describeAnswers, parseAnswers, productForResourceType, questionnaires } from './questionnaires.ts'

/** Un formulaire minimal : `get` et `getAll`, comme `FormData`. */
function form(values: Record<string, string | string[]>) {
  return {
    get: (name: string) => {
      const value = values[name]
      return Array.isArray(value) ? value[0] : value ?? null
    },
    getAll: (name: string) => {
      const value = values[name]
      return value === undefined ? [] : Array.isArray(value) ? value : [value]
    },
  }
}

const q = (name: string) => answerFieldName({ name })

describe('questionnaires par produit', () => {
  it('décrit les trois produits, chacun avec des questions aux noms uniques', () => {
    for (const product of proposalProducts) {
      const names = questionnaires[product].questions.map((question) => question.name)
      assert.ok(names.length > 0, product)
      assert.equal(new Set(names).size, names.length, product)
    }
  })

  it('range chaque ressource réservable sous son produit', () => {
    assert.equal(productForResourceType('salle'), 'espace')
    assert.equal(productForResourceType('bureau'), 'espace')
    assert.equal(productForResourceType('vehicule'), 'vehicule')
    assert.equal(productForResourceType('boite_aux_lettres'), undefined)
    assert.equal(productForResourceType('casier'), undefined)
  })

  it('ne valide d’office que les espaces chiffrés (à valider par le centre)', () => {
    assert.equal(questionnaires.espace.autoValidate, true)
    assert.equal(questionnaires.vehicule.autoValidate, false)
    assert.equal(questionnaires.domiciliation.autoValidate, false)
  })
})

describe('parseAnswers', () => {
  it('lit les réponses d’une salle, choix multiples et oui/non compris', () => {
    const { answers, errors } = parseAnswers(
      'espace',
      form({
        [q('participants')]: '8',
        [q('usage')]: 'formation',
        [q('equipements')]: ['ecran', 'visio', 'ecran'],
        [q('accessibilite')]: 'non',
        [q('disposition')]: '',
      }),
    )
    assert.deepEqual(errors, {})
    assert.deepEqual(answers, { participants: 8, usage: 'formation', equipements: ['ecran', 'visio'], accessibilite: false })
  })

  it('exige les réponses obligatoires', () => {
    const { errors } = parseAnswers('espace', form({}))
    assert.deepEqual(Object.keys(errors).sort(), ['participants', 'usage'])
  })

  it('refuse un choix inventé et un nombre hors bornes', () => {
    const { errors } = parseAnswers(
      'espace',
      form({ [q('participants')]: '0', [q('usage')]: 'concert', [q('equipements')]: ['laser'] }),
    )
    assert.equal(errors.participants, 'Au moins 1.')
    assert.equal(errors.usage, 'Choix inconnu.')
    assert.equal(errors.equipements, 'Choix inconnu.')
  })

  it('demande le SIREN d’une société immatriculée, pas celui d’un projet', () => {
    const base = {
      [q('raisonSociale')]: 'Atelier Martin',
      [q('forme')]: 'sas',
      [q('debut')]: '2026-11-01',
      [q('courrier')]: 'numerisation',
      [q('engagement')]: '12',
    }
    assert.equal(parseAnswers('domiciliation', form({ ...base, [q('situation')]: 'creation' })).errors.siren, undefined)
    assert.equal(
      parseAnswers('domiciliation', form({ ...base, [q('situation')]: 'immatriculee' })).errors.siren,
      'Ce champ est obligatoire.',
    )
    // 732 829 320 : clé de Luhn juste.
    const parsed = parseAnswers('domiciliation', form({ ...base, [q('situation')]: 'transfert', [q('siren')]: '732 829 320' }))
    assert.deepEqual(parsed.errors, {})
    assert.equal(parsed.answers.siren, '732829320')
    assert.equal(
      parseAnswers('domiciliation', form({ ...base, [q('situation')]: 'transfert', [q('siren')]: '732829321' })).errors.siren,
      'Ce SIREN n’est pas valide : vérifiez les chiffres.',
    )
  })

  it('refuse une date qui n’existe pas', () => {
    const { errors } = parseAnswers('domiciliation', form({ [q('debut')]: '2026-02-30' }))
    assert.equal(errors.debut, 'Saisissez une date valide.')
  })

  it('exige le permis pour un camion, et accepte « non » comme réponse', () => {
    const answered = parseAnswers('vehicule', form({ [q('usage')]: 'demenagement', [q('trajet')]: 'Lyon – Grenoble', [q('permis')]: 'non' }))
    assert.deepEqual(answered.errors, {})
    assert.equal(answered.answers.permis, false)
    assert.equal(parseAnswers('vehicule', form({ [q('usage')]: 'livraison', [q('trajet')]: 'Lyon' })).errors.permis, 'Choisissez une réponse.')
  })
})

describe('describeAnswers', () => {
  it('rend les réponses en clair, dans l’ordre du questionnaire', () => {
    assert.deepEqual(
      describeAnswers('espace', { usage: 'reunion', participants: 12, equipements: ['visio'], accessibilite: true }),
      [
        { label: 'Nombre de participants', value: '12' },
        { label: 'Type de rendez-vous', value: 'Réunion' },
        { label: 'Équipements souhaités', value: 'Visioconférence' },
        { label: 'Un participant a-t-il besoin d’un accès adapté (PMR) ?', value: 'Oui' },
      ],
    )
  })

  it('garde lisible une réponse dont la question a disparu', () => {
    assert.deepEqual(describeAnswers('vehicule', { ancienne: 'x' }), [{ label: 'ancienne', value: 'x' }])
  })

  it('écrit une date en toutes lettres', () => {
    assert.deepEqual(describeAnswers('domiciliation', { debut: '2026-11-01' }), [{ label: 'À partir de quand ?', value: '1 novembre 2026' }])
  })
})

describe('date de début d’une domiciliation', () => {
  const base = {
    [q('situation')]: 'creation',
    [q('raisonSociale')]: 'Atelier Martin',
    [q('forme')]: 'sas',
    [q('courrier')]: 'sur-place',
    [q('engagement')]: '6',
  }

  it('refuse une date passée quand le jour du centre est donné (page publique)', () => {
    const { errors } = parseAnswers('domiciliation', form({ ...base, [q('debut')]: '2026-10-19' }), { today: '2026-10-20' })
    assert.equal(errors.debut, 'Choisissez une date à partir d’aujourd’hui.')
    assert.deepEqual(parseAnswers('domiciliation', form({ ...base, [q('debut')]: '2026-10-20' }), { today: '2026-10-20' }).errors, {})
  })

  it('accepte une date passée au back-office, qui ne donne pas le jour', () => {
    assert.deepEqual(parseAnswers('domiciliation', form({ ...base, [q('debut')]: '2026-01-01' })).errors, {})
  })
})
