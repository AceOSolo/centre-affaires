import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { defaultEffectiveOn, readAmendmentForm } from './avenant-formulaire.ts'
import { lineFieldName, lineToFormValues, type LineDraft } from './lignes.ts'

/**
 * Formulaire d'avenant (R12, ADR 025) : ce que l'écran refuse avant la base,
 * avec un message rattaché au champ.
 */
const BUREAU = '01a00000-0000-7000-8000-0000000000b2'
const periode = { startsOn: '2026-03-01', lastDay: '2026-12-31' }

const ligne = (overrides: Partial<LineDraft> = {}): LineDraft => ({
  offerItemId: null,
  target: { kind: 'none' },
  description: 'Bureau équipé',
  quantity: 1,
  unit: 'month',
  unitPriceCents: 95_000,
  discountBp: null,
  discountAmountCents: null,
  vatRateBp: 2000,
  isRecurring: true,
  ...overrides,
})

const lire = (fields: Record<string, string>, lignes: LineDraft[] = [], billedThrough: string | null = null) => {
  const all = new Map(Object.entries(fields))
  const keys = lignes.map((_, index) => String(index))
  lignes.forEach((line, index) => {
    for (const [field, value] of Object.entries(lineToFormValues(String(index), line))) {
      if (field !== 'key') all.set(lineFieldName(String(index), field as never), value)
    }
  })
  return readAmendmentForm((name) => all.get(name) ?? '', keys, { ...periode, billedThrough })
}

describe('formulaire d’avenant', () => {
  it('lit un nouveau montant à une date d’effet', () => {
    const result = lire({ effectiveOn: '2026-07-01', reason: 'Indexation', priceMode: 'amount', amount: '950,00' })
    assert.ok(result.ok)
    assert.deepEqual(result.input, {
      effectiveOn: '2026-07-01',
      reason: 'Indexation',
      priceMode: 'amount',
      amountCents: 95_000,
      lines: [],
      changesResource: false,
      resourceId: null,
    })
  })

  it('lit un changement de ressource sans changement de prix, ou le retrait de la ressource', () => {
    const vers = lire({ effectiveOn: '2026-05-01', priceMode: 'unchanged', changesResource: 'on', resourceId: BUREAU })
    assert.ok(vers.ok)
    assert.equal(vers.input.resourceId, BUREAU)
    const retrait = lire({ effectiveOn: '2026-05-01', priceMode: 'unchanged', changesResource: 'on', resourceId: '' })
    assert.ok(retrait.ok)
    assert.equal(retrait.input.changesResource, true)
    assert.equal(retrait.input.resourceId, null)
  })

  it('lit de nouvelles lignes, qui remplaceront les précédentes', () => {
    const result = lire({ effectiveOn: '2026-07-01', priceMode: 'lines' }, [ligne(), ligne({ description: 'Parking', unitPriceCents: 5_000 })])
    assert.ok(result.ok)
    assert.equal(result.input.lines.length, 2)
    assert.equal(result.input.amountCents, null)
  })

  it('refuse un avenant qui ne change rien', () => {
    const result = lire({ effectiveOn: '2026-07-01', priceMode: 'unchanged' })
    assert.ok(!result.ok)
    assert.ok(result.fieldErrors.priceMode)
  })

  it('refuse des lignes sans ligne récurrente', () => {
    const result = lire({ effectiveOn: '2026-07-01', priceMode: 'lines' }, [ligne({ isRecurring: false })])
    assert.ok(!result.ok)
    assert.match(result.fieldErrors.priceMode, /au moins une ligne récurrente/)
  })

  it('refuse une date d’effet au premier jour du contrat, ou après son dernier jour', () => {
    for (const effectiveOn of ['2026-03-01', '2026-02-15', '2027-01-01', '2026-02-30', '']) {
      const result = lire({ effectiveOn, priceMode: 'amount', amount: '950,00' })
      assert.ok(!result.ok, effectiveOn)
      assert.ok(result.fieldErrors.effectiveOn, effectiveOn)
    }
  })

  it('refuse un nouveau prix sur une période déjà facturée, pas un changement de ressource (ADR 032)', () => {
    // Facturé jusqu'au 31 octobre : le prix change au plus tôt le 1er novembre.
    for (const fields of [
      { effectiveOn: '2026-10-15', priceMode: 'amount', amount: '950,00' },
      { effectiveOn: '2026-10-31', priceMode: 'amount', amount: '950,00' },
    ]) {
      const result = lire(fields, [], '2026-10-31')
      assert.ok(!result.ok, fields.effectiveOn)
      assert.match(result.fieldErrors.effectiveOn, /facturé jusqu’au 31\/10\/2026.*au plus tôt le 01\/11\/2026/)
    }
    const lignes = lire({ effectiveOn: '2026-10-15', priceMode: 'lines' }, [ligne()], '2026-10-31')
    assert.ok(!lignes.ok)
    assert.ok(lignes.fieldErrors.effectiveOn)

    assert.ok(lire({ effectiveOn: '2026-11-01', priceMode: 'amount', amount: '950,00' }, [], '2026-10-31').ok)
    assert.ok(
      lire({ effectiveOn: '2026-10-15', priceMode: 'unchanged', changesResource: 'on', resourceId: BUREAU }, [], '2026-10-31').ok,
    )
  })

  it('propose le premier du mois suivant, après le début et le dernier avenant signé', () => {
    assert.equal(defaultEffectiveOn('2026-10-01', '2026-03-01', null), '2026-11-01')
    assert.equal(defaultEffectiveOn('2026-12-15', '2026-03-01', null), '2027-01-01')
    // Contrat qui commence plus tard : le lendemain de son début.
    assert.equal(defaultEffectiveOn('2026-10-01', '2027-02-01', null), '2027-02-02')
    // Avenant signé au 1er décembre : le 2 décembre au plus tôt.
    assert.equal(defaultEffectiveOn('2026-10-01', '2026-03-01', '2026-12-01'), '2026-12-02')
    // Trimestre facturé jusqu'au 31 décembre : le 1er janvier au plus tôt.
    assert.equal(defaultEffectiveOn('2026-10-01', '2026-03-01', null, '2026-12-31'), '2027-01-01')
    assert.equal(defaultEffectiveOn('2026-10-01', '2026-03-01', '2026-12-01', '2026-10-31'), '2026-12-02')
  })

  it('rattache les erreurs de lignes à leur champ', () => {
    const result = lire({ effectiveOn: '2026-07-01', priceMode: 'lines' }, [ligne({ description: '' })])
    assert.ok(!result.ok)
    assert.ok(result.fieldErrors['ligne-0-description'])
    assert.equal(result.lines.length, 1)
  })
})
