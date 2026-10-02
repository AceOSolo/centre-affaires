import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { reminderDraft, type ReminderContext } from './reglements.ts'
import type { Invoice } from './schema-factures.ts'

/**
 * La relance du jour (R16, ADR 030, ADR 034) : la lettre qui s'affiche,
 * s'imprime, part par courriel et s'inscrit au journal est la même.
 */
const contexte = (invoice: Partial<Invoice>): ReminderContext => ({
  invoice: {
    id: 'f1',
    kind: 'invoice',
    status: 'issued',
    number: 'FA-2026-0007',
    issueDate: '2026-09-01',
    dueDate: '2026-10-01',
    currency: 'EUR',
    totalInclTaxCents: 12_000,
    paidCents: 0,
    creditedCents: 0,
    expectedPaymentMethod: 'transfer',
    legalMentions: null,
    ...invoice,
  } as Invoice,
  client: { id: 'c1', name: 'Atelier Durand', email: 'compta@durand.fr' },
  tenant: {
    name: 'Centre',
    legalName: 'Centre de démonstration SAS',
    bankIban: 'FR7630006000011234567890189',
    bankBic: null,
    latePaymentPenaltyText: 'Pénalités : taux BCE majoré de 10 points.',
    recoveryIndemnityCents: 4_000,
    timezone: 'Europe/Paris',
  },
  recipients: ['compta@durand.fr'],
})

describe('relance du jour', () => {
  it('suit le palier du retard et réclame le reste dû', () => {
    const amiable = reminderDraft(contexte({}), '2026-10-02')
    assert.equal(amiable?.level, 1)
    assert.equal(amiable?.amountDueCents, 12_000)
    assert.match(amiable?.subject ?? '', /FA-2026-0007/)
    assert.match(amiable?.text ?? '', /120,00/)
    assert.equal(reminderDraft(contexte({ paidCents: 2_000 }), '2026-11-15')?.level, 3)
    assert.equal(reminderDraft(contexte({ paidCents: 2_000 }), '2026-11-15')?.amountDueCents, 10_000)
  })

  it('ne relance ni avant l’échéance, ni une facture réglée, ni un brouillon', () => {
    assert.equal(reminderDraft(contexte({}), '2026-10-01'), null)
    assert.equal(reminderDraft(contexte({ paidCents: 12_000, status: 'paid' }), '2026-10-20'), null)
    assert.equal(reminderDraft(contexte({ status: 'draft', number: null }), '2026-10-20'), null)
  })
})
