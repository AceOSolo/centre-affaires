import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  checkPhotoCounts,
  countFieldName,
  envelopeSlots,
  MAX_PER_CELL,
  pairEnvelopes,
  parseMailCounts,
  photoFieldClientId,
  photoFieldName,
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
      pairEnvelopes([
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

describe('photos des enveloppes de la saisie groupée (ADR 055)', () => {
  // L'ordre des cases dans le formulaire ne compte pas : celui des colonnes, si.
  const counts = [
    { clientId: a, kind: 'colis' as const, count: 1 },
    { clientId: a, kind: 'lettre' as const, count: 2 },
    { clientId: b, kind: 'recommande' as const, count: 1 },
  ]

  it('lit l’entreprise d’un champ de photos, et rien d’un autre champ', () => {
    assert.equal(photoFieldClientId(photoFieldName(a)), a)
    assert.equal(photoFieldClientId(countFieldName(a, 'lettre')), undefined)
    assert.equal(photoFieldClientId('p.pas-un-uuid'), undefined)
    assert.equal(photoFieldClientId('receivedAt'), undefined)
  })

  it('range les plis d’une entreprise dans l’ordre des colonnes : lettres, recommandés, colis, autres', () => {
    assert.deepEqual(envelopeSlots(counts, a), ['lettre', 'lettre', 'colis'])
    assert.deepEqual(envelopeSlots(counts, b), ['recommande'])
    assert.deepEqual(envelopeSlots(counts, '0192f0a0-0000-7000-8000-00000000000c'), [])
  })

  it('donne à chaque pli la photo jointe à son rang, et laisse les autres sans photo', () => {
    assert.deepEqual(pairEnvelopes(counts, new Map([[a, ['photo-1', 'photo-2']]])), [
      { clientId: a, kind: 'lettre', envelope: 'photo-1' },
      { clientId: a, kind: 'lettre', envelope: 'photo-2' },
      { clientId: a, kind: 'colis' },
      { clientId: b, kind: 'recommande' },
    ])
  })

  it('refuse plus de photos que de plis, y compris pour une entreprise sans pli', () => {
    const c = '0192f0a0-0000-7000-8000-00000000000c'
    const errors = checkPhotoCounts(counts, new Map([[a, 3], [b, 2], [c, 1]]))
    assert.deepEqual(Object.keys(errors).sort(), [photoFieldName(b), photoFieldName(c)].sort())
    assert.match(errors[photoFieldName(b)], /^2 photos pour 1 pli : une photo par pli/)
    assert.match(errors[photoFieldName(c)], /^1 photo pour 0 pli/)
  })
})
