import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  addMonthsToIsoDate,
  checkCollectionDate,
  directDebitBlocker,
  generateMandateReference,
  generateRemittanceId,
  isMandateLapsed,
  isRemittanceId,
  readMandateForm,
  sepaSequenceFor,
} from './mandats-regles.ts'

/**
 * Mandats de prélèvement SEPA (R16, ADR 027, ADR 030) : RUM, saisie, caducité
 * à 36 mois, type de séquence d'un prélèvement.
 */
const form = (values: Record<string, string>) => {
  const data = new FormData()
  for (const [key, value] of Object.entries(values)) data.set(key, value)
  return data
}

const TODAY = '2026-10-01'

describe('référence unique de mandat (RUM)', () => {
  it('date le mandat et tire un suffixe lisible, dans le format SEPA', () => {
    const rum = generateMandateReference(TODAY, Uint8Array.from([0, 1, 31, 32, 255, 100]))
    assert.equal(rum, 'RUM-20261001-AB9A9E')
    assert.match(rum, /^[A-Za-z0-9+?/:().,' -]{1,35}$/)
    assert.equal(rum.length, 19)
  })

  it('n’emploie ni I, ni O, ni 0, ni 1 dans le suffixe', () => {
    for (let value = 0; value < 256; value++) {
      const suffix = generateMandateReference(TODAY, Uint8Array.from(Array(6).fill(value))).slice(-6)
      assert.doesNotMatch(suffix, /[IO01]/)
    }
  })

  it('refuse un tirage trop court', () => {
    assert.throws(() => generateMandateReference(TODAY, Uint8Array.from([1, 2])), RangeError)
  })
})

describe('saisie d’un mandat', () => {
  const valid = {
    debtorName: 'Atelier Durand',
    iban: 'fr76 3000 6000 0112 3456 7890 189',
    bic: 'agri frpp',
    signedOn: '2026-09-28',
    sequenceType: 'recurrent',
  }

  it('normalise l’IBAN et le BIC', () => {
    const read = readMandateForm(form(valid), { today: TODAY })
    assert.ok('input' in read)
    assert.deepEqual(read.input, {
      debtorName: 'Atelier Durand',
      iban: 'FR7630006000011234567890189',
      bic: 'AGRIFRPP',
      signedOn: '2026-09-28',
      sequenceType: 'recurrent',
    })
  })

  it('accepte un mandat sans BIC, ponctuel', () => {
    const read = readMandateForm(form({ ...valid, bic: '', sequenceType: 'one_off' }), { today: TODAY })
    assert.ok('input' in read)
    assert.equal(read.input.bic, null)
    assert.equal(read.input.sequenceType, 'one_off')
  })

  it('refuse un IBAN dont la clé est fausse, et ne le rend jamais au formulaire', () => {
    const read = readMandateForm(form({ ...valid, iban: 'FR7630006000011234567890188' }), { today: TODAY })
    assert.ok('fieldErrors' in read)
    assert.match(read.fieldErrors.iban ?? '', /clé de contrôle/)
    assert.equal(JSON.stringify(read.values).includes('3000'), false)
    assert.equal('iban' in read.values, false)
  })

  it('signale chaque champ fautif', () => {
    const read = readMandateForm(
      form({ debtorName: '', iban: '', bic: 'AGRI', signedOn: '2026-10-02', sequenceType: 'weekly' }),
      { today: TODAY },
    )
    assert.ok('fieldErrors' in read)
    assert.deepEqual(Object.keys(read.fieldErrors).sort(), ['bic', 'debtorName', 'iban', 'sequenceType', 'signedOn'])
  })
})

describe('caducité d’un mandat', () => {
  it('ajoute des mois en rabattant le jour sur la fin d’un mois plus court', () => {
    assert.equal(addMonthsToIsoDate('2023-10-01', 36), '2026-10-01')
    assert.equal(addMonthsToIsoDate('2024-01-31', 1), '2024-02-29')
    assert.equal(addMonthsToIsoDate('2023-02-28', 12), '2024-02-28')
  })

  it('compte 36 mois depuis le dernier prélèvement, ou depuis la signature', () => {
    assert.equal(isMandateLapsed({ signedOn: '2023-10-02', lastCollectedOn: null }, TODAY), false)
    assert.equal(isMandateLapsed({ signedOn: '2023-10-01', lastCollectedOn: null }, TODAY), true)
    assert.equal(isMandateLapsed({ signedOn: '2020-01-01', lastCollectedOn: '2024-06-05' }, TODAY), false)
    assert.equal(isMandateLapsed({ signedOn: '2020-01-01', lastCollectedOn: '2023-06-05' }, TODAY), true)
  })
})

describe('type de séquence d’un prélèvement', () => {
  it('FRST au premier prélèvement d’un mandat récurrent, RCUR ensuite, OOFF pour un ponctuel', () => {
    assert.equal(sepaSequenceFor('recurrent', false), 'FRST')
    assert.equal(sepaSequenceFor('recurrent', true), 'RCUR')
    assert.equal(sepaSequenceFor('one_off', false), 'OOFF')
  })
})

describe('remise de prélèvements', () => {
  it('nomme une remise dans le jeu SEPA, et la reconnaît', () => {
    const id = generateRemittanceId(TODAY, Uint8Array.from([0, 1, 2, 3, 4, 5]))
    assert.equal(id, 'PRLV-20261001-ABCDEF')
    assert.equal(isRemittanceId(id), true)
    assert.equal(isRemittanceId('PRLV-2026-ABCDEF'), false)
    assert.equal(isRemittanceId('../etc/passwd'), false)
  })

  const mandate = {
    status: 'active' as const,
    deleted: false,
    sequenceType: 'recurrent' as const,
    signedOn: '2026-01-15',
    lastCollectedOn: null,
    usedOnce: false,
  }

  it('laisse prélever une facture en euros sur un mandat actif', () => {
    assert.equal(directDebitBlocker({ currency: 'EUR', mandate }, TODAY), null)
  })

  it('dit pourquoi une facture ne se prélève pas', () => {
    assert.match(directDebitBlocker({ currency: 'EUR', mandate: null }, TODAY) ?? '', /Aucun mandat/)
    assert.match(directDebitBlocker({ currency: 'CHF', mandate }, TODAY) ?? '', /euros/)
    assert.match(
      directDebitBlocker({ currency: 'EUR', mandate: { ...mandate, status: 'revoked' } }, TODAY) ?? '',
      /révoqué/,
    )
    assert.match(
      directDebitBlocker({ currency: 'EUR', mandate: { ...mandate, signedOn: '2023-09-01' } }, TODAY) ?? '',
      /caduc/,
    )
    assert.match(
      directDebitBlocker(
        { currency: 'EUR', mandate: { ...mandate, sequenceType: 'one_off', usedOnce: true } },
        TODAY,
      ) ?? '',
      /ponctuel déjà utilisé/,
    )
  })

  it('demande une date de prélèvement après aujourd’hui, dans l’année', () => {
    assert.equal(checkCollectionDate('2026-10-02', TODAY), undefined)
    assert.match(checkCollectionDate(TODAY, TODAY) ?? '', /après aujourd’hui/)
    assert.match(checkCollectionDate('2027-10-02', TODAY) ?? '', /moins d’un an/)
    assert.match(checkCollectionDate('2026-02-30', TODAY) ?? '', /illisible/)
  })
})
