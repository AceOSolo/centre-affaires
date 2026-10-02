import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  centsToInput,
  decodeTarget,
  encodeTarget,
  formatBpAsPercent,
  lineFieldName,
  lineToFormValues,
  linesTotals,
  parsePercentToBp,
  readLinesForm,
  type LineDraft,
  type LineFormValues,
} from './lignes.ts'

/**
 * Lignes d'un contrat ou d'un avenant (R12, ADR 025) : saisie, contrôle et
 * totaux annoncés avant écriture. Les montants suivent la règle d'arrondi de
 * la base (ADR 023) ; la TVA se calcule par taux sur la somme des bases, comme
 * sur la facture.
 */
const BUREAU = '01a00000-0000-7000-8000-0000000000b1'
const SERVICE = '01a00000-0000-7000-8000-0000000000e1'

const ligne = (overrides: Partial<LineDraft> = {}): LineDraft => ({
  offerItemId: null,
  target: { kind: 'resource', resourceId: BUREAU },
  description: 'Bureau 1 (BUR-A1)',
  quantity: 1,
  unit: 'month',
  unitPriceCents: 90_000,
  discountBp: null,
  discountAmountCents: null,
  vatRateBp: 2000,
  isRecurring: true,
  ...overrides,
})

/** Simule l'envoi du formulaire : des lignes au format de saisie. */
const envoyer = (lignes: LineFormValues[]) => {
  const fields = new Map<string, string>()
  for (const values of lignes) {
    for (const [field, value] of Object.entries(values)) {
      if (field !== 'key') fields.set(lineFieldName(values.key, field as never), value)
    }
  }
  return readLinesForm(
    lignes.map((values) => values.key),
    (name) => fields.get(name) ?? '',
  )
}

describe('cibles d’une ligne', () => {
  it('s’écrivent et se relisent à l’identique', () => {
    for (const target of [
      { kind: 'none' },
      { kind: 'resource', resourceId: BUREAU },
      { kind: 'type', resourceType: 'bureau' },
      { kind: 'service', serviceId: SERVICE },
    ] as const) {
      assert.deepEqual(decodeTarget(encodeTarget(target)), target)
    }
  })

  it('refusent un type ou un identifiant inconnu', () => {
    assert.equal(decodeTarget('type:piscine'), undefined)
    assert.equal(decodeTarget('resource:bureau-1'), undefined)
    assert.equal(decodeTarget('autre:x'), undefined)
  })
})

describe('pourcentages en points de base', () => {
  it('lit un taux saisi à la française, sans flottant', () => {
    assert.equal(parsePercentToBp('20'), 2000)
    assert.equal(parsePercentToBp('5,5'), 550)
    assert.equal(parsePercentToBp('2.1'), 210)
    assert.equal(parsePercentToBp('12,5 %'), 1250)
    assert.equal(parsePercentToBp('0'), 0)
    assert.equal(parsePercentToBp('100'), 10_000)
  })

  it('refuse plus de 100 %, trois décimales ou une saisie illisible', () => {
    assert.equal(parsePercentToBp('100,01'), undefined)
    assert.equal(parsePercentToBp('5,555'), undefined)
    assert.equal(parsePercentToBp('vingt'), undefined)
    assert.equal(parsePercentToBp('-5'), undefined)
  })

  it('rend un taux au format de saisie, inverse exact de la lecture', () => {
    for (const bp of [0, 210, 550, 1000, 1250, 2000, 10_000]) {
      assert.equal(parsePercentToBp(formatBpAsPercent(bp)), bp)
    }
    assert.equal(formatBpAsPercent(550), '5,5')
    assert.equal(formatBpAsPercent(2000), '20')
    assert.equal(centsToInput(90_005), '900,05')
  })
})

