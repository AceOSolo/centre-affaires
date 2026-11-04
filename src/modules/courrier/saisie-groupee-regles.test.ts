import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { uuidv7 } from '../../lib/uuid.ts'
import {
  entryFieldName,
  groupEntry,
  inEntryOrder,
  orderedIds,
  parseMailEntry,
} from './saisie-groupee-regles.ts'

/**
 * Saisie groupée du courrier (ADR 058) : une photo = un pli. Chaque pli de
 * l'envoi est un groupe de champs `pli.<clé>.<champ>`.
 */
const a = '0192f0a0-0000-7000-8000-00000000000a'
const b = '0192f0a0-0000-7000-8000-00000000000b'

const photo = (name: string) => new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], name, { type: 'image/jpeg' })
const vide = () => new File([], '', { type: 'application/octet-stream' })

/** Les champs d'un pli, comme l'écran les envoie. */
const pli = (key: number, clientId: string, kind: string, sender = '', file?: File): [string, unknown][] => [
  [entryFieldName(key, 'client'), clientId],
  [entryFieldName(key, 'kind'), kind],
  [entryFieldName(key, 'sender'), sender],
  ...(file ? ([[entryFieldName(key, 'photo'), file]] as [string, unknown][]) : []),
]

describe('lecture d’une saisie : une photo = un pli', () => {
  it('lit chaque pli avec son entreprise, son type, son expéditeur et sa photo, dans l’ordre de l’envoi', () => {
    const p1 = photo('p1.jpg')
    const p3 = photo('p3.jpg')
    const { items, count, fieldErrors } = parseMailEntry([
      ['receivedAt', '2026-11-04T09:00'],
      ...pli(7, a, 'lettre', '  urssaf ', p1),
      ...pli(3, a, 'lettre'),
      ...pli(12, b, 'colis', '', p3),
    ])
    assert.deepEqual(fieldErrors, {})
    assert.equal(count, 3)
    assert.deepEqual(
      items.map((item) => [item.key, item.clientId, item.kind, item.sender, item.envelope?.name]),
      [
        ['7', a, 'lettre', 'urssaf', 'p1.jpg'],
        ['3', a, 'lettre', null, undefined],
        ['12', b, 'colis', null, 'p3.jpg'],
      ],
    )
  })

  it('un pli sans photo reste un pli ; un champ de fichier vide n’est pas une photo', () => {
    const { items } = parseMailEntry([...pli(1, a, 'recommande', '', vide())])
    assert.equal(items.length, 1)
    assert.equal(items[0].envelope, undefined)
  })

  it('ignore les champs étrangers', () => {
    const { items, count, fieldErrors } = parseMailEntry([
      ['receivedAt', '2026-11-04T09:00'],
      ['entreprise', a],
      ['pli.x.client', a],
      ['pli.1.couleur', 'bleu'],
    ])
    assert.deepEqual([items, count, fieldErrors], [[], 0, {}])
  })

  it('refuse un pli sans entreprise ou d’un type inconnu, plutôt que de le deviner', () => {
    const { items, count, fieldErrors } = parseMailEntry([...pli(1, 'pas-un-uuid', 'lettre'), ...pli(2, a, 'pigeon')])
    assert.deepEqual(items, [])
    assert.equal(count, 2)
    assert.ok(fieldErrors[entryFieldName(1, 'client')])
    assert.ok(fieldErrors[entryFieldName(2, 'kind')])
  })

  it('refuse deux photos pour un même pli : chaque photo est un pli', () => {
    const { items, fieldErrors } = parseMailEntry([...pli(1, a, 'lettre', '', photo('1.jpg')), [entryFieldName(1, 'photo'), photo('2.jpg')]])
    assert.deepEqual(items, [])
    assert.match(fieldErrors[entryFieldName(1, 'photo')], /Une seule photo par pli/)
  })

  it('refuse un expéditeur trop long sur le champ de ce pli', () => {
    const { fieldErrors } = parseMailEntry(pli(4, a, 'lettre', 'x'.repeat(200)))
    assert.match(fieldErrors[entryFieldName(4, 'sender')], /120 caractères au plus/)
  })
})

describe('récapitulatif de la saisie', () => {
  const plis = [
    { key: 1, clientId: a, kind: 'lettre' as const },
    { key: 2, clientId: b, kind: 'colis' as const },
    { key: 3, clientId: a, kind: 'colis' as const },
    { key: 4, clientId: a, kind: 'lettre' as const },
    { key: 5, clientId: a, kind: 'lettre' as const },
  ]

  it('« ACME : 3 lettres et 1 colis » : par entreprise, dans l’ordre où chacune est apparue', () => {
    const groups = groupEntry(plis)
    assert.deepEqual(
      groups.map((group) => [group.clientId, group.phrase]),
      [
        [a, '3 lettres et 1 colis'],
        [b, '1 colis'],
      ],
    )
    assert.equal(groups[0].byKind.lettre, 3)
  })

  it('garde, dans une entreprise, l’ordre des photos : celui de l’enregistrement', () => {
    assert.deepEqual(
      inEntryOrder(plis).map((item) => item.key),
      [1, 3, 4, 5, 2],
    )
  })

  it('une saisie vide n’a pas de récapitulatif', () => {
    assert.deepEqual(groupEntry([]), [])
  })
})

describe('identifiants des plis d’un envoi', () => {
  it('suivent l’ordre d’attribution, même tirés dans la même milliseconde', () => {
    // Un UUID v7 ne porte que la milliseconde : tirés en rafale, ils sortent dans le désordre.
    const ids = orderedIds(200, uuidv7)
    assert.deepEqual(ids, [...ids].sort())
    assert.equal(new Set(ids).size, 200)
  })

  it('trient ce que le générateur rend dans le désordre', () => {
    const tirages = ['0192-c', '0192-a', '0192-b']
    assert.deepEqual(orderedIds(3, () => tirages.shift() as string), ['0192-a', '0192-b', '0192-c'])
  })
})
