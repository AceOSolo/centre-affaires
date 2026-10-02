import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { clientContractState } from './compte-regles.ts'

const TODAY = '2026-10-15'

const contrat = (
  overrides: Partial<Parameters<typeof clientContractState>[0]> = {},
): Parameters<typeof clientContractState>[0] => ({
  status: 'active',
  startsOn: '2026-01-01',
  endsOn: null,
  terminatedOn: null,
  ...overrides,
})

describe('contrat vu du client', () => {
  it('est en cours entre son premier et son dernier jour', () => {
    assert.deepEqual(clientContractState(contrat(), TODAY), { tone: 'active', label: 'En cours' })
  })

  it('est encore en cours le jour de son terme', () => {
    assert.equal(clientContractState(contrat({ endsOn: TODAY }), TODAY).tone, 'active')
  })

  it('est arrivé à terme le lendemain de son dernier jour', () => {
    assert.deepEqual(clientContractState(contrat({ endsOn: '2026-10-14' }), TODAY), {
      tone: 'ended',
      label: 'Arrivé à terme',
    })
  })

  it('est à venir avant son premier jour', () => {
    assert.equal(clientContractState(contrat({ startsOn: '2026-11-01' }), TODAY).tone, 'upcoming')
  })

  it('court jusqu’à la fin du préavis une fois résilié', () => {
    const state = clientContractState(
      contrat({ status: 'terminated', terminatedOn: '2026-12-31' }),
      TODAY,
    )
    assert.equal(state.tone, 'ending')
  })

  it('est résilié une fois le dernier jour passé', () => {
    assert.deepEqual(
      clientContractState(contrat({ status: 'terminated', terminatedOn: '2026-09-30' }), TODAY),
      { tone: 'terminated', label: 'Résilié' },
    )
  })

  it('prend le plus proche du terme prévu et de la résiliation', () => {
    // Terme prévu au 30/09, résiliation notifiée pour plus tard : le contrat
    // s'est éteint à son terme.
    const state = clientContractState(
      contrat({ status: 'terminated', endsOn: '2026-09-30', terminatedOn: '2026-12-31' }),
      TODAY,
    )
    assert.equal(state.tone, 'terminated')
  })

  it('est résilié, pas à venir, quand la résiliation précède le début', () => {
    const state = clientContractState(
      contrat({ status: 'terminated', startsOn: '2026-11-01', terminatedOn: '2026-10-31' }),
      TODAY,
    )
    assert.equal(state.tone, 'terminated')
  })
})