describe('lecture du formulaire de lignes', () => {
  it('relit à l’identique une ligne mise au format de saisie', () => {
    const lignes = [
      ligne({ id: '01a00000-0000-7000-8000-0000000000f1' }),
      ligne({
        target: { kind: 'type', resourceType: 'bureau' },
        description: 'Poste de coworking',
        quantity: 2,
        unitPriceCents: 15_000,
        discountBp: 1000,
      }),
      ligne({
        target: { kind: 'none' },
        description: 'Frais de dossier',
        unit: 'unit',
        unitPriceCents: 5_000,
        discountAmountCents: 1_000,
        vatRateBp: 550,
        isRecurring: false,
      }),
    ]
    const result = envoyer(lignes.map((line, index) => lineToFormValues(String(index), line)))
    assert.ok(result.ok)
    assert.deepEqual(
      result.lines,
      lignes.map((line) => ({ ...line, id: line.id })),
    )
  })

  it('rattache chaque erreur au champ de sa ligne', () => {
    const valide = lineToFormValues('a', ligne())
    const fautive: LineFormValues = {
      ...lineToFormValues('b', ligne()),
      description: '',
      quantity: '1,5',
      unitPrice: '9OO',
      vatRate: '120',
      target: 'type:piscine',
    }
    const result = envoyer([valide, fautive])
    assert.ok(!result.ok)
    assert.deepEqual(Object.keys(result.fieldErrors).sort(), [
      'ligne-b-description',
      'ligne-b-quantity',
      'ligne-b-target',
      'ligne-b-unitPrice',
      'ligne-b-vatRate',
    ])
    // La saisie est rendue, pour être réaffichée telle quelle.
    assert.equal(result.values[1].quantity, '1,5')
  })

  it('refuse une remise en montant qui rendrait la ligne négative', () => {
    const result = envoyer([
      { ...lineToFormValues('a', ligne({ quantity: 2, unitPriceCents: 1_000 })), discountKind: 'amount', discount: '20,01' },
    ])
    assert.ok(!result.ok)
    assert.ok(result.fieldErrors['ligne-a-discount'])
  })

  it('accepte une liste vide : toutes les lignes sont retirées', () => {
    const result = readLinesForm([], () => '')
    assert.ok(result.ok)
    assert.deepEqual(result.lines, [])
  })
})

describe('totaux annoncés', () => {
  it('additionne le récurrent et le ponctuel, TVA par taux sur la somme des bases', () => {
    const totals = linesTotals([
      ligne({ unitPriceCents: 80_000 }),
      // 2 × 150 € remisés de 10 % : 270 €.
      ligne({ quantity: 2, unitPriceCents: 15_000, discountBp: 1000 }),
      // Trois lignes de 0,05 € à 5,5 % : 0,15 € de base, TVA arrondie une fois.
      ligne({ unitPriceCents: 5, vatRateBp: 550 }),
      ligne({ unitPriceCents: 5, vatRateBp: 550 }),
      ligne({ unitPriceCents: 5, vatRateBp: 550 }),
      ligne({ unitPriceCents: 5_000, isRecurring: false }),
    ])
    assert.equal(totals.recurringNetCents, 107_015)
    assert.deepEqual(totals.recurringVat, [
      { vatRateBp: 2000, baseCents: 107_000, vatCents: 21_400 },
      // 15 × 5,5 % = 0,825 → 1 centime, pas 3 × 0.
      { vatRateBp: 550, baseCents: 15, vatCents: 1 },
    ])
    assert.equal(totals.recurringVatCents, 21_401)
    assert.equal(totals.recurringGrossCents, 128_416)
    assert.equal(totals.oneOffNetCents, 5_000)
    assert.equal(totals.oneOffGrossCents, 6_000)
  })

  it('arrondit une remise en pourcentage une seule fois, la moitié s’éloignant de zéro', () => {
    // 3 × 3,33 € remisés de 12,5 % : 8,74125 € → 8,74 €.
    const totals = linesTotals([ligne({ quantity: 3, unitPriceCents: 333, discountBp: 1250 })])
    assert.equal(totals.recurringNetCents, 874)
    // 1 × 0,25 € remisé de 50 % : 0,125 € → 0,13 €.
    assert.equal(linesTotals([ligne({ unitPriceCents: 25, discountBp: 5000 })]).recurringNetCents, 13)
  })
})
