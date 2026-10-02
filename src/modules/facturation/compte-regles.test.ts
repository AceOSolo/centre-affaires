import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { clientInvoiceState, outstandingByCurrency } from './compte-regles.ts'

const TODAY = '2026-10-15'

const facture = (overrides: Partial<Parameters<typeof clientInvoiceState>[0]> = {}) => ({
  kind: 'invoice' as const,
  status: 'issued' as const,
  totalInclTaxCents: 12_000,
  paidCents: 0,
  creditedCents: 0,
  dueDate: '2026-10-31' as string | null,
  ...overrides,
})

describe('facture vue du client', () => {
  it('demande de régler le total d’une facture émise, avant l’échéance', () => {
    assert.deepEqual(clientInvoiceState(facture(), TODAY), {
      tone: 'due',
      label: 'À régler',
      amountDueCents: 12_000,
      overdue: false,
    })
  })

  it('n’est pas échue le jour même de l’échéance', () => {
    assert.equal(clientInvoiceState(facture({ dueDate: TODAY }), TODAY).overdue, false)
  })

  it('est échue le lendemain de l’échéance', () => {
    const state = clientInvoiceState(facture({ dueDate: '2026-10-14' }), TODAY)
    assert.equal(state.tone, 'overdue')
    assert.equal(state.label, 'Échue')
    assert.equal(state.amountDueCents, 12_000)
  })

  it('déduit les paiements et les avoirs du reste à régler', () => {
    const state = clientInvoiceState(
      facture({ status: 'partially_paid', paidCents: 2_000, creditedCents: 3_000 }),
      TODAY,
    )
    assert.equal(state.tone, 'partial')
    assert.equal(state.label, 'Payée en partie')
    assert.equal(state.amountDueCents, 7_000)
  })

  it('dit d’une facture échue et payée en partie qu’elle est échue', () => {
    const state = clientInvoiceState(
      facture({ status: 'partially_paid', paidCents: 2_000, dueDate: '2026-10-01' }),
      TODAY,
    )
    assert.equal(state.tone, 'overdue')
    assert.equal(state.label, 'Échue, payée en partie')
    assert.equal(state.amountDueCents, 10_000)
  })

  it('ne demande rien pour une facture payée, même échue', () => {
    const state = clientInvoiceState(
      facture({ status: 'paid', paidCents: 12_000, dueDate: '2026-09-01' }),
      TODAY,
    )
    assert.deepEqual(state, { tone: 'settled', label: 'Payée', amountDueCents: 0, overdue: false })
  })

  it('ne demande rien pour une facture annulée par avoir', () => {
    const state = clientInvoiceState(
      facture({ status: 'cancelled', creditedCents: 12_000, dueDate: '2026-09-01' }),
      TODAY,
    )
    assert.equal(state.tone, 'cancelled')
    assert.equal(state.label, 'Annulée par avoir')
    assert.equal(state.amountDueCents, 0)
  })

  it('ne demande jamais de régler un avoir', () => {
    const state = clientInvoiceState(facture({ kind: 'credit_note', dueDate: null }), TODAY)
    assert.deepEqual(state, { tone: 'credit', label: 'Avoir', amountDueCents: 0, overdue: false })
  })

  it('ne réclame pas un trop-perçu', () => {
    // Payée deux fois : le reste dû est négatif, rien n'est à régler.
    const state = clientInvoiceState(facture({ status: 'paid', paidCents: 24_000 }), TODAY)
    assert.equal(state.amountDueCents, 0)
  })

  it('ne lit pas d’échéance sur une facture sans date d’échéance', () => {
    assert.equal(clientInvoiceState(facture({ dueDate: null }), TODAY).overdue, false)
  })
})

describe('reste à régler du client', () => {
  it('additionne les restes dus par devise, et la part échue', () => {
    const totals = outstandingByCurrency(
      [
        { ...facture(), currency: 'EUR' },
        { ...facture({ dueDate: '2026-10-01', paidCents: 2_000, status: 'partially_paid' }), currency: 'EUR' },
        { ...facture({ status: 'paid', paidCents: 12_000 }), currency: 'EUR' },
        { ...facture({ kind: 'credit_note' }), currency: 'EUR' },
        { ...facture({ totalInclTaxCents: 5_000 }), currency: 'CHF' },
      ],
      TODAY,
    )
    assert.deepEqual(totals, [
      { currency: 'CHF', dueCents: 5_000, overdueCents: 0, count: 1 },
      { currency: 'EUR', dueCents: 22_000, overdueCents: 10_000, count: 2 },
    ])
  })

  it('ne rend rien quand tout est réglé', () => {
    assert.deepEqual(
      outstandingByCurrency([{ ...facture({ status: 'paid', paidCents: 12_000 }), currency: 'EUR' }], TODAY),
      [],
    )
  })
})
