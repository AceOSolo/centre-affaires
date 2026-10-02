import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { anonymizationTraceLabel, parseAnonymizationRequest } from './fondement.ts'

/**
 * Fondement d'une anonymisation à la demande (R29, ADR 041) : ce que
 * l'équipe saisit, et ce que les écrans en disent ensuite.
 */
describe('fondement d’une anonymisation à la demande', () => {
  const today = '2026-10-02'

  it('date une demande d’effacement du jour où elle a été reçue, passé ou aujourd’hui', () => {
    assert.deepEqual(parseAnonymizationRequest({ basis: 'erasure_request', erasureRequestedOn: '2026-09-28' }, today), {
      ok: true,
      basis: 'erasure_request',
      erasureRequestedOn: '2026-09-28',
    })
    assert.equal(
      parseAnonymizationRequest({ basis: 'erasure_request', erasureRequestedOn: ' 2026-10-02 ' }, today).ok,
      true,
    )
  })

  it('refuse une demande d’effacement sans date, à une date à venir ou qui n’existe pas', () => {
    for (const erasureRequestedOn of ['', '2026-10-03', '2026-02-30', '28/09/2026']) {
      const outcome = parseAnonymizationRequest({ basis: 'erasure_request', erasureRequestedOn }, today)
      assert.equal(outcome.ok, false, erasureRequestedOn)
    }
  })

  it('ne date pas une fin de relation, et refuse un fondement absent ou « au terme »', () => {
    assert.deepEqual(
      parseAnonymizationRequest({ basis: 'relationship_ended', erasureRequestedOn: '2026-09-28' }, today),
      { ok: true, basis: 'relationship_ended', erasureRequestedOn: null },
    )
    for (const basis of ['', 'retention', 'constructor']) {
      assert.equal(parseAnonymizationRequest({ basis, erasureRequestedOn: '' }, today).ok, false, basis)
    }
  })

  it('dit le fondement, la date de la demande et l’auteur', () => {
    assert.equal(
      anonymizationTraceLabel({ basis: 'erasure_request', erasureRequestedOn: '2026-09-28', byName: 'Camille Martin' }),
      'à la demande d’effacement reçue le 28/09/2026, par Camille Martin',
    )
    assert.equal(
      anonymizationTraceLabel({ basis: 'relationship_ended', erasureRequestedOn: null, byName: 'Camille Martin' }),
      'à la fin de la relation, par Camille Martin',
    )
    assert.equal(
      anonymizationTraceLabel({ basis: 'retention', erasureRequestedOn: null, byName: null }),
      'au terme de la durée de conservation',
    )
    // Anonymisée avant que le fondement ne soit tracé (migration 0044).
    assert.equal(anonymizationTraceLabel({ basis: null, erasureRequestedOn: null, byName: null }), null)
  })
})
