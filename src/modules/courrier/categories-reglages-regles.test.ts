import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  categoryLabel,
  categoryListDoneMessage,
  centreCategories,
  centreCategoriesSave,
  classifiableCategories,
  moveKey,
  personCategoriesSave,
  personCategoryList,
  readCategoryListForm,
  readMove,
  validateCategoryInputs,
  type OwnCategory,
} from './categories-reglages-regles.ts'
import { mailCategories } from './categories.ts'

const COMPTABLE = '01a00000-0000-7000-8000-0000000c0001'
const AVOCAT = '01a00000-0000-7000-8000-0000000c0002'
const own: OwnCategory[] = [
  { id: COMPTABLE, name: 'Comptable', hidden: false, position: null },
  { id: AVOCAT, name: 'Avocat', hidden: false, position: null },
]

/** Un `FormData` réduit à ce que lit l'écran. */
function form(entries: [string, string][]) {
  return {
    get: (name: string) => entries.find(([key]) => key === name)?.[1] ?? null,
    getAll: (name: string) => entries.filter(([key]) => key === name).map(([, value]) => value),
  }
}

describe('catégories proposées par le centre (ADR 078)', () => {
  it('sans réglage : les noms et l’ordre du code, rien de masqué', () => {
    const list = centreCategories([])
    assert.deepEqual(
      list.map((entry) => entry.category),
      [...mailCategories],
    )
    assert.equal(list[0].name, 'Impôts et taxes')
    assert.equal(list[0].codeName, 'Impôts et taxes')
    assert.ok(list.every((entry) => !entry.hidden))
  })

  it('renommée, masquée, déplacée par le centre', () => {
    const list = centreCategories([
      { category: 'publicite', name: 'Prospectus', hidden: true, position: 0 },
      { category: 'impots', name: null, hidden: false, position: 1 },
    ])
    assert.equal(list[0].category, 'publicite')
    assert.equal(list[0].name, 'Prospectus')
    assert.equal(list[0].codeName, 'Publicité')
    assert.equal(list[0].hidden, true)
    // Sans rang, une catégorie garde celui du code : « social » (1) départage par le code.
    assert.deepEqual(
      list.slice(1, 3).map((entry) => entry.category),
      ['impots', 'social'],
    )
  })

  it('enregistre seulement ce qui diffère du code', () => {
    const sameOrder = centreCategoriesSave(
      centreCategories([]).map((entry) => ({
        key: entry.category,
        name: entry.category === 'banque' ? 'Ma banque' : entry.name,
        hidden: entry.category === 'publicite',
      })),
    )
    assert.ok(sameOrder.every((setting) => setting.position === null), 'ordre du code : pas de rang')
    assert.equal(sameOrder.find((setting) => setting.category === 'banque')?.name, 'Ma banque')
    assert.equal(sameOrder.find((setting) => setting.category === 'impots')?.name, null)
    assert.equal(sameOrder.find((setting) => setting.category === 'publicite')?.hidden, true)

    const reordered = centreCategoriesSave(moveKey(mailCategories, 'autre', 'haut').map((key) => ({ key, name: 'x', hidden: false })))
    assert.deepEqual(
      reordered.map((setting) => setting.position),
      mailCategories.map((_, index) => index),
    )
  })
})

describe('liste d’une personne (ADR 078)', () => {
  const centre = centreCategories([{ category: 'publicite', name: 'Prospectus', hidden: true, position: null }])

  it('les proposées dans l’ordre du centre, puis les siennes par ordre alphabétique', () => {
    const list = personCategoryList(centre, [], own)
    assert.deepEqual(
      list.map((entry) => entry.key),
      [...mailCategories, AVOCAT, COMPTABLE],
    )
    const pub = list.find((entry) => entry.key === 'publicite')
    assert.equal(pub?.name, 'Prospectus')
    assert.equal(pub?.centreName, 'Prospectus')
    assert.equal(pub?.hidden, true, 'masquée par le centre')
    assert.equal(list.at(-1)?.kind, 'perso')
    assert.equal(list.at(-1)?.centreName, null)
  })

  it('ses noms, masquages et rangs l’emportent, pour elle seule', () => {
    const list = personCategoryList(
      centre,
      [
        { category: 'publicite', name: null, hidden: false, position: null },
        { category: 'impots', name: 'Fisc', hidden: true, position: null },
      ],
      own,
    )
    assert.equal(list.find((entry) => entry.key === 'publicite')?.hidden, false, 'réaffichée par la personne')
    const impots = list.find((entry) => entry.key === 'impots')
    assert.equal(impots?.name, 'Fisc')
    assert.equal(impots?.centreName, 'Impôts et taxes')
    assert.equal(impots?.hidden, true)
  })

  it('une catégorie créée après un rangement arrive en fin de liste', () => {
    const keys = [COMPTABLE, ...mailCategories]
    const ranked = personCategoryList(
      centre,
      mailCategories.map((category) => ({ category, name: null, hidden: null, position: keys.indexOf(category) })),
      [
        { id: COMPTABLE, name: 'Comptable', hidden: false, position: 0 },
        { id: AVOCAT, name: 'Avocat', hidden: false, position: null },
      ],
    )
    assert.equal(ranked[0].key, COMPTABLE)
    assert.equal(ranked.at(-1)?.key, AVOCAT)
  })

  it('n’enregistre que ce qui diffère du centre ; l’ordre de départ ne pose aucun rang', () => {
    const start = personCategoryList(centre, [], own)
    const unchanged = personCategoriesSave(
      centre,
      own,
      start.map((entry) => ({ key: entry.key, name: entry.name, hidden: entry.hidden })),
    )
    assert.ok(unchanged.prefs.every((pref) => pref.name === null && pref.hidden === null && pref.position === null))
    assert.ok(unchanged.own.every((category) => category.position === null))

    const moved = moveKey(
      start.map((entry) => entry.key),
      COMPTABLE,
      'haut',
    )
    const saved = personCategoriesSave(
      centre,
      own,
      moved.map((key) => {
        const entry = start.find((candidate) => candidate.key === key)!
        return { key, name: key === 'impots' ? ' Fisc ' : entry.name, hidden: key === 'banque' ? true : entry.hidden }
      }),
    )
    assert.equal(saved.prefs.find((pref) => pref.category === 'impots')?.name, 'Fisc')
    assert.equal(saved.prefs.find((pref) => pref.category === 'banque')?.hidden, true)
    assert.equal(saved.prefs.find((pref) => pref.category === 'social')?.hidden, null)
    // L'ordre a changé : chaque catégorie reçoit son rang.
    assert.equal(saved.own.find((category) => category.id === COMPTABLE)?.position, 10)
    assert.equal(saved.own.find((category) => category.id === AVOCAT)?.position, 11)
    assert.equal(saved.prefs.find((pref) => pref.category === 'impots')?.position, 0)
  })

  it('propose au classement les catégories visibles, et celle du pli même masquée', () => {
    const list = personCategoryList(centre, [], own)
    assert.ok(!classifiableCategories(list).some((entry) => entry.key === 'publicite'))
    assert.ok(classifiableCategories(list, 'publicite').some((entry) => entry.key === 'publicite'))
  })

  it('nomme la rubrique d’un pli comme la personne l’a nommée', () => {
    const list = personCategoryList(centre, [{ category: 'impots', name: 'Fisc', hidden: null, position: null }], own)
    assert.equal(categoryLabel({ category: 'impots', customCategoryId: null }, list), 'Fisc')
    assert.equal(categoryLabel({ category: null, customCategoryId: COMPTABLE }, list), 'Comptable')
    assert.equal(categoryLabel({ category: null, customCategoryId: null }, list), null)
    // Hors liste (catégorie d'une autre entreprise du compte) : le nom du code.
    assert.equal(categoryLabel({ category: 'banque', customCategoryId: null }, []), 'Banque et finances')
  })
})

