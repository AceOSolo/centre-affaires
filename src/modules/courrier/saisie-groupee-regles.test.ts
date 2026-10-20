import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  countFieldName,
  expandMailCounts,
  MAX_PER_CELL,
  parseMailCounts,
} from './saisie-groupee-regles.ts'

const a = '0192f0a0-0000-7000-8000-00000000000a'
const b = '0192f0a0-0000-7000-8000-00000000000b'

describe('saisie groupée du courrier', () => {
  it('lit « 3 lettres pour a, 2 recommandés et 1 colis pour b »', () => {
    const { counts, fieldErrors, total } = parseMailCounts([
      [countFieldName(a, 'lettre'), '3'],
      [countFieldName(b, 'recommande'), '2'],
      [countFieldName(b, 'colis'), ' 1 '],
    ])
    assert.deepEqual(fieldErrors, {})
    assert.equal(total, 6)
    assert.deepEqual(counts, [
      { clientId: a, kind: 'lettre', count: 3 },
      { clientId: b, kind: 'recommande', count: 2 },
      { clientId: b, kind: 'colis', count: 1 },
    ])
  })

  it('une case vide ou à zéro ne crée aucun pli', () => {
    const { counts, total } = parseMailCounts([
      [countFieldName(a, 'lettre'), ''],
      [countFieldName(a, 'colis'), '0'],
    ])
    assert.deepEqual(counts, [])
    assert.equal(total, 0)
  })

  it('refuse une case illisible plutôt que d’en faire un zéro', () => {
    const name = countFieldName(a, 'lettre')
    for (const value of ['2,5', '-1', 'trois', String(MAX_PER_CELL + 1)]) {
      const { counts, fieldErrors } = parseMailCounts([[name, value]])
      assert.deepEqual(counts, [], value)
      assert.ok(fieldErrors[name], value)
    }
  })

  it('ignore les champs étrangers, les identifiants et les types inconnus', () => {
    const { counts, fieldErrors } = parseMailCounts([
      ['receivedAt', '2026-10-20T09:00'],
      ['n.pas-un-uuid.lettre', '3'],
      [`n.${a}.pigeon`, '3'],
    ])
    assert.deepEqual(counts, [])
    assert.deepEqual(fieldErrors, {})
  })

  it('déplie les nombres en autant de plis', () => {
    assert.deepEqual(
      expandMailCounts([
        { clientId: a, kind: 'lettre', count: 2 },
        { clientId: b, kind: 'colis', count: 1 },
      ]),
      [
        { clientId: a, kind: 'lettre' },
        { clientId: a, kind: 'lettre' },
        { clientId: b, kind: 'colis' },
      ],
    )
  })
})
