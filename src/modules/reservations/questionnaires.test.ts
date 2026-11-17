import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { proposalProducts } from '../facturation/schema-devis.ts'
import { questionnaireProblem } from './questionnaires-edition.ts'
import {
  answerFieldName,
  answersForDisplay,
  defaultQuestionnaires,
  describeAnswers,
  errorsByField,
  formForResourceType,
  formulaires,
  isShown,
  isValidSiret,
  otherFieldName,
  parseAnswers,
  productForResourceType,
  productOfForm,
  questionnaireErrorLabels,
  requestProducts,
  type Question,
} from './questionnaires.ts'

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
const { salle, bureau, vehicule, materiel, domiciliation } = defaultQuestionnaires

describe('formulaires par service vendu (ADR 074)', () => {
  it('décrit chaque formulaire, avec des questions aux noms uniques et valides', () => {
    for (const key of formulaires) {
      const { questions } = defaultQuestionnaires[key]
      assert.ok(questions.length > 0, key)
      assert.equal(questionnaireProblem(questions), undefined, key)
    }
  })

  it('donne à la salle et au bureau chacun son formulaire, sous le même produit', () => {
    assert.equal(formForResourceType('salle'), 'salle')
    assert.equal(formForResourceType('bureau'), 'bureau')
    assert.equal(formForResourceType('vehicule'), 'vehicule')
    assert.equal(formForResourceType('materiel'), 'materiel')
    assert.equal(formForResourceType('casier'), undefined)
    assert.equal(productOfForm('salle'), 'espace')
    assert.equal(productOfForm('bureau'), 'espace')
    // Le bureau demande l'open space ou le bureau fermé ; la salle, la disposition.
    assert.ok(bureau.questions.some((question) => question.name === 'espace'))
    assert.ok(!bureau.questions.some((question) => question.name === 'disposition'))
    assert.ok(salle.questions.some((question) => question.name === 'disposition'))
    for (const product of proposalProducts) {
      for (const key of requestProducts[product].forms) assert.equal(productOfForm(key), product)
    }
  })

  it('range chaque ressource réservable sous son produit', () => {
    assert.equal(productForResourceType('salle'), 'espace')
    assert.equal(productForResourceType('bureau'), 'espace')
    assert.equal(productForResourceType('vehicule'), 'vehicule')
    assert.equal(productForResourceType('materiel'), 'materiel')
    assert.equal(productForResourceType('boite_aux_lettres'), undefined)
    assert.equal(productForResourceType('casier'), undefined)
  })

  it('ne valide d’office que les espaces chiffrés (à valider par le centre)', () => {
    assert.equal(requestProducts.espace.autoValidate, true)
    assert.equal(requestProducts.vehicule.autoValidate, false)
    assert.equal(requestProducts.domiciliation.autoValidate, false)
    // Le matériel loué seul passe par l'accueil, comme le camion (ADR 062).
    assert.equal(requestProducts.materiel.autoValidate, false)
    assert.deepEqual(requestProducts.materiel.resourceTypes, ['materiel'])
  })
})

describe('matériel loué seul (ADR 062)', () => {
  it('demande où il sert, et la livraison en clair', () => {
    const { answers, errors } = parseAnswers(materiel, form({ [q('lieu')]: 'exterieur', [q('installation')]: 'oui' }))
    assert.deepEqual(errors, {})
    assert.deepEqual(answers, { lieu: 'exterieur', installation: true })
    assert.deepEqual(describeAnswers(materiel, answers), [
      { name: 'lieu', label: 'Où le matériel sera-t-il utilisé ?', value: 'À l’extérieur du centre' },
      { name: 'installation', label: 'Souhaitez-vous la livraison ou l’installation ?', value: 'Oui' },
    ])
    assert.equal(parseAnswers(materiel, form({})).errors.lieu, 'Choisissez une réponse.')
  })
})