describe('noms saisis (ADR 078)', () => {
  it('refuse le vide, le trop long, « Non classé » et les doublons à la casse près', () => {
    const checked = validateCategoryInputs([
      { key: 'impots', name: '  ', hidden: false },
      { key: 'banque', name: 'x'.repeat(41), hidden: false },
      { key: 'social', name: 'non classé', hidden: false },
      { key: 'clients', name: 'Clients', hidden: false },
      { key: COMPTABLE, name: ' CLIENTS ', hidden: false },
    ])
    assert.ok(checked.fieldErrors)
    assert.match(checked.fieldErrors['nom-impots'], /Saisissez/)
    assert.match(checked.fieldErrors['nom-banque'], /40 caractères/)
    assert.match(checked.fieldErrors['nom-social'], /Non classé/)
    assert.match(checked.fieldErrors['nom-clients'], /Deux catégories/)
    assert.match(checked.fieldErrors[`nom-${COMPTABLE}`], /Deux catégories/)
  })

  it('rend les noms resserrés', () => {
    assert.deepEqual(validateCategoryInputs([{ key: 'impots', name: '  Fisc   et  taxes ', hidden: true }]), {
      entries: [{ key: 'impots', name: 'Fisc et taxes', hidden: true }],
    })
  })
})

describe('formulaire de la liste', () => {
  it('lit l’ordre, les noms, les cases, et applique un déplacement', () => {
    const read = readCategoryListForm(
      form([
        ['ordre', 'impots'],
        ['ordre', 'banque'],
        ['ordre', COMPTABLE],
        ['nom-impots', 'Fisc'],
        ['nom-banque', 'Banque'],
        ['masquee-banque', 'on'],
        ['nom-' + COMPTABLE, 'Comptable'],
        ['deplacer', `${COMPTABLE}:haut`],
      ]),
    )
    assert.deepEqual(read.gesture, { type: 'deplacer', key: COMPTABLE, direction: 'haut' })
    assert.deepEqual(
      read.inputs.map((input) => input.key),
      ['impots', COMPTABLE, 'banque'],
    )
    assert.equal(read.inputs.find((input) => input.key === 'banque')?.hidden, true)
    assert.equal(categoryListDoneMessage(read.gesture, read.inputs), '« Comptable » déplacée en position 2 sur 3.')
  })

  it('rétablit le nom d’origine ; sans bouton pressé, enregistre', () => {
    const restored = readCategoryListForm(
      form([
        ['ordre', 'impots'],
        ['nom-impots', 'Fisc'],
        ['origine-impots', 'Impôts et taxes'],
        ['retablir', 'impots'],
      ]),
    )
    assert.deepEqual(restored.gesture, { type: 'retablir', key: 'impots' })
    assert.equal(restored.inputs[0].name, 'Impôts et taxes')
    assert.equal(
      readCategoryListForm(form([['ordre', 'impots'], ['nom-impots', 'Fisc']])).gesture.type,
      'enregistrer',
    )
  })

  it('déplace d’un cran, sans sortir de la liste', () => {
    assert.deepEqual(moveKey(['a', 'b', 'c'], 'c', 'haut'), ['a', 'c', 'b'])
    assert.deepEqual(moveKey(['a', 'b', 'c'], 'a', 'haut'), ['a', 'b', 'c'])
    assert.deepEqual(moveKey(['a', 'b', 'c'], 'c', 'bas'), ['a', 'b', 'c'])
    assert.deepEqual(readMove('impots:bas'), { key: 'impots', direction: 'bas' })
    assert.equal(readMove('impots:gauche'), undefined)
  })
})
