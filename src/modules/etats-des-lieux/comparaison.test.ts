import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { compareInspections, differenceSummary, isDifference } from './comparaison.ts'
import type { InspectionField } from './schema.ts'

/**
 * Comparaison d'une sortie à son entrée (R06, ADR 039) : champ par champ, à
 * travers des versions de modèle différentes, chaque écart dit en toutes
 * lettres.
 */
const V1: InspectionField[] = [
  { id: 'kilometrage', label: 'Kilométrage', type: 'number', unit: 'km', required: true },
  { id: 'carburant', label: 'Carburant', type: 'choice', options: ['Vide', '1/2', 'Plein'], required: true },
  { id: 'carrosserie', label: 'Carrosserie', type: 'condition', required: true },
  { id: 'interieur', label: 'Intérieur', type: 'condition', required: true },
  { id: 'papiers', label: 'Papiers à bord', type: 'checkbox', required: false },
  { id: 'cendrier', label: 'Cendrier', type: 'checkbox', required: false },
  { id: 'dommages', label: 'Dommages', type: 'text', required: false },
]
// Version 2 : le cendrier disparaît, les pneus apparaissent, le carburant est renommé.
const V2: InspectionField[] = [
  ...V1.filter((field) => field.id !== 'cendrier').map((field) =>
    field.id === 'carburant' ? { ...field, label: 'Niveau de carburant' } : field,
  ),
  { id: 'pneus', label: 'Pneus', type: 'condition', required: false },
]

const entree = {
  fields: V1,
  values: {
    kilometrage: 12_000,
    carburant: 'Plein',
    carrosserie: 'bon',
    interieur: 'usage',
    papiers: true,
    cendrier: false,
    dommages: null,
  },
}
const sortie = {
  fields: V2,
  values: {
    kilometrage: 13_234.5,
    carburant: '1/2',
    carrosserie: 'mauvais',
    interieur: 'bon',
    papiers: true,
    dommages: 'Rayure aile droite',
    pneus: 'bon',
  },
}

describe('comparaison sortie / entrée', () => {
  const rows = compareInspections(entree, sortie)
  const row = (id: string) => rows.find((candidate) => candidate.fieldId === id)!

  it('suit l’ordre du modèle de la sortie, puis les champs que seule l’entrée connaissait', () => {
    assert.deepEqual(
      rows.map((candidate) => candidate.fieldId),
      ['kilometrage', 'carburant', 'carrosserie', 'interieur', 'papiers', 'dommages', 'pneus', 'cendrier'],
    )
    assert.equal(row('carburant').label, 'Niveau de carburant')
  })

  it('chiffre l’écart d’un nombre, avec son unité', () => {
    assert.equal(row('kilometrage').change, 'changed')
    assert.equal(row('kilometrage').note, 'Écart : +1 234,5 km')
    assert.equal(row('kilometrage').entry, '12 000 km')
  })

  it('dit dégradé ou amélioré pour une note d’état', () => {
    assert.equal(row('carrosserie').change, 'worse')
    assert.equal(row('carrosserie').note, 'Dégradé : Bon état → Mauvais état')
    assert.equal(row('interieur').change, 'better')
    assert.equal(row('interieur').note, 'Amélioré : État d’usage → Bon état')
  })

  it('dit « changé » pour un choix, « identique » quand rien ne bouge', () => {
    assert.equal(row('carburant').note, 'Changé : Plein → 1/2')
    assert.equal(row('papiers').change, 'same')
    assert.equal(row('papiers').note, 'Identique')
  })

  it('distingue ce qui n’est renseigné que d’un côté, et les champs propres à une version', () => {
    assert.equal(row('dommages').change, 'added')
    assert.equal(row('pneus').change, 'exit_only')
    assert.equal(row('cendrier').change, 'entry_only')
    assert.equal(row('cendrier').entry, 'Non')
    const manquant = compareInspections(entree, { fields: V1, values: { ...entree.values, papiers: null } })
    assert.equal(manquant.find((candidate) => candidate.fieldId === 'papiers')?.change, 'missing')
  })

  it('résume les écarts, dont les dégradations', () => {
    assert.equal(rows.filter(isDifference).length, 5)
    assert.equal(differenceSummary(rows), '5 écarts entre l’entrée et la sortie, dont 1 dégradation.')
    assert.equal(
      differenceSummary(compareInspections(entree, entree)),
      'Aucun écart entre l’entrée et la sortie.',
    )
  })

  it('ne laisse pas l’arithmétique flottante dans l’écart', () => {
    const fields: InspectionField[] = [{ id: 'charge', label: 'Charge', type: 'number', unit: 'kWh', required: false }]
    const [ecart] = compareInspections({ fields, values: { charge: 0.1 } }, { fields, values: { charge: 0.3 } })
    assert.equal(ecart.note, 'Écart : +0,2 kWh')
    const [baisse] = compareInspections({ fields, values: { charge: 5 } }, { fields, values: { charge: 2 } })
    assert.equal(baisse.note, 'Écart : −3 kWh')
  })
})
