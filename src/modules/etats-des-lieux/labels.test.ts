import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { resourceTypes } from '../ressources/schema.ts'
import { inspectionFieldsIssues } from './champs.ts'
import { conditionLevelOrder, fieldTypeOrder, inspectionStage } from './labels.ts'
import { defaultTemplates } from './modeles-defaut.ts'
import { inspectionConditionLevels, inspectionFieldTypes } from './schema.ts'

describe('libellés des états des lieux', () => {
  it('suivent l’échelle de la note d’état et les types de champ du schéma, dans leur ordre', () => {
    assert.deepEqual(conditionLevelOrder, [...inspectionConditionLevels])
    assert.deepEqual(fieldTypeOrder, [...inspectionFieldTypes])
  })

  it('disent l’étape : en saisie, à valider, validé, retiré', () => {
    assert.equal(inspectionStage({ status: 'draft', signedAt: null, deletedAt: null }), 'draft')
    assert.equal(inspectionStage({ status: 'closed', signedAt: null, deletedAt: null }), 'to_sign')
    assert.equal(inspectionStage({ status: 'closed', signedAt: new Date(), deletedAt: null }), 'signed')
    assert.equal(inspectionStage({ status: 'draft', signedAt: null, deletedAt: new Date() }), 'withdrawn')
  })
})

describe('modèles de départ', () => {
  it('couvrent chaque type de ressource, et sont valides', () => {
    assert.deepEqual(Object.keys(defaultTemplates).sort(), [...resourceTypes].sort())
    for (const type of resourceTypes) {
      assert.deepEqual(inspectionFieldsIssues(defaultTemplates[type].fields), [], type)
      assert.ok(defaultTemplates[type].name.trim(), type)
    }
  })

  it('relèvent ce que le cahier des charges demande', () => {
    const ids = (type: keyof typeof defaultTemplates) => defaultTemplates[type].fields.map((field) => field.id)
    // Véhicule : kilométrage, carburant, propreté, dommages (slides 5, 18).
    for (const id of ['kilometrage', 'carburant', 'proprete_interieure', 'dommages']) {
      assert.ok(ids('vehicule').includes(id), id)
    }
    const kilometrage = defaultTemplates.vehicule.fields.find((field) => field.id === 'kilometrage')
    assert.equal(kilometrage?.type, 'number')
    assert.equal(kilometrage?.unit, 'km')
    // Bureau, salle, casier, boîte aux lettres : état général, clés remises.
    for (const type of ['bureau', 'salle', 'casier', 'boite_aux_lettres'] as const) {
      assert.ok(ids(type).includes('etat_general'), type)
      assert.ok(ids(type).includes('cles'), type)
    }
    assert.ok(ids('bureau').includes('equipements'))
    assert.ok(ids('salle').includes('equipements'))
  })
})
