import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { contractRange } from './occupation.ts'
import { occupationConflictMessage } from './conflits.ts'

/**
 * Le refus d'une occupation (`23P01`) se dit en clair : la ressource, ce qui
 * l'occupe et que faire — jamais l'erreur SQL brute (ADR 018).
 */
const PARIS = 'Europe/Paris'

describe('message de conflit d’occupation', () => {
  it('nomme la ressource et chaque occupant', () => {
    const message = occupationConflictMessage(
      { name: 'Bureau 1', code: 'BUR-01' },
      [
        {
          kind: 'contract',
          title: 'Contrat CT-2026-0002',
          ...contractRange({ startsOn: '2026-01-01', endsOn: null, terminatedOn: null }, PARIS),
        },
        {
          kind: 'booking',
          title: 'Rendez-vous',
          startsAt: new Date('2026-03-12T08:00:00Z'),
          endsAt: new Date('2026-03-12T09:00:00Z'),
        },
      ],
      PARIS,
    )
    assert.match(message, /^La ressource Bureau 1 \(BUR-01\) est déjà occupée/)
    assert.match(message, /Occupé — contrat CT-2026-0002 \(à partir du 01\/01\/2026, sans terme\)/)
    assert.match(message, /« Rendez-vous » le 12\/03\/2026 de 09:00 à 10:00/)
    assert.match(message, /Choisissez une autre ressource/)
  })

  it('reste lisible quand l’occupant n’a pas pu être relu', () => {
    const message = occupationConflictMessage(undefined, [], PARIS)
    assert.match(message, /^La ressource est déjà occupée sur la période du contrat\./)
  })
})
