import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  centsToInput,
  checkPaymentAmount,
  daysBetween,
  daysOverdue,
  dunningLevel,
  formatIbanGroups,
  isIsoDate,
  readCancellationReason,
  readPaymentForm,
  reminderMessage,
  type ReminderFacts,
} from './paiements-regles.ts'
import { formatCents } from './tarifs.ts'

/**
 * Pointage des paiements et relances (R16, ADR 027, ADR 028) : lecture de la
 * saisie, contrôle du montant face au reste dû, paliers et texte des relances.
 */
const form = (values: Record<string, string>) => {
  const data = new FormData()
  for (const [key, value] of Object.entries(values)) data.set(key, value)
  return data
}

const TODAY = '2026-10-15'

describe('lecture du pointage d’un paiement', () => {
  it('lit un paiement reçu en centimes, sans flottant', () => {
    const read = readPaymentForm(
      form({ amount: '1 250,10', paidOn: '2026-10-14', method: 'transfer', reference: ' VIR 4512 ' }),
      { today: TODAY },
    )
    assert.ok('input' in read)
    assert.deepEqual(read.input, {
      amountCents: 125_010,
      paidOn: '2026-10-14',
      method: 'transfer',
      reference: 'VIR 4512',
      notes: null,
      overpaymentConfirmed: false,
    })
  })

  it('porte un remboursement en montant négatif', () => {
    const read = readPaymentForm(
      form({ direction: 'refund', amount: '19,99', paidOn: TODAY, method: 'transfer' }),
      { today: TODAY },
    )
    assert.ok('input' in read)
    assert.equal(read.input.amountCents, -1_999)
  })

  it('accepte le jour même et refuse une date future ou impossible', () => {
    const future = readPaymentForm(form({ amount: '10', paidOn: '2026-10-16', method: 'other' }), { today: TODAY })
    assert.ok('fieldErrors' in future)
    assert.match(future.fieldErrors.paidOn ?? '', /future/)

    const impossible = readPaymentForm(form({ amount: '10', paidOn: '2026-02-31', method: 'other' }), { today: TODAY })
    assert.ok('fieldErrors' in impossible)
    assert.equal(impossible.fieldErrors.paidOn, 'Date illisible.')
  })

  it('signale chaque champ fautif et rend la saisie', () => {
    const read = readPaymentForm(
      form({ amount: '12,345', paidOn: '', method: 'cash', reference: 'x'.repeat(141), overpaymentConfirmed: 'on' }),
      { today: TODAY },
    )
    assert.ok('fieldErrors' in read)
    assert.deepEqual(Object.keys(read.fieldErrors).sort(), ['amount', 'method', 'paidOn', 'reference'])
    assert.equal(read.values.amount, '12,345')
    assert.equal(read.values.overpaymentConfirmed, true)
  })

  it('réserve les références de remise de prélèvement', () => {
    const read = readPaymentForm(
      form({ amount: '10', paidOn: TODAY, method: 'direct_debit', reference: 'prlv-20261001-ABCDEF' }),
      { today: TODAY },
    )
    assert.ok('fieldErrors' in read)
    assert.match(read.fieldErrors.reference ?? '', /réservées aux remises/)
  })

  it('refuse un montant nul ou absent', () => {
    const zero = readPaymentForm(form({ amount: '0,00', paidOn: TODAY, method: 'transfer' }), { today: TODAY })
    assert.ok('fieldErrors' in zero)
    assert.match(zero.fieldErrors.amount ?? '', /nul/)
    const absent = readPaymentForm(form({ paidOn: TODAY, method: 'transfer' }), { today: TODAY })
    assert.ok('fieldErrors' in absent)
    assert.equal(absent.fieldErrors.amount, 'Saisissez le montant.')
  })
})

describe('contrôle du montant face à la facture', () => {
  const base = { amountDueCents: 12_000, paidCents: 0, currency: 'EUR', overpaymentConfirmed: false }

  it('accepte un paiement partiel ou exact', () => {
    assert.equal(checkPaymentAmount({ ...base, amountCents: 5_000 }), undefined)
    assert.equal(checkPaymentAmount({ ...base, amountCents: 12_000 }), undefined)
  })

  it('refuse un trop-perçu non assumé, l’accepte une fois coché', () => {
    const message = checkPaymentAmount({ ...base, amountCents: 120_000 })
    assert.ok(message?.includes(formatCents(12_000)))
    assert.equal(checkPaymentAmount({ ...base, amountCents: 120_000, overpaymentConfirmed: true }), undefined)
  })

  it('dit qu’une facture réglée n’attend plus rien', () => {
    const message = checkPaymentAmount({ ...base, amountDueCents: 0, paidCents: 12_000, amountCents: 100 })
    assert.match(message ?? '', /déjà réglée/)
  })

  it('borne un remboursement aux paiements reçus', () => {
    assert.equal(checkPaymentAmount({ ...base, paidCents: 15_000, amountDueCents: -3_000, amountCents: -3_000 }), undefined)
    assert.match(
      checkPaymentAmount({ ...base, paidCents: 15_000, amountCents: -15_001 }) ?? '',
      /dépasse les paiements reçus/,
    )
    assert.match(checkPaymentAmount({ ...base, amountCents: -100 }) ?? '', /rien à rembourser/)
  })
})

describe('motif d’annulation d’un pointage', () => {
  it('l’exige et le borne', () => {
    assert.ok('error' in readCancellationReason(form({ reason: '  ' })))
    assert.ok('error' in readCancellationReason(form({ reason: 'x'.repeat(501) })))
    assert.deepEqual(readCancellationReason(form({ reason: ' Rejet de prélèvement ' })), {
      reason: 'Rejet de prélèvement',
    })
  })
})

