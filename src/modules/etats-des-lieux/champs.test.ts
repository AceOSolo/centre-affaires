import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  fieldIdFromLabel,
  formatInspectionValue,
  inspectionFieldsError,
  inspectionFieldsIssues,
  inspectionValuesError,
  inspectionValuesIssues,
  normalizeEditorFields,
  parseFrenchNumber,
  readInspectionValues,
  sameFields,
  toEditorFields,
  valueToInput,
  type EditorField,
} from './champs.ts'
import type { InspectionField } from './schema.ts'

/**
 * Règles des modèles et des valeurs d'état des lieux (R06, ADR 039), côté
 * code. L'accord avec la base est éprouvé par `etats-des-lieux-ecrans.db.test.ts`.
 */
const CHAMPS: InspectionField[] = [
  { id: 'kilometrage', label: 'Kilométrage', type: 'number', unit: 'km', required: true },
  {
    id: 'carburant',
    label: 'Niveau de carburant',
    type: 'choice',
    options: ['Vide', '1/4', '1/2', '3/4', 'Plein'],
    required: true,
  },
  { id: 'carrosserie', label: 'Carrosserie', type: 'condition', required: true },
  { id: 'papiers', label: 'Papiers à bord', type: 'checkbox', required: false },
  { id: 'dommages', label: 'Dommages', type: 'text', required: false },
]

