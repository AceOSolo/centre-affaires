import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { expectedServices, missingExpectedServices } from './services-attendus.ts'
import { readServiceForm } from './services-regles.ts'

/** Saisie d'un service du catalogue (R18, ADR 024). */
function form(values: Record<string, string>) {
  const data = new FormData()
  for (const [key, value] of Object.entries(values)) data.set(key, value)
  return data
}

const forfait = (values: Record<string, string> = {}) =>
  form({
    name: '  Standard   téléphonique ',
    nature: 'package',
    unit: 'month',
    unitPrice: '50,00',
    vatRate: '20',
    isActive: 'on',
    ...values,
  })

describe('saisie d’un service', () => {
  it('lit un forfait, prix en centimes et TVA en points de base', () => {
    const read = readServiceForm(forfait({ code: 'Standard', description: 'Accueil des appels' }))
    assert.equal(read.fieldErrors, undefined)
    assert.deepEqual(read.input, {
      code: 'standard',
      name: 'Standard téléphonique',
      description: 'Accueil des appels',
      nature: 'package',
      unit: 'month',
      unitPriceCents: 5_000,
      vatRateBp: 2_000,
      isActive: true,
    })
  })

  it('facture toujours un acte à l’unité', () => {
    const read = readServiceForm(forfait({ nature: 'act', unit: 'month' }))
    assert.equal(read.fieldErrors, undefined)
    assert.equal(read.input?.unit, 'unit')
  })

  it('refuse un code hors du format stable', () => {
    for (const code of ['courrier ouverture', 'courrier..ouverture', '.courrier', 'é-courrier']) {
      assert.ok(readServiceForm(forfait({ code })).fieldErrors?.code, code)
    }
    assert.equal(readServiceForm(forfait({ code: 'courrier.ouverture' })).fieldErrors, undefined)
  })

  it('rend toutes les erreurs d’un coup', () => {
    const read = readServiceForm(form({ name: '', nature: 'abonnement', unit: 'siecle', unitPrice: 'gratuit', vatRate: '150' }))
    assert.deepEqual(Object.keys(read.fieldErrors ?? {}).sort(), [
      'name',
      'nature',
      'unit',
      'unitPrice',
      'vatRate',
    ])
  })

  it('garde la nature et le code posé d’un service existant', () => {
    const read = readServiceForm(forfait({ code: 'autre', nature: 'act' }), {
      code: 'courrier.ouverture',
      nature: 'package',
    })
    assert.equal(read.fieldErrors, undefined)
    assert.equal(read.input?.code, 'courrier.ouverture')
    assert.equal(read.input?.nature, 'package')
    // Un service sans code peut en recevoir un.
    const sansCode = readServiceForm(forfait({ code: 'standard' }), { code: null, nature: 'package' })
    assert.equal(sansCode.fieldErrors, undefined)
    assert.equal(sansCode.input?.code, 'standard')
  })

  it('se décoche : un service peut ne plus être proposé', () => {
    const data = forfait()
    data.delete('isActive')
    const read = readServiceForm(data)
    assert.equal(read.fieldErrors, undefined)
    assert.equal(read.input?.isActive, false)
  })
})

describe('services attendus par l’application', () => {
  it('attend l’ouverture d’un pli, acte à l’unité, sans prix inventé', () => {
    const [ouverture] = expectedServices
    assert.equal(ouverture.code, 'courrier.ouverture')
    assert.equal(ouverture.nature, 'act')
    assert.equal(ouverture.unit, 'unit')
    assert.equal('unitPriceCents' in ouverture, false)
  })

  it('attend aussi la numérisation seule et la réexpédition demandées (ADR 037), sans prix inventé', () => {
    const codes = expectedServices.map((service) => service.code)
    assert.deepEqual(codes, ['courrier.ouverture', 'courrier.numerisation', 'courrier.reexpedition'])
    for (const service of expectedServices) {
      assert.equal(service.nature, 'act')
      assert.equal(service.unit, 'unit')
      assert.equal('unitPriceCents' in service, false)
    }
  })

  it('signale ceux qui manquent parmi les services vivants', () => {
    assert.deepEqual(
      missingExpectedServices(['standard', null]).map((service) => service.code),
      ['courrier.ouverture', 'courrier.numerisation', 'courrier.reexpedition'],
    )
    assert.deepEqual(
      missingExpectedServices(['courrier.ouverture']).map((service) => service.code),
      ['courrier.numerisation', 'courrier.reexpedition'],
    )
    assert.deepEqual(
      missingExpectedServices(['courrier.ouverture', 'courrier.numerisation', 'courrier.reexpedition']),
      [],
    )
  })
})
