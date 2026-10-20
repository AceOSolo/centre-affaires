import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  batchMessages,
  expectedBatch,
  mailCountPhrase,
  NO_BATCH,
  mailKindsPhrase,
  scannedPhrase,
  type BatchItem,
} from './tournees-regles.ts'

const pli = (clientId: string, kind: BatchItem['kind'] = 'lettre', opened = false): BatchItem => ({
  clientId,
  kind,
  opened,
})

describe('fin de tournée : qui reçoit quel message (ADR 044)', () => {
  it('regroupe les plis par entreprise : un seul message chacune', () => {
    const { received } = batchMessages(
      [pli('a'), pli('b', 'colis'), pli('a', 'recommande', true), pli('a')],
      [],
      true,
    )
    assert.deepEqual(
      received.map((entry) => [entry.clientId, entry.count, entry.scanned]),
      [
        ['a', 3, 1],
        ['b', 1, 0],
      ],
    )
    assert.deepEqual(received[0].byKind, { lettre: 2, recommande: 1, colis: 0, autre: 0 })
  })

  it('prévient les domiciliés sans pli à la première tournée de la journée', () => {
    const { received, none } = batchMessages([pli('a')], ['a', 'c', 'b', 'c'], true)
    assert.deepEqual(received.map((entry) => entry.clientId), ['a'])
    assert.deepEqual(none, ['b', 'c'])
  })

  it('ne redit pas « pas de courrier » à une tournée suivante du même jour', () => {
    const { received, none } = batchMessages([pli('a')], ['a', 'b'], false)
    assert.deepEqual(received.map((entry) => entry.clientId), ['a'])
    assert.deepEqual(none, [])
  })

  it('tournée terminée vide : tous les domiciliés apprennent qu’il n’y a rien', () => {
    assert.deepEqual(batchMessages([], ['a', 'b'], true), { received: [], none: ['a', 'b'] })
  })

  it('prévient une entreprise qui a du courrier même sans contrat de domiciliation', () => {
    // Un locataire de bureau qui reçoit du courrier au centre.
    const { received, none } = batchMessages([pli('bureau')], ['a'], true)
    assert.deepEqual(received.map((entry) => entry.clientId), ['bureau'])
    assert.deepEqual(none, ['a'])
  })
})

describe('fin de tournée : la tournée que l’écran montrait', () => {
  it('lit l’identifiant de la tournée affichée', () => {
    const id = '01a00000-0000-7000-8000-0000000f4a01'
    assert.equal(expectedBatch(id), id)
  })

  it('« aucune tournée » se dit explicitement', () => {
    assert.equal(expectedBatch(NO_BATCH), null)
  })

  it('une valeur vide ou illisible ne termine rien', () => {
    // Vide, elle valait « aucune tournée » : la tournée d'un collègue était
    // terminée à sa place.
    assert.equal(expectedBatch(''), undefined)
    assert.equal(expectedBatch('n’importe quoi'), undefined)
  })
})

describe('textes du message de fin de tournée', () => {
  it('compte les courriers', () => {
    assert.equal(mailCountPhrase(1), '1 courrier')
    assert.equal(mailCountPhrase(4), '4 courriers')
  })

  it('énumère les natures, au pluriel quand il le faut', () => {
    assert.equal(mailKindsPhrase({ lettre: 1, recommande: 0, colis: 0, autre: 0 }), '1 lettre')
    assert.equal(mailKindsPhrase({ lettre: 2, recommande: 1, colis: 0, autre: 0 }), '2 lettres et 1 recommandé')
    assert.equal(
      mailKindsPhrase({ lettre: 1, recommande: 0, colis: 2, autre: 3 }),
      '1 lettre, 2 colis et 3 autres plis',
    )
  })

  it('signale les plis déjà numérisés, et rien sinon', () => {
    assert.equal(scannedPhrase(0), '')
    assert.match(scannedPhrase(1), /^dont 1 déjà ouvert et numérisé/)
    assert.match(scannedPhrase(2), /^dont 2 déjà ouverts et numérisés/)
  })
})