describe('modèle de champs', () => {
  it('accepte un modèle conforme', () => {
    assert.deepEqual(inspectionFieldsIssues(CHAMPS), [])
    assert.equal(inspectionFieldsError(CHAMPS), null)
  })

  it('refuse la liste vide, une non-liste, plus de 100 champs', () => {
    assert.equal(inspectionFieldsError([]), 'Le modèle doit compter au moins un champ.')
    assert.equal(inspectionFieldsError({}), 'Le modèle doit être une liste de champs.')
    const trop = Array.from({ length: 101 }, (_, index) => ({
      id: `c${index}`,
      label: `Champ ${index}`,
      type: 'text',
      required: false,
    }))
    assert.equal(inspectionFieldsError(trop), 'Un modèle compte au plus 100 champs.')
  })

  it('dit pourquoi chaque champ est refusé, à son rang', () => {
    const cas: [unknown, RegExp][] = [
      [{ id: 'Murs', label: 'Murs', type: 'text', required: true }, /identifiant invalide/],
      [{ id: 'murs', label: '  ', type: 'text', required: true }, /libellé manquant/],
      [{ id: 'murs', label: 'x'.repeat(201), type: 'text', required: true }, /libellé manquant/],
      [{ id: 'murs', label: 'Murs', type: 'photo', required: true }, /type inconnu/],
      [{ id: 'murs', label: 'Murs', type: 'text' }, /dire s'il est obligatoire/],
      [{ id: 'murs', label: 'Murs', type: 'text', required: true, unit: 'm²' }, /seul un nombre a une unité/],
      [{ id: 'cles', label: 'Clés', type: 'number', required: true, unit: ' ' }, /unité vide/],
      [{ id: 'etat', label: 'État', type: 'choice', required: true }, /liste ses options/],
      [{ id: 'etat', label: 'État', type: 'choice', required: true, options: ['Seule'] }, /2 à 50 options/],
      [{ id: 'etat', label: 'État', type: 'choice', required: true, options: ['A', 'A'] }, /option « A » en double/],
      [{ id: 'etat', label: 'État', type: 'choice', required: true, options: ['A', ''] }, /option vide/],
      [{ id: 'murs', label: 'Murs', type: 'text', required: true, options: ['A', 'B'] }, /seul un choix a des options/],
      [{ id: 'murs', label: 'Murs', type: 'text', required: true, help: '' }, /aide vide/],
      [{ id: 'murs', label: 'Murs', type: 'text', required: true, couleur: 'bleu' }, /propriété inconnue « couleur »/],
      ['murs', /un objet est attendu/],
    ]
    for (const [champ, attendu] of cas) {
      const issues = inspectionFieldsIssues([CHAMPS[0], champ])
      assert.equal(issues.length, 1, JSON.stringify(champ))
      assert.equal(issues[0].index, 1)
      assert.match(issues[0].message, attendu, JSON.stringify(champ))
    }
  })

  it('refuse un identifiant en double, et relève toutes les erreurs d’un coup', () => {
    const issues = inspectionFieldsIssues([
      CHAMPS[0],
      { ...CHAMPS[1], id: 'kilometrage' },
      { ...CHAMPS[2], label: '' },
    ])
    assert.deepEqual(
      issues.map((issue) => issue.index),
      [1, 2],
    )
    assert.match(issues[0].message, /« kilometrage » : identifiant en double/)
  })

  it('compte les caractères comme Postgres, pas en UTF-16', () => {
    // 200 émojis : 400 unités UTF-16, mais 200 caractères.
    const label = '🚗'.repeat(200)
    assert.equal(inspectionFieldsError([{ id: 'auto', label, type: 'text', required: false }]), null)
  })
})

describe('valeurs', () => {
  it('accepte des valeurs conformes, et un brouillon incomplet', () => {
    assert.equal(inspectionValuesError(CHAMPS, { kilometrage: 12_500, carburant: '1/2' }, false), null)
    assert.equal(inspectionValuesError(CHAMPS, { dommages: null }, false), null)
  })

  it('vérifie chaque valeur selon son type', () => {
    const cas: [Record<string, unknown>, RegExp][] = [
      [{ inconnu: 1 }, /ne connaît pas : « inconnu »/],
      [{ kilometrage: '12 500' }, /un nombre est attendu/],
      [{ carburant: 'Moitié' }, /l'une des options/],
      [{ carrosserie: 'excellent' }, /note d'état est attendue/],
      [{ papiers: 'oui' }, /coché ou non coché/],
      [{ dommages: 'x'.repeat(5001) }, /5 000 caractères/],
      [{ dommages: 42 }, /5 000 caractères/],
    ]
    for (const [values, attendu] of cas) {
      assert.match(inspectionValuesError(CHAMPS, values, false) ?? '', attendu, JSON.stringify(values))
    }
    assert.match(inspectionValuesError(CHAMPS, [], false) ?? '', /forment un objet/)
  })

  it('exige à la clôture chaque champ obligatoire, et lui seul', () => {
    const issues = inspectionValuesIssues(CHAMPS, { kilometrage: 0, carburant: null, dommages: '' }, true)
    assert.deepEqual(
      issues.map((issue) => issue.fieldId),
      ['carburant', 'carrosserie'],
    )
    assert.match(issues[0].message, /« Niveau de carburant » est obligatoire/)
    // Zéro kilomètre et « non » sont des valeurs renseignées.
    assert.equal(
      inspectionValuesError(
        [...CHAMPS.slice(0, 3), { ...CHAMPS[3], required: true }],
        { kilometrage: 0, carburant: 'Vide', carrosserie: 'bon', papiers: false },
        true,
      ),
      null,
    )
  })
})

describe('lecture du formulaire', () => {
  const lire = (entries: Record<string, string>) =>
    readInspectionValues(CHAMPS, (name) => entries[name])

  it('lit les nombres à la française', () => {
    assert.equal(parseFrenchNumber('12 345,5'), 12345.5)
    assert.equal(parseFrenchNumber('12 345'), 12345)
    assert.equal(parseFrenchNumber('12345.5'), 12345.5)
    assert.equal(parseFrenchNumber('-3'), -3)
    assert.equal(parseFrenchNumber('douze'), undefined)
    assert.equal(parseFrenchNumber('1,2,3'), undefined)
  })

  it('rend les valeurs typées, et « non renseigné » pour un champ vide', () => {
    const { values, errors } = lire({
      v_kilometrage: ' 12 500 ',
      v_carburant: '3/4',
      v_carrosserie: 'usage',
      v_papiers: 'non',
      v_dommages: '  Rayure porte avant  ',
    })
    assert.deepEqual(errors, {})
    assert.deepEqual(values, {
      kilometrage: 12500,
      carburant: '3/4',
      carrosserie: 'usage',
      papiers: false,
      dommages: 'Rayure porte avant',
    })
    assert.deepEqual(lire({}).values, {
      kilometrage: null,
      carburant: null,
      carrosserie: null,
      papiers: null,
      dommages: null,
    })
  })

  it('signale la saisie illisible, champ par champ', () => {
    const { errors } = lire({
      v_kilometrage: 'beaucoup',
      v_carburant: 'Moitié',
      v_carrosserie: 'excellent',
      v_papiers: 'peut-être',
    })
    assert.deepEqual(Object.keys(errors).sort(), ['carburant', 'carrosserie', 'kilometrage', 'papiers'])
  })

  it('remet une valeur enregistrée dans son contrôle, et la met en forme pour la lecture', () => {
    assert.equal(valueToInput(CHAMPS[0], 12500.5), '12 500,5')
    assert.equal(valueToInput(CHAMPS[3], true), 'oui')
    assert.equal(valueToInput(CHAMPS[3], false), 'non')
    assert.equal(valueToInput(CHAMPS[1], null), '')
    assert.equal(formatInspectionValue(CHAMPS[0], 12500), '12 500 km')
    assert.equal(formatInspectionValue(CHAMPS[2], 'usage'), 'État d’usage')
    assert.equal(formatInspectionValue(CHAMPS[3], false), 'Non')
    assert.equal(formatInspectionValue(CHAMPS[4], null), null)
  })
})

describe('éditeur de modèle', () => {
  it('tire un identifiant stable et unique du libellé', () => {
    const pris = new Set(['niveau_de_carburant'])
    assert.equal(fieldIdFromLabel('Kilométrage', pris), 'kilometrage')
    assert.equal(fieldIdFromLabel('Niveau de carburant', pris), 'niveau_de_carburant_2')
    assert.equal(fieldIdFromLabel('2e clé', pris), 'champ_2e_cle')
    assert.equal(fieldIdFromLabel('', pris), 'champ')
    const long = fieldIdFromLabel('Un libellé vraiment très long '.repeat(5), pris)
    assert.ok(/^[a-z][a-z0-9_]{0,62}$/.test(long), long)
  })

  it('normalise la saisie : identifiants ajoutés, propriétés selon le type', () => {
    const rows: EditorField[] = [
      { id: 'kilometrage', label: ' Kilométrage ', type: 'number', required: true, unit: ' km ', options: 'A\nB', help: '' },
      { id: '', label: 'Pneus', type: 'choice', required: false, unit: 'mm', options: 'Bons\n\n Usés \n', help: ' Les quatre ' },
      { id: '', label: 'Pneus', type: 'text', required: false, unit: '', options: '', help: '' },
    ]
    assert.deepEqual(normalizeEditorFields(rows), [
      { id: 'kilometrage', label: 'Kilométrage', type: 'number', required: true, unit: 'km' },
      { id: 'pneus', label: 'Pneus', type: 'choice', required: false, options: ['Bons', 'Usés'], help: 'Les quatre' },
      { id: 'pneus_2', label: 'Pneus', type: 'text', required: false },
    ])
    assert.deepEqual(normalizeEditorFields(toEditorFields(CHAMPS)), CHAMPS)
  })

  it('reconnaît une publication sans changement', () => {
    assert.equal(sameFields(CHAMPS, normalizeEditorFields(toEditorFields(CHAMPS))), true)
    assert.equal(sameFields(CHAMPS, [...CHAMPS].reverse()), false)
    assert.equal(sameFields(CHAMPS, [{ ...CHAMPS[0], required: false }, ...CHAMPS.slice(1)]), false)
  })
})
