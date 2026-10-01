import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseAmountToCents } from '../facturation/tarifs.ts'
import { centsToAmountInput, isCalendarDate, readContractForm, type ContractField } from './formulaire.ts'

/**
 * Formulaire de contrat (R12) : la création et la modification d'un brouillon
 * appliquent les mêmes règles ; seule la référence diffère, facultative à la
 * création (la base numérote, ADR 021) et obligatoire ensuite.
 */
const CLIENT = '01a00000-0000-7000-8000-0000000000c1'
const BUREAU = '01a00000-0000-7000-8000-0000000000b1'

const saisie = (overrides: Partial<Record<ContractField, string>> = {}) => {
  const values: Record<ContractField, string> = {
    clientId: CLIENT,
    reference: '',
    contractType: 'bureau',
    resourceId: BUREAU,
    startsOn: '2026-03-01',
    endsOn: '2026-06-30',
    billingPeriod: 'monthly',
    amount: '900,00',
    noticeDays: '',
    ratePlanId: '',
    notes: '',
    vatRate: '',
    commitmentMonths: '',
    tacitRenewal: '',
    renewalMonths: '',
    ...overrides,
  }
  return (key: ContractField) => values[key]
}

describe('création', () => {
  it('laisse la base numéroter quand la référence est vide', () => {
    const result = readContractForm(saisie(), 'create')
    assert.ok(result.ok)
    assert.equal(result.input.reference, undefined)
  })

  it('garde une référence saisie, sans les espaces autour', () => {
    const result = readContractForm(saisie({ reference: '  DOM-2024-12 ' }), 'create')
    assert.ok(result.ok)
    assert.equal(result.input.reference, 'DOM-2024-12')
  })

  it('convertit le montant en centimes et pose les valeurs par défaut', () => {
    const result = readContractForm(saisie({ amount: '1 250,50' }), 'create')
    assert.ok(result.ok)
    assert.equal(result.input.amountCents, 125_050)
    assert.equal(result.input.noticeDays, 90)
    assert.equal(result.input.ratePlanId, null)
    assert.equal(result.input.notes, null)
  })

  it('accepte un contrat sans terme ni ressource', () => {
    const result = readContractForm(saisie({ endsOn: '', resourceId: '' }), 'create')
    assert.ok(result.ok)
    assert.equal(result.input.endsOn, null)
    assert.equal(result.input.resourceId, null)
  })
})

describe('modification d’un brouillon', () => {
  it('exige la référence', () => {
    const result = readContractForm(saisie(), 'update')
    assert.ok(!result.ok)
    assert.ok(result.fieldErrors.reference)
  })

  it('applique les mêmes règles que la création', () => {
    const create = readContractForm(saisie({ endsOn: '2026-01-01' }), 'create')
    const update = readContractForm(saisie({ endsOn: '2026-01-01', reference: 'CT-2026-0001' }), 'update')
    assert.ok(!create.ok && !update.ok)
    assert.deepEqual(create.fieldErrors, update.fieldErrors)
  })
})

describe('erreurs rattachées à leur champ', () => {
  const erreurs = (overrides: Partial<Record<ContractField, string>>) => {
    const result = readContractForm(saisie(overrides), 'create')
    assert.ok(!result.ok, 'la saisie aurait dû être refusée')
    return result.fieldErrors
  }

  it('exige un client', () => {
    assert.ok(erreurs({ clientId: '' }).clientId)
  })

  it('refuse un type inconnu', () => {
    assert.ok(erreurs({ contractType: 'location' }).contractType)
  })

  it('refuse une date qui n’existe pas, avant la base', () => {
    assert.ok(erreurs({ startsOn: '2026-02-30' }).startsOn)
  })

  it('refuse une fin antérieure au début', () => {
    const errors = erreurs({ endsOn: '2026-02-28' })
    assert.ok(errors.endsOn)
    assert.equal(errors.startsOn, undefined)
  })

  it('accepte une fin égale au début', () => {
    assert.ok(readContractForm(saisie({ endsOn: '2026-03-01' }), 'create').ok)
  })

  it('refuse un montant illisible', () => {
    assert.ok(erreurs({ amount: '9OO' }).amount)
  })

  it('refuse un montant que la colonne ne peut pas tenir', () => {
    assert.ok(erreurs({ amount: '30000000,00' }).amount)
  })

  it('refuse un préavis négatif ou décimal', () => {
    assert.ok(erreurs({ noticeDays: '-1' }).noticeDays)
    assert.ok(erreurs({ noticeDays: '1.5' }).noticeDays)
  })

  it('refuse une ressource mal formée', () => {
    assert.ok(erreurs({ resourceId: 'bureau-1' }).resourceId)
  })

  it('rend toutes les erreurs à la fois, et la saisie', () => {
    const result = readContractForm(saisie({ clientId: '', amount: '' }), 'create')
    assert.ok(!result.ok)
    assert.deepEqual(Object.keys(result.fieldErrors).sort(), ['amount', 'clientId'])
    assert.equal(result.values.startsOn, '2026-03-01')
  })
})

describe('engagement, reconduction et TVA (R10, ADR 023)', () => {
  it('pose 20 % de TVA et aucun engagement par défaut', () => {
    const result = readContractForm(saisie(), 'create')
    assert.ok(result.ok)
    assert.equal(result.input.vatRateBp, 2000)
    assert.equal(result.input.commitmentMonths, null)
    assert.equal(result.input.tacitRenewal, false)
    assert.equal(result.input.renewalMonths, null)
  })

  it('lit un engagement, une reconduction et un taux réduit', () => {
    const result = readContractForm(
      saisie({ vatRate: '5,5', commitmentMonths: '12', tacitRenewal: 'on', renewalMonths: '12' }),
      'create',
    )
    assert.ok(result.ok)
    assert.equal(result.input.vatRateBp, 550)
    assert.equal(result.input.commitmentMonths, 12)
    assert.equal(result.input.tacitRenewal, true)
    assert.equal(result.input.renewalMonths, 12)
  })

  it('ignore la durée de reconduction sans reconduction', () => {
    const result = readContractForm(saisie({ renewalMonths: '12' }), 'create')
    assert.ok(result.ok)
    assert.equal(result.input.renewalMonths, null)
  })

  it('refuse un engagement hors de 1 à 120 mois, une reconduction sans durée, un taux illisible', () => {
    const result = readContractForm(
      saisie({ commitmentMonths: '0', tacitRenewal: 'on', renewalMonths: '', vatRate: '120' }),
      'create',
    )
    assert.ok(!result.ok)
    assert.deepEqual(Object.keys(result.fieldErrors).sort(), [
      'commitmentMonths',
      'renewalMonths',
      'vatRate',
    ])
  })
})

describe('outils', () => {
  it('reconnaît une date de calendrier', () => {
    assert.equal(isCalendarDate('2028-02-29'), true)
    assert.equal(isCalendarDate('2026-02-29'), false)
    assert.equal(isCalendarDate('2026-3-1'), false)
  })

  it('rend un montant au format de saisie, inverse exact de la lecture', () => {
    for (const cents of [0, 5, 90_000, 125_050, 1_999]) {
      assert.equal(parseAmountToCents(centsToAmountInput(cents)), cents)
    }
    assert.equal(centsToAmountInput(90_000), '900,00')
  })
})
