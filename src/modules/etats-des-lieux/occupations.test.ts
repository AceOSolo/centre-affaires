import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  canOpenEntry,
  canOpenExit,
  groupByOccupation,
  occupationKey,
  occupationProgress,
  type InspectionBrief,
} from './occupations.ts'

const RESSOURCE = 'r1'

let sequence = 0
const etat = (overrides: Partial<InspectionBrief & { unreturnedSince: Date | null }> = {}) => {
  sequence += 1
  return {
    id: `i${sequence}`,
    kind: 'entry' as const,
    status: 'closed' as const,
    resourceId: RESSOURCE,
    bookingId: 'b1',
    bookingKind: 'booking',
    contractId: null,
    entryInspectionId: null,
    performedAt: new Date(`2026-11-0${Math.min(sequence, 9)}T09:00:00Z`),
    unreturnedSince: null,
    ...overrides,
  }
}

describe('occupation d’un état des lieux (ADR 063)', () => {
  it('une réservation, ou un contrat sur une ressource — occupation ou brouillon', () => {
    assert.equal(occupationKey({ resourceId: RESSOURCE, bookingId: 'b1', bookingKind: 'booking', contractId: null }), 'b:b1')
    // Une réservation rattachée à un contrat reste une occupation à elle.
    assert.equal(occupationKey({ resourceId: RESSOURCE, bookingId: 'b1', bookingKind: 'booking', contractId: 'c1' }), 'b:b1')
    // L'occupation du contrat et le contrat en brouillon : la même.
    assert.equal(
      occupationKey({ resourceId: RESSOURCE, bookingId: 'o1', bookingKind: 'contract', contractId: 'c1' }),
      'c:c1:r1',
    )
    assert.equal(occupationKey({ resourceId: RESSOURCE, bookingId: null, bookingKind: null, contractId: 'c1' }), 'c:c1:r1')
    assert.equal(occupationKey({ resourceId: RESSOURCE, bookingId: null, bookingKind: null, contractId: null }), null)
  })

  it('suit l’occupation : aucune entrée, entrée en saisie, close, sortie en saisie, faite', () => {
    assert.deepEqual(occupationProgress('b:b1', []), { step: 'none' })
    const brouillon = etat({ status: 'draft' })
    assert.deepEqual(occupationProgress('b:b1', [brouillon]), { step: 'entry_draft', entryId: brouillon.id })
    const entree = etat()
    assert.deepEqual(occupationProgress('b:b1', [entree]), { step: 'entry_closed', entryId: entree.id })
    const sortie = etat({ kind: 'exit', status: 'draft', entryInspectionId: entree.id })
    assert.deepEqual(occupationProgress('b:b1', [entree, sortie]), {
      step: 'exit_draft',
      entryId: entree.id,
      exitId: sortie.id,
    })
    const close = { ...sortie, status: 'closed' as const }
    assert.deepEqual(occupationProgress('b:b1', [entree, close]), { step: 'done', entryId: entree.id, exitId: close.id })
    // L'entrée d'une autre occupation ne compte pas.
    assert.deepEqual(occupationProgress('b:b2', [entree, close]), { step: 'none' })
  })

  it('n’ouvre une entrée que sur une occupation qui n’en a pas, une sortie sur une entrée close', () => {
    const cas = [
      [{ step: 'none' }, true, true],
      [{ step: 'entry_draft', entryId: 'e' }, false, false],
      [{ step: 'entry_closed', entryId: 'e' }, false, true],
      [{ step: 'exit_draft', entryId: 'e', exitId: 'x' }, false, false],
      [{ step: 'done', entryId: 'e', exitId: 'x' }, false, false],
    ] as const
    for (const [progress, entree, sortie] of cas) {
      assert.equal(canOpenEntry(progress), entree, progress.step)
      assert.equal(canOpenExit(progress), sortie, progress.step)
    }
  })

  it('range la chronologie par occupation, la plus récente d’abord, la sortie sans entrée à part', () => {
    const ancienne = etat({ bookingId: 'b1', performedAt: new Date('2026-09-01T08:00:00Z') })
    const sortieAncienne = etat({
      kind: 'exit',
      bookingId: 'b1',
      entryInspectionId: ancienne.id,
      performedAt: new Date('2026-09-03T17:00:00Z'),
    })
    const sortieSeule = etat({ kind: 'exit', bookingId: 'b0', performedAt: new Date('2026-08-01T17:00:00Z') })
    const enRetard = etat({
      bookingId: 'b2',
      performedAt: new Date('2026-10-01T08:00:00Z'),
      unreturnedSince: new Date('2026-10-01T12:00:00Z'),
    })
    const enCours = etat({ bookingId: 'b3', performedAt: new Date('2026-11-01T08:00:00Z') })
    const brouillon = etat({ bookingId: 'b4', status: 'draft', performedAt: new Date('2026-11-02T08:00:00Z') })

    const groupes = groupByOccupation([sortieSeule, enCours, ancienne, sortieAncienne, brouillon, enRetard])
    assert.deepEqual(
      groupes.map((groupe) => [groupe.entry?.id ?? null, groupe.exit?.id ?? null, groupe.situation]),
      [
        [brouillon.id, null, 'entree_en_saisie'],
        [enCours.id, null, 'en_cours'],
        [enRetard.id, null, 'non_restituee'],
        [ancienne.id, sortieAncienne.id, 'restituee'],
        [null, sortieSeule.id, 'sortie_seule'],
      ],
    )
  })
})
