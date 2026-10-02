import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { anonymizationLogLine } from './bilan.ts'
import { parseLastContact } from './dernier-contact.ts'

describe('dernier contact noté (R29)', () => {
  const today = '2026-10-02'

  it('accepte aujourd’hui et un jour passé', () => {
    assert.deepEqual(parseLastContact('2026-10-02', today), { ok: true, date: '2026-10-02' })
    assert.deepEqual(parseLastContact(' 2024-02-29 ', today), { ok: true, date: '2024-02-29' })
  })

  it('refuse une date à venir, qui repousserait l’anonymisation sans contact réel', () => {
    assert.equal(parseLastContact('2026-10-03', today).ok, false)
  })

  it('refuse une date vide ou qui n’existe pas', () => {
    assert.equal(parseLastContact('', today).ok, false)
    assert.equal(parseLastContact(undefined, today).ok, false)
    assert.equal(parseLastContact('2026-02-30', today).ok, false)
    assert.equal(parseLastContact('02/10/2026', today).ok, false)
  })
})

describe('journal de la tâche de nuit (R29)', () => {
  it('ne dit que des nombres', () => {
    const line = anonymizationLogLine(
      { clients: 2, contacts: 3, accesses: 1, mailSenders: 14 },
      { accesses: 0, staff: 1 },
    )
    assert.equal(
      line,
      'Conservation (RGPD) : 2 entreprises anonymisées (3 contacts, 1 accès, 14 plis) ; 0 accès retiré anonymisé, 1 membre retiré de l’équipe anonymisé.',
    )
    assert.doesNotMatch(line, /@|[0-9a-f]{8}-/)
  })
})
