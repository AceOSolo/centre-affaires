import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  canCreateCategory,
  categoryName,
  cleanCategoryName,
  isCustomCategoryId,
  MAX_CUSTOM_CATEGORIES,
  MAX_CUSTOM_CATEGORY_LENGTH,
  sameCategoryName,
  validateCategoryName,
} from './categories-perso-regles.ts'
import {
  applyClassification,
  emptyClassification,
  readCategoryFilter,
  readClassificationChange,
} from './classement-regles.ts'

const ID = '01a00000-0000-7000-8000-0000000c0001'
const AUTRE = '01a00000-0000-7000-8000-0000000c0002'
const now = new Date('2026-11-04T08:00:00Z')

/** Catégories personnelles du courrier (ADR 060) : nom, limites, place dans le classement. */
describe('catégories personnelles : le nom', () => {
  it('resserre les espaces et compare à la casse près, pas aux accents', () => {
    assert.equal(cleanCategoryName('  Contrats   en  cours '), 'Contrats en cours')
    assert.equal(sameCategoryName('comptable', ' COMPTABLE '), true)
    assert.equal(sameCategoryName('Comptable', 'Comptablé'), false)
  })

  it('refuse un nom vide ou trop long', () => {
    assert.match(validateCategoryName('   ', []).error ?? '', /Saisissez/)
    assert.equal(validateCategoryName('x'.repeat(MAX_CUSTOM_CATEGORY_LENGTH), []).name?.length, MAX_CUSTOM_CATEGORY_LENGTH)
    assert.match(
      validateCategoryName('x'.repeat(MAX_CUSTOM_CATEGORY_LENGTH + 1), []).error ?? '',
      new RegExp(`${MAX_CUSTOM_CATEGORY_LENGTH} caractères`),
    )
  })

  it('refuse le nom d’une catégorie proposée, et « Non classé »', () => {
    assert.match(validateCategoryName('banque et finances', []).error ?? '', /« Banque et finances » fait déjà partie/)
    assert.match(validateCategoryName('NON CLASSÉ', []).error ?? '', /fait déjà partie/)
  })

  it('refuse un doublon de la personne, à la casse près', () => {
    const existing = [{ id: ID, name: 'Comptable' }]
    assert.match(validateCategoryName('comptable', existing).error ?? '', /déjà une catégorie « Comptable »/)
    assert.deepEqual(validateCategoryName('Contrats', existing), { name: 'Contrats' })
  })

  it('laisse une catégorie que l’on renomme garder son nom, ou en changer la casse', () => {
    const existing = [
      { id: ID, name: 'comptable' },
      { id: AUTRE, name: 'Contrats' },
    ]
    assert.deepEqual(validateCategoryName('Comptable', existing, ID), { name: 'Comptable' })
    assert.match(validateCategoryName('contrats', existing, ID).error ?? '', /déjà une catégorie « Contrats »/)
  })

  it('arrête la création à vingt catégories', () => {
    assert.equal(MAX_CUSTOM_CATEGORIES, 20)
    assert.equal(canCreateCategory(MAX_CUSTOM_CATEGORIES - 1), true)
    assert.equal(canCreateCategory(MAX_CUSTOM_CATEGORIES), false)
  })
})

describe('catégories personnelles : dans le classement', () => {
  it('se reconnaissent à leur identifiant, une catégorie proposée à sa clé', () => {
    assert.equal(isCustomCategoryId(ID), true)
    assert.equal(isCustomCategoryId('impots'), false)
    assert.equal(isCustomCategoryId('non-classe'), false)
  })

  it('remplacent la catégorie proposée, et inversement : jamais les deux', () => {
    const proposee = applyClassification(emptyClassification, { type: 'category', category: 'impots' }, now)
    const perso = applyClassification(proposee, { type: 'customCategory', id: ID }, now)
    assert.equal(perso.category, null)
    assert.equal(perso.customCategoryId, ID)
    const retour = applyClassification(perso, { type: 'category', category: 'banque' }, now)
    assert.equal(retour.category, 'banque')
    assert.equal(retour.customCategoryId, null)
    const declasse = applyClassification(perso, { type: 'category', category: null }, now)
    assert.deepEqual([declasse.category, declasse.customCategoryId], [null, null])
  })

  it('se choisissent dans la barre de sélection et dans les rubriques', () => {
    assert.deepEqual(readClassificationChange('classer', ID), { change: { type: 'customCategory', id: ID } })
    assert.deepEqual(readClassificationChange('classer', 'impots'), {
      change: { type: 'category', category: 'impots' },
    })
    assert.ok(readClassificationChange('classer', 'inconnue').error)
    assert.equal(readCategoryFilter(ID.toUpperCase()), ID)
    assert.equal(readCategoryFilter('non-classe'), 'non-classe')
    assert.equal(readCategoryFilter('pas-une-categorie'), undefined)
  })

  it('donnent leur nom à la rubrique d’un pli', () => {
    const custom = [{ id: ID, name: 'Comptable' }]
    assert.equal(categoryName({ category: 'impots', customCategoryId: null }, custom), 'Impôts et taxes')
    assert.equal(categoryName({ category: null, customCategoryId: ID }, custom), 'Comptable')
    assert.equal(categoryName({ category: null, customCategoryId: AUTRE }, custom), null)
    assert.equal(categoryName({ category: null, customCategoryId: null }, custom), null)
  })
})
