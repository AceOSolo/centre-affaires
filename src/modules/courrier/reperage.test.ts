import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { spotLabel, spotsOfDay } from './reperage.ts'

/**
 * Repérage d'un pli dans la pile du jour (ADR 057) : rang par entreprise et
 * par jour du centre, dans l'ordre d'enregistrement.
 */
const PARIS = 'Europe/Paris'
const ACME = 'client-acme'
const BETA = 'client-beta'

const pli = (id: string, clientId: string, receivedAt: string) => ({ id, clientId, receivedAt: new Date(receivedAt) })

describe('rang d’un pli dans sa journée', () => {
  it('numérote les plis d’une entreprise dans l’ordre de réception, sans mêler les autres', () => {
    const spots = spotsOfDay(
      [
        pli('01a2-c', ACME, '2026-11-04T10:30:00Z'),
        pli('01a2-a', ACME, '2026-11-04T08:00:00Z'),
        pli('01a2-x', BETA, '2026-11-04T09:00:00Z'),
        pli('01a2-b', ACME, '2026-11-04T09:15:00Z'),
      ],
      PARIS,
    )
    assert.deepEqual(
      ['01a2-a', '01a2-b', '01a2-c', '01a2-x'].map((id) => spots.get(id)),
      [
        { rank: 1, total: 3, day: '2026-11-04' },
        { rank: 2, total: 3, day: '2026-11-04' },
        { rank: 3, total: 3, day: '2026-11-04' },
        { rank: 1, total: 1, day: '2026-11-04' },
      ],
    )
  })

  it('départage une saisie groupée, à la même heure, par l’ordre d’enregistrement', () => {
    // Identifiants UUID v7 : ordonnés comme leur création.
    const spots = spotsOfDay(
      [
        pli('01a162b5-5ebf-7f26', ACME, '2026-10-22T08:23:00Z'),
        pli('01a162b5-5ebf-7c74', ACME, '2026-10-22T08:23:00Z'),
      ],
      PARIS,
    )
    assert.equal(spots.get('01a162b5-5ebf-7c74')?.rank, 1)
    assert.equal(spots.get('01a162b5-5ebf-7f26')?.rank, 2)
  })

  it('suit le jour du centre, pas celui de l’UTC', () => {
    // 23 h 30 UTC le 3 novembre : 0 h 30 le 4 à Paris.
    const spots = spotsOfDay(
      [pli('a', ACME, '2026-11-03T23:30:00Z'), pli('b', ACME, '2026-11-04T07:00:00Z'), pli('c', ACME, '2026-11-03T22:59:00Z')],
      PARIS,
    )
    assert.deepEqual(spots.get('a'), { rank: 1, total: 2, day: '2026-11-04' })
    assert.deepEqual(spots.get('b'), { rank: 2, total: 2, day: '2026-11-04' })
    assert.deepEqual(spots.get('c'), { rank: 1, total: 1, day: '2026-11-03' })
  })

  it('tient le jour du changement d’heure', () => {
    // Le 25 octobre 2026 dure 25 heures à Paris : de 22 h UTC la veille à 23 h UTC.
    const spots = spotsOfDay(
      [pli('a', ACME, '2026-10-24T22:00:00Z'), pli('b', ACME, '2026-10-25T22:59:00Z'), pli('c', ACME, '2026-10-25T23:00:00Z')],
      PARIS,
    )
    assert.deepEqual([spots.get('a')?.day, spots.get('b')?.day, spots.get('c')?.day], ['2026-10-25', '2026-10-25', '2026-10-26'])
    assert.equal(spots.get('b')?.total, 2)
  })
})

describe('libellé du repère', () => {
  it('dit le rang et le jour', () => {
    assert.equal(spotLabel({ rank: 3, total: 5, day: '2026-11-04' }, '2026-11-04'), 'pli 3 sur 5 du 04/11')
  })

  it('dit « seul pli » quand il n’y en a qu’un', () => {
    assert.equal(spotLabel({ rank: 1, total: 1, day: '2026-11-02' }, '2026-11-04'), 'seul pli du 02/11')
  })

  it('ajoute l’année d’un pli d’une autre année', () => {
    assert.equal(spotLabel({ rank: 1, total: 2, day: '2025-12-28' }, '2026-01-05'), 'pli 1 sur 2 du 28/12/2025')
  })
})