describe('montant prérempli', () => {
  it('écrit les centimes comme on les saisit, et se relit à l’identique', () => {
    assert.equal(centsToInput(125_010), '1250,10')
    assert.equal(centsToInput(5), '0,05')
    assert.equal(centsToInput(-300), '-3,00')
    const read = readPaymentForm(form({ amount: centsToInput(125_010), paidOn: TODAY, method: 'transfer' }), {
      today: TODAY,
    })
    assert.ok('input' in read)
    assert.equal(read.input.amountCents, 125_010)
  })
})

describe('jours civils', () => {
  it('compte les jours sans fuseau, à travers les mois, années et changements d’heure', () => {
    assert.equal(daysBetween('2026-10-24', '2026-10-26'), 2)
    assert.equal(daysBetween('2026-12-31', '2027-01-01'), 1)
    assert.equal(daysBetween('2028-02-28', '2028-03-01'), 2)
    assert.equal(daysBetween('2026-10-15', '2026-10-01'), -14)
  })

  it('reconnaît un jour réel', () => {
    assert.equal(isIsoDate('2028-02-29'), true)
    assert.equal(isIsoDate('2027-02-29'), false)
    assert.equal(isIsoDate('2026-13-01'), false)
    assert.equal(isIsoDate('01/10/2026'), false)
  })
})

describe('paliers de relance', () => {
  it('ne relance pas le jour de l’échéance', () => {
    assert.equal(daysOverdue('2026-10-15', TODAY), 0)
    assert.equal(dunningLevel('2026-10-15', TODAY), 0)
    assert.equal(dunningLevel('2026-11-30', TODAY), 0)
  })

  it('passe à la relance amiable le lendemain, à la seconde à 15 jours, à la mise en demeure à 30', () => {
    assert.equal(dunningLevel('2026-10-14', TODAY), 1)
    assert.equal(dunningLevel('2026-10-01', TODAY), 1)
    assert.equal(dunningLevel('2026-09-30', TODAY), 2)
    assert.equal(dunningLevel('2026-09-16', TODAY), 2)
    assert.equal(dunningLevel('2026-09-15', TODAY), 3)
    assert.equal(daysOverdue('2026-09-15', TODAY), 30)
  })
})

describe('texte d’une relance', () => {
  const facts: ReminderFacts = {
    sellerName: 'Centre de démonstration SAS',
    clientName: 'Atelier Durand',
    invoiceNumber: 'FA-2026-0007',
    issueDate: '2026-09-01',
    dueDate: '2026-10-01',
    today: TODAY,
    amountDueCents: 108_000,
    currency: 'EUR',
    level: 1,
    expectedPaymentMethod: 'transfer',
    bankIban: 'FR7630006000011234567890189',
    bankBic: 'AGRIFRPP',
    latePaymentPenaltyText: 'Pénalités de retard : taux BCE majoré de 10 points.',
    recoveryIndemnityCents: 4_000,
  }

  it('rappelle la facture, le reste dû, l’IBAN du centre et la référence à porter', () => {
    const { subject, text } = reminderMessage(facts)
    assert.equal(subject, 'Relance — facture FA-2026-0007 échue le 01/10/2026')
    assert.ok(text.includes('la facture FA-2026-0007 du 01/09/2026'))
    assert.ok(text.includes(formatCents(108_000)))
    assert.ok(text.includes('IBAN FR76 3000 6000 0112 3456 7890 189 (BIC AGRIFRPP)'))
    assert.ok(text.includes('en indiquant la référence FA-2026-0007'))
    assert.ok(text.includes('Le 15/10/2026'))
  })

  it('reprend les pénalités et l’indemnité forfaitaire de 40 €', () => {
    const { text } = reminderMessage(facts)
    assert.ok(text.includes('Pénalités de retard : taux BCE majoré de 10 points.'))
    assert.ok(text.includes(`recouvrement de ${formatCents(4_000)}`))
    assert.ok(text.includes('D. 441-5'))
  })

  it('durcit le ton avec le palier', () => {
    const second = reminderMessage({ ...facts, level: 2 })
    assert.equal(second.subject, 'Seconde relance — facture FA-2026-0007 impayée')
    assert.ok(second.text.includes('14 jours après son échéance'))
    const notice = reminderMessage({ ...facts, level: 3 })
    assert.equal(notice.subject, 'Mise en demeure de payer — facture FA-2026-0007')
    assert.ok(notice.text.includes('mettons en demeure'))
    assert.ok(notice.text.includes('sous huit jours'))
  })

  it('dit qu’un prélèvement n’a pas abouti, et se passe d’IBAN s’il manque', () => {
    const debit = reminderMessage({ ...facts, expectedPaymentMethod: 'direct_debit' })
    assert.ok(debit.text.includes('Le prélèvement de cette facture n’a pas abouti'))
    assert.ok(debit.text.includes('par virement sur le compte IBAN'))
    const withoutIban = reminderMessage({ ...facts, bankIban: null, bankBic: null })
    assert.ok(!withoutIban.text.includes('IBAN'))
    assert.ok(withoutIban.text.includes('Merci de nous adresser votre règlement, en indiquant la référence FA-2026-0007.'))
  })

  it('groupe un IBAN par quatre', () => {
    assert.equal(formatIbanGroups('FR7630006000011234567890189'), 'FR76 3000 6000 0112 3456 7890 189')
  })
})