describe('parseAnswers', () => {
  it('lit les réponses d’une salle, choix multiples et oui/non compris', () => {
    const { answers, errors } = parseAnswers(
      salle,
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
    assert.deepEqual(Object.keys(parseAnswers(salle, form({})).errors).sort(), ['participants', 'usage'])
    assert.deepEqual(Object.keys(parseAnswers(bureau, form({})).errors).sort(), ['espace', 'participants'])
  })

  it('refuse un choix inventé et un nombre hors bornes', () => {
    const { errors } = parseAnswers(salle, form({ [q('participants')]: '0', [q('usage')]: 'concert', [q('equipements')]: ['laser'] }))
    assert.equal(errors.participants, 'Au moins 1.')
    assert.equal(errors.usage, 'Choix inconnu.')
    assert.equal(errors.equipements, 'Choix inconnu.')
  })

  it('refuse une date qui n’existe pas', () => {
    const { errors } = parseAnswers(domiciliation, form({ [q('debut')]: '2026-02-30' }))
    assert.equal(errors.debut, 'Saisissez une date valide.')
  })

  it('exige le permis pour un camion, et accepte « non » comme réponse', () => {
    const answered = parseAnswers(vehicule, form({ [q('usage')]: 'demenagement', [q('trajet')]: 'Lyon – Grenoble', [q('permis')]: 'non' }))
    assert.deepEqual(answered.errors, {})
    assert.equal(answered.answers.permis, false)
    assert.equal(parseAnswers(vehicule, form({ [q('usage')]: 'livraison', [q('trajet')]: 'Lyon' })).errors.permis, 'Choisissez une réponse.')
  })

  it('ne pose ni n’exige une question masquée par le centre', () => {
    const questions = salle.questions.map((question) => (question.name === 'usage' ? { ...question, hidden: true } : question))
    const { answers, errors } = parseAnswers({ questions }, form({ [q('participants')]: '4', [q('usage')]: 'reunion' }))
    assert.deepEqual(errors, {})
    assert.deepEqual(answers, { participants: 4 })
  })
})

describe('« Autre » ouvre un champ libre', () => {
  it('garde le texte libre avec la réponse, et l’exige si la question l’est', () => {
    const parsed = parseAnswers(salle, form({ [q('participants')]: '3', [q('usage')]: 'autre', [otherFieldName({ name: 'usage' })]: 'Tournage' }))
    assert.deepEqual(parsed.errors, {})
    assert.deepEqual(parsed.answers, { participants: 3, usage: 'autre', 'usage.autre': 'Tournage' })
    assert.equal(describeAnswers(salle, parsed.answers)[1].value, 'Autre : Tournage')

    const missing = parseAnswers(salle, form({ [q('participants')]: '3', [q('usage')]: 'autre' }))
    assert.equal(missing.errors['usage.autre'], 'Précisez votre réponse.')
    assert.deepEqual(errorsByField(missing.errors), { 'q.usage.autre': 'Précisez votre réponse.' })
    assert.equal(questionnaireErrorLabels(salle)['q.usage.autre'], 'Type de rendez-vous (précision)')
  })

  it('laisse le texte facultatif quand la question l’est, et l’ignore hors de « Autre »', () => {
    const optional = parseAnswers(bureau, form({ [q('participants')]: '1', [q('espace')]: 'ferme', [q('usage')]: 'autre' }))
    assert.deepEqual(optional.errors, {})
    assert.equal(optional.answers.usage, 'autre')
    const ignored = parseAnswers(salle, form({ [q('participants')]: '1', [q('usage')]: 'reunion', [otherFieldName({ name: 'usage' })]: 'restes' }))
    assert.equal(ignored.answers['usage.autre'], undefined)
  })

  it('refuse « Autre » à une question qui ne le propose pas', () => {
    assert.equal(parseAnswers(salle, form({ [q('participants')]: '1', [q('usage')]: 'reunion', [q('disposition')]: 'autre' })).errors.disposition, 'Choix inconnu.')
  })
})

describe('questions conditionnelles : affichées et obligatoires si…', () => {
  const base = { [q('forme')]: 'sas', [q('debut')]: '2026-12-01', [q('engagement')]: '12' }

  it('demande le projet d’une société en création, pas son SIRET', () => {
    const parsed = parseAnswers(domiciliation, form({ ...base, [q('situation')]: 'creation' }))
    assert.deepEqual(Object.keys(parsed.errors), ['nomProjet'])
    const done = parseAnswers(domiciliation, form({ ...base, [q('situation')]: 'creation', [q('nomProjet')]: 'Atelier Martin', [q('siret')]: '12' }))
    // Le SIRET d'une question masquée n'est ni gardé ni contrôlé.
    assert.deepEqual(done.errors, {})
    assert.deepEqual(done.answers, { situation: 'creation', nomProjet: 'Atelier Martin', forme: 'sas', debut: '2026-12-01', engagement: '12' })
  })

  it('demande la raison sociale et le SIRET d’une société immatriculée', () => {
    const parsed = parseAnswers(domiciliation, form({ ...base, [q('situation')]: 'immatriculee', [q('nomProjet')]: 'Ignoré' }))
    assert.deepEqual(Object.keys(parsed.errors).sort(), ['raisonSociale', 'siret'])
    assert.equal(parsed.answers.nomProjet, undefined)
    const done = parseAnswers(domiciliation, form({ ...base, [q('situation')]: 'immatriculee', [q('raisonSociale')]: 'Atelier Martin', [q('siret')]: '732 829 320 00074' }))
    assert.deepEqual(done.errors, {})
    assert.equal(done.answers.siret, '73282932000074')
  })

  it('ne propose plus que deux situations (le transfert est une société immatriculée)', () => {
    assert.equal(parseAnswers(domiciliation, form({ ...base, [q('situation')]: 'transfert' })).errors.situation, 'Choix inconnu.')
    assert.ok(!domiciliation.questions.some((question) => question.name === 'courrier' || question.name === 'options'))
  })

  it('lit une condition sur un oui/non ou un choix multiple', () => {
    const questions: Question[] = [
      { name: 'pmr', label: 'Accès adapté ?', kind: 'yesno' },
      { name: 'detail', label: 'Lequel ?', kind: 'text', required: true, showWhen: { question: 'pmr', values: ['oui'] } },
      { name: 'repas', label: 'Repas', kind: 'multi', choices: [{ value: 'dejeuner', label: 'Déjeuner' }, { value: 'cafe', label: 'Café' }] },
      { name: 'allergies', label: 'Allergies', kind: 'text', showWhen: { question: 'repas', values: ['dejeuner'] } },
    ]
    assert.equal(isShown(questions[1], { pmr: true }, questions), true)
    assert.equal(isShown(questions[1], { pmr: false }, questions), false)
    assert.equal(isShown(questions[3], { repas: ['cafe', 'dejeuner'] }, questions), true)
    assert.equal(isShown(questions[3], { repas: ['cafe'] }, questions), false)
    assert.deepEqual(parseAnswers({ questions }, form({ [q('pmr')]: 'oui' })).errors, { detail: 'Ce champ est obligatoire.' })
    // La question dont elle dépend masquée par le centre : jamais affichée.
    const hidden = questions.map((question) => (question.name === 'pmr' ? { ...question, hidden: true } : question))
    assert.equal(isShown(hidden[1], { pmr: true }, hidden), false)
  })
})

describe('SIRET', () => {
  it('compte quatorze chiffres et suit la clé de Luhn', () => {
    assert.equal(isValidSiret('73282932000074'), true)
    assert.equal(isValidSiret('73282932000075'), false)
    assert.equal(isValidSiret('732829320'), false)
    const base = { [q('situation')]: 'immatriculee', [q('raisonSociale')]: 'X', [q('forme')]: 'sas', [q('debut')]: '2026-12-01', [q('engagement')]: '3' }
    assert.equal(parseAnswers(domiciliation, form({ ...base, [q('siret')]: '732829320' })).errors.siret, 'Le SIRET compte quatorze chiffres.')
    assert.equal(parseAnswers(domiciliation, form({ ...base, [q('siret')]: '73282932000075' })).errors.siret, 'Ce SIRET n’est pas valide : vérifiez les chiffres.')
  })

  it('accepte les établissements de La Poste, dont la somme des chiffres est un multiple de 5', () => {
    // 356 000 000 : SIREN de La Poste ; ses établissements ne suivent pas Luhn.
    assert.equal(isValidSiret('35600000049837'), true)
    assert.equal(isValidSiret('35600000049838'), false)
    // Son siège suit Luhn.
    assert.equal(isValidSiret('35600000000048'), true)
  })
})

describe('describeAnswers', () => {
  it('rend les réponses en clair, dans l’ordre du questionnaire, avec leur nom', () => {
    assert.deepEqual(describeAnswers(salle, { usage: 'reunion', participants: 12, equipements: ['visio'], accessibilite: true }), [
      { name: 'participants', label: 'Nombre de participants', value: '12' },
      { name: 'usage', label: 'Type de rendez-vous', value: 'Réunion' },
      { name: 'equipements', label: 'Équipements souhaités', value: 'Visioconférence' },
      { name: 'accessibilite', label: 'Un participant a-t-il besoin d’un accès adapté (PMR) ?', value: 'Oui' },
    ])
  })

  it('garde lisible une réponse dont la question a disparu', () => {
    assert.deepEqual(describeAnswers(vehicule, { ancienne: 'x' }), [{ name: 'ancienne', label: 'ancienne', value: 'x' }])
  })

  it('écrit une date en toutes lettres et un SIRET par groupes', () => {
    assert.deepEqual(describeAnswers(domiciliation, { debut: '2026-11-01', siret: '73282932000074' }), [
      { name: 'siret', label: 'Numéro SIRET', value: '732 829 320 00074' },
      { name: 'debut', label: 'À partir de quand ?', value: '1 novembre 2026' },
    ])
  })
})

describe('réponses figées sur le devis (ADR 074)', () => {
  it('lit les réponses telles que le demandeur les a vues, même si la question a changé depuis', () => {
    const figees = [{ name: 'usage', label: 'Type de rendez-vous', value: 'Réunion' }]
    assert.deepEqual(answersForDisplay({ product: 'espace', answers: { usage: 'reunion' }, describedAnswers: figees }), figees)
  })

  it('lit un devis plus ancien avec les questions du code d’alors', () => {
    const ancien = answersForDisplay({
      product: 'domiciliation',
      answers: { situation: 'transfert', raisonSociale: 'Atelier Martin', siren: '732829320', courrier: 'numerisation', options: ['standard'], forme: 'sas' },
      describedAnswers: null,
    })
    assert.deepEqual(ancien.find((answer) => answer.name === 'situation')?.value, 'Transfère son siège chez nous')
    assert.deepEqual(ancien.find((answer) => answer.name === 'raisonSociale')?.label, 'Raison sociale ou nom du projet')
    assert.deepEqual(ancien.find((answer) => answer.name === 'courrier')?.value, 'Le numériser et me l’envoyer par courriel')
    assert.deepEqual(ancien.find((answer) => answer.name === 'options')?.value, 'Permanence téléphonique')
    assert.deepEqual(ancien.find((answer) => answer.name === 'forme')?.value, 'SAS ou SASU')
  })
})

describe('date de début d’une domiciliation', () => {
  const base = {
    [q('situation')]: 'creation',
    [q('nomProjet')]: 'Atelier Martin',
    [q('forme')]: 'sas',
    [q('engagement')]: '6',
  }

  it('refuse une date passée quand le jour du centre est donné (page publique)', () => {
    const { errors } = parseAnswers(domiciliation, form({ ...base, [q('debut')]: '2026-10-19' }), { today: '2026-10-20' })
    assert.equal(errors.debut, 'Choisissez une date à partir d’aujourd’hui.')
    assert.deepEqual(parseAnswers(domiciliation, form({ ...base, [q('debut')]: '2026-10-20' }), { today: '2026-10-20' }).errors, {})
  })

  it('accepte une date passée au back-office, qui ne donne pas le jour', () => {
    assert.deepEqual(parseAnswers(domiciliation, form({ ...base, [q('debut')]: '2026-01-01' })).errors, {})
  })
})
