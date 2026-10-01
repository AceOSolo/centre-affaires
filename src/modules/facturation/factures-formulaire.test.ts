import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  centsToAmountInput,
  isCalendarDate,
  readCreditReason,
  readDraftInvoiceForm,
  readLineEditForm,
  readManualLineForm,
} from './factures-formulaire.ts'

/** Formulaires de facture (R13) : ce qui est refusé avant d'atteindre la base. */
const form = (values: Record<string, string>) => (name: string) => values[name] ?? ''

describe('conditions d’un brouillon', () => {
  const valides = {
    periodStart: '2026-10-01',
    periodEnd: '2026-10-31',
    paymentTermsDays: '',
    expectedPaymentMethod: 'transfer',
    buyerReference: ' ',
    notes: '',
  }

  it('lit une saisie valide ; un délai vide laisse celui du centre', () => {
    const read = readDraftInvoiceForm(form({ ...valides, buyerReference: '' }))
    assert.ok(read.ok)
    assert.deepEqual(read.input, {
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      paymentTermsDays: null,
      expectedPaymentMethod: 'transfer',
      buyerReference: null,
      notes: null,
    })
  })

  it('refuse une période à l’envers, un délai au-delà de 60 jours, un mode inconnu', () => {
    const read = readDraftInvoiceForm(
      form({ ...valides, periodEnd: '2026-09-30', paymentTermsDays: '61', expectedPaymentMethod: 'cheque' }),
    )
    assert.equal(read.ok, false)
    assert.deepEqual(Object.keys(read.ok ? {} : read.fieldErrors).sort(), [
      'expectedPaymentMethod',
      'paymentTermsDays',
      'periodEnd',
    ])
  })

  it('accepte un paiement à réception (0 jour)', () => {
    const read = readDraftInvoiceForm(form({ ...valides, paymentTermsDays: '0' }))
    assert.ok(read.ok && read.input.paymentTermsDays === 0)
  })
})

describe('ligne ajoutée à la main', () => {
  const remise = {
    kind: 'discount',
    description: 'Geste commercial',
    quantity: '1',
    unitPrice: '50,00',
    vatRate: '2000',
    vatExemptionReason: '',
    linePeriodStart: '',
    linePeriodEnd: '',
  }

  it('lit une remise en positif, au taux normal', () => {
    const read = readManualLineForm(form(remise))
    assert.ok(read.ok)
    assert.equal(read.input.kind, 'discount')
    assert.equal(read.input.unitPriceCents, 5_000)
    assert.equal(read.input.vatCategory, 'S')
    assert.equal(read.input.periodStart, null)
  })

  it('exige le motif d’une ligne sans TVA, qui devient une exonération', () => {
    const sansMotif = readManualLineForm(form({ ...remise, kind: 'other', vatRate: '0' }))
    assert.equal(sansMotif.ok, false)
    assert.ok(!sansMotif.ok && sansMotif.fieldErrors.vatExemptionReason)

    const avecMotif = readManualLineForm(
      form({ ...remise, kind: 'other', vatRate: '0', vatExemptionReason: 'Article 261 D du CGI' }),
    )
    assert.ok(avecMotif.ok)
    assert.equal(avecMotif.input.vatCategory, 'E')
    assert.equal(avecMotif.input.vatExemptionReason, 'Article 261 D du CGI')
  })

  it('refuse un taux hors liste, une quantité non entière, un prix illisible, une période à moitié', () => {
    const read = readManualLineForm(
      form({ ...remise, vatRate: '1950', quantity: '1,5', unitPrice: 'douze', linePeriodStart: '2026-10-01' }),
    )
    assert.equal(read.ok, false)
    assert.deepEqual(Object.keys(read.ok ? {} : read.fieldErrors).sort(), [
      'linePeriodEnd',
      'quantity',
      'unitPrice',
      'vatRate',
    ])
  })
})

describe('ligne modifiée', () => {
  it('ne lit le prix que d’une ligne qui le laisse modifier', () => {
    const values = form({ description: 'Bureau 3', quantity: '2', unitPrice: '10,00', vatExemptionReason: '' })
    const sansPrix = readLineEditForm(values, { priceEditable: false, exemptionEditable: false })
    assert.ok(sansPrix.ok)
    assert.equal(sansPrix.input.unitPriceCents, undefined)
    assert.equal(sansPrix.input.vatExemptionReason, undefined)

    const avecPrix = readLineEditForm(values, { priceEditable: true, exemptionEditable: true })
    assert.ok(avecPrix.ok)
    assert.equal(avecPrix.input.unitPriceCents, 1_000)
    assert.equal(avecPrix.input.vatExemptionReason, null)
  })

  it('refuse une désignation vide et une quantité nulle', () => {
    const read = readLineEditForm(form({ description: '', quantity: '0' }), {
      priceEditable: false,
      exemptionEditable: false,
    })
    assert.equal(read.ok, false)
    assert.deepEqual(Object.keys(read.ok ? {} : read.fieldErrors).sort(), ['description', 'quantity'])
  })
})

describe('saisies diverses', () => {
  it('exige le motif d’un avoir', () => {
    assert.equal(readCreditReason('  ').ok, false)
    assert.deepEqual(readCreditReason(' Erreur de période '), { ok: true, reason: 'Erreur de période' })
  })

  it('rend un montant au format de saisie, en valeur absolue', () => {
    assert.equal(centsToAmountInput(90_000), '900,00')
    assert.equal(centsToAmountInput(-1_005), '10,05')
  })

  it('refuse une date qui n’existe pas', () => {
    assert.equal(isCalendarDate('2026-02-29'), false)
    assert.equal(isCalendarDate('2028-02-29'), true)
  })
})
