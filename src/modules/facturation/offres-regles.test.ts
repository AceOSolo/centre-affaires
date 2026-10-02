import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  offerItemToValues,
  offerItemValues,
  readOfferHeaderForm,
  validateOfferItem,
  type OfferItemContext,
} from './offres-regles.ts'

/** Saisie d'une offre groupée et de ses lignes (R09, ADR 024). */
function form(values: Record<string, string>) {
  const data = new FormData()
  for (const [key, value] of Object.entries(values)) data.set(key, value)
  return data
}

const context: OfferItemContext = {
  resourceTypes: ['salle', 'bureau', 'casier', 'vehicule', 'boite_aux_lettres'],
  resources: [
    { id: 'bur-03', resourceType: 'bureau', archived: false },
    { id: 'bur-09', resourceType: 'bureau', archived: true },
  ],
  services: [
    { id: 'svc-standard', nature: 'package', unit: 'month', isActive: true, archived: false },
    { id: 'svc-pli', nature: 'act', unit: 'unit', isActive: true, archived: false },
    { id: 'svc-ancien', nature: 'package', unit: 'month', isActive: false, archived: false },
  ],
}

const valider = (values: Record<string, string>) =>
  validateOfferItem(offerItemValues(form({ quantity: '1', unit: 'month', pricing: 'catalogue', ...values })), context)

describe('en-tête d’une offre', () => {
  it('lit le nom, la période et l’engagement proposé', () => {
    const read = readOfferHeaderForm(
      form({ name: ' Domiciliation  Premium ', billingPeriod: 'quarterly', commitmentMonths: '12' }),
    )
    assert.equal(read.fieldErrors, undefined)
    assert.deepEqual(read.input, {
      name: 'Domiciliation Premium',
      description: null,
      billingPeriod: 'quarterly',
      commitmentMonths: 12,
      clientVisible: false,
    })
  })

  it('présente l’offre dans l’espace client quand la case est cochée (R23, ADR 036)', () => {
    const cochee = readOfferHeaderForm(form({ name: 'Pack', billingPeriod: 'monthly', clientVisible: 'on' }))
    assert.equal(cochee.fieldErrors, undefined)
    assert.equal(cochee.input.clientVisible, true)
    const vide = readOfferHeaderForm(form({ name: 'Pack', billingPeriod: 'monthly' }))
    assert.equal(vide.fieldErrors, undefined)
    assert.equal(vide.input.clientVisible, false)
  })

  it('accepte une offre sans engagement, refuse un engagement hors de 1 à 120 mois', () => {
    const sans = readOfferHeaderForm(form({ name: 'Pack', billingPeriod: 'monthly', commitmentMonths: '' }))
    assert.equal(sans.fieldErrors, undefined)
    assert.equal(sans.input?.commitmentMonths, null)
    for (const months of ['0', '121', '6,5']) {
      assert.ok(
        readOfferHeaderForm(form({ name: 'Pack', billingPeriod: 'monthly', commitmentMonths: months }))
          .fieldErrors?.commitmentMonths,
        months,
      )
    }
    assert.ok(readOfferHeaderForm(form({ name: '', billingPeriod: 'weekly' })).fieldErrors?.billingPeriod)
  })
})

describe('ligne d’une offre', () => {
  it('vise un type de ressource, au prix du catalogue', () => {
    assert.deepEqual(valider({ target: 'resource_type', resourceType: 'boite_aux_lettres' }).input, {
      resourceType: 'boite_aux_lettres',
      resourceId: null,
      serviceId: null,
      quantity: 1,
      unit: 'month',
      priceCents: null,
      discountBp: null,
      discountAmountCents: null,
      vatRateBp: null,
      label: null,
    })
  })

  it('vise une ressource vivante, avec un prix forfaitaire', () => {
    const { input } = valider({ target: 'resource', resourceId: 'bur-03', quantity: '3', pricing: 'price', price: '550' })
    assert.equal(input?.resourceId, 'bur-03')
    assert.equal(input?.resourceType, null)
    assert.equal(input?.quantity, 3)
    assert.equal(input?.priceCents, 55_000)
    assert.ok(valider({ target: 'resource', resourceId: 'bur-09' }).errors.resourceId)
  })

  it('prend l’unité du service, quoi que dise le formulaire', () => {
    const { input } = valider({ target: 'service', serviceId: 'svc-pli', unit: 'month', quantity: '10' })
    assert.equal(input?.serviceId, 'svc-pli')
    assert.equal(input?.unit, 'unit')
    assert.equal(input?.quantity, 10)
  })

  it('n’écrit qu’une façon de fixer le prix, celle choisie', () => {
    const { input } = valider({
      target: 'service',
      serviceId: 'svc-standard',
      pricing: 'discount_bp',
      price: '40',
      discountPercent: '12,5',
      discountAmount: '10',
    })
    assert.equal(input?.priceCents, null)
    assert.equal(input?.discountBp, 1_250)
    assert.equal(input?.discountAmountCents, null)
  })

  it('refuse une remise en montant sur un acte, et un service qui n’est plus proposé', () => {
    assert.ok(
      valider({ target: 'service', serviceId: 'svc-pli', pricing: 'discount_amount', discountAmount: '1' }).errors
        .discountAmount,
    )
    assert.ok(valider({ target: 'service', serviceId: 'svc-ancien' }).errors.serviceId)
  })

  it('rend toutes les erreurs d’un coup', () => {
    const { input, errors } = valider({
      target: 'resource_type',
      resourceType: 'chateau',
      unit: 'siecle',
      quantity: '0',
      pricing: 'discount_bp',
      discountPercent: '0',
      vatRate: 'beaucoup',
    })
    assert.equal(input, undefined)
    assert.deepEqual(Object.keys(errors).sort(), [
      'discountPercent',
      'quantity',
      'resourceType',
      'unit',
      'vatRate',
    ])
  })

  it('remplit le formulaire d’une ligne enregistrée, à l’inverse exact de la lecture', () => {
    const enregistree = {
      resourceType: null,
      resourceId: null,
      serviceId: 'svc-standard',
      quantity: 2,
      unit: 'month' as const,
      priceCents: null,
      discountBp: null,
      discountAmountCents: 1_050,
      vatRateBp: 550,
      label: 'Standard téléphonique partagé',
    }
    const values = offerItemToValues(enregistree)
    assert.equal(values.target, 'service')
    assert.equal(values.pricing, 'discount_amount')
    assert.equal(values.discountAmount, '10,50')
    assert.deepEqual(validateOfferItem(values, context).input, enregistree)
  })

  it('lit la désignation commerciale montrée au client (ADR 036)', () => {
    assert.equal(
      valider({ target: 'resource_type', resourceType: 'bureau', label: '  Bureau fermé   de 12 m² ' }).input?.label,
      'Bureau fermé de 12 m²',
    )
    assert.equal(valider({ target: 'resource_type', resourceType: 'bureau', label: '' }).input?.label, null)
    assert.ok(valider({ target: 'resource_type', resourceType: 'bureau', label: 'x'.repeat(121) }).errors.label)
  })
})
