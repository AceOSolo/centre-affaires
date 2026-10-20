import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  dolibarrPriceToCents,
  dolibarrTextToPlain,
  dolibarrVatToBasisPoints,
  readDolibarrProductEvent,
} from './produits-dolibarr.ts'

/** Produits reçus du module Webhook de Dolibarr (ADR 049). */
const envoi = (object: Record<string, unknown>, triggercode = 'PRODUCT_MODIFY') => ({ triggercode, object })

// Tel que Dolibarr sérialise un service : nombres en chaînes, 8 décimales.
const ouverture = {
  id: '12',
  ref: 'courrier.ouverture',
  label: 'Ouverture et numérisation',
  description: '<p>Ouverture du pli&nbsp;et numérisation.</p>',
  type: '1',
  price: '3.50000000',
  price_ttc: '4.20000000',
  tva_tx: '20.000',
  status: '1',
  duration_value: '',
  duration_unit: '',
}

describe('prix et TVA de Dolibarr', () => {
  it('lit le prix en centimes sans calcul flottant', () => {
    assert.equal(dolibarrPriceToCents('3.50000000'), 350)
    assert.equal(dolibarrPriceToCents('90'), 9_000)
    assert.equal(dolibarrPriceToCents(12.5), 1_250)
    assert.equal(dolibarrPriceToCents('19.99'), 1_999)
    assert.equal(dolibarrPriceToCents('0'), 0)
  })

  it('arrondit au centime le plus proche au-delà de deux décimales', () => {
    assert.equal(dolibarrPriceToCents('0.12500000'), 13)
    assert.equal(dolibarrPriceToCents('0.12499999'), 12)
  })

  it('refuse un prix négatif ou illisible', () => {
    assert.equal(dolibarrPriceToCents('-1'), undefined)
    assert.equal(dolibarrPriceToCents('abc'), undefined)
    assert.equal(dolibarrPriceToCents(''), undefined)
    assert.equal(dolibarrPriceToCents(null), undefined)
  })

  it('lit la TVA en points de base, zéros de queue compris', () => {
    assert.equal(dolibarrVatToBasisPoints('20.000'), 2_000)
    assert.equal(dolibarrVatToBasisPoints('5.500'), 550)
    assert.equal(dolibarrVatToBasisPoints('0'), 0)
    assert.equal(dolibarrVatToBasisPoints('2.125'), undefined)
    assert.equal(dolibarrVatToBasisPoints('120'), undefined)
  })

  it('met la description HTML en texte simple', () => {
    assert.equal(dolibarrTextToPlain('<p>Un&nbsp;pli &amp; sa copie</p><p>Deux</p>'), 'Un pli & sa copie\nDeux')
    assert.equal(dolibarrTextToPlain('Ligne<br />suivante'), 'Ligne\nsuivante')
    assert.equal(dolibarrTextToPlain(null), '')
  })
})

describe('service du catalogue', () => {
  it('reprend un service attendu avec sa nature et son unité', () => {
    const decision = readDolibarrProductEvent(envoi(ouverture))
    assert.deepEqual(decision, {
      kind: 'service',
      code: 'courrier.ouverture',
      previousCode: null,
      removed: false,
      name: 'Ouverture et numérisation',
      description: 'Ouverture du pli et numérisation.',
      nature: 'act',
      unit: 'unit',
      unitPriceCents: 350,
      vatRateBp: 2_000,
      isActive: true,
    })
  })

  it('met la référence en minuscules pour en faire le code', () => {
    const decision = readDolibarrProductEvent(envoi({ ...ouverture, ref: 'COURRIER.OUVERTURE' }))
    assert.equal(decision.kind === 'service' && decision.code, 'courrier.ouverture')
  })

  it('fait d’un service à durée mensuelle un forfait au mois', () => {
    const decision = readDolibarrProductEvent(
      envoi({ ...ouverture, ref: 'DOM-PREMIUM', label: 'Domiciliation Premium', duration_value: '1', duration_unit: 'm' }),
    )
    assert.equal(decision.kind, 'service')
    if (decision.kind !== 'service') return
    assert.equal(decision.nature, 'package')
    assert.equal(decision.unit, 'month')
  })

  it('fait d’un autre service un acte à l’unité', () => {
    const decision = readDolibarrProductEvent(envoi({ ...ouverture, ref: 'photocopie', label: 'Photocopie' }))
    assert.equal(decision.kind === 'service' && `${decision.nature}/${decision.unit}`, 'act/unit')
  })

  it('suit un renommage de la référence', () => {
    const decision = readDolibarrProductEvent(envoi({ ...ouverture, ref: 'courrier.ouverture', oldcopy: { ref: 'OUVERTURE' } }))
    assert.equal(decision.kind === 'service' && decision.previousCode, 'ouverture')
  })

  it('marque inactif un service hors vente', () => {
    const decision = readDolibarrProductEvent(envoi({ ...ouverture, status: '0' }))
    assert.equal(decision.kind === 'service' && decision.isActive, false)
  })

  it('archive le service à la suppression du produit', () => {
    const decision = readDolibarrProductEvent(envoi(ouverture, 'PRODUCT_DELETE'))
    assert.equal(decision.kind === 'service' && decision.removed, true)
  })

  it('refuse une référence qui ne peut pas être un code', () => {
    const decision = readDolibarrProductEvent(envoi({ ...ouverture, ref: 'Domiciliation été' }))
    assert.equal(decision.kind, 'invalid')
  })

  it('refuse un prix ou une TVA illisible', () => {
    assert.equal(readDolibarrProductEvent(envoi({ ...ouverture, price: '' })).kind, 'invalid')
    assert.equal(readDolibarrProductEvent(envoi({ ...ouverture, tva_tx: 'x' })).kind, 'invalid')
  })

  it('ignore un produit physique et les autres déclencheurs', () => {
    assert.equal(readDolibarrProductEvent(envoi({ ...ouverture, ref: 'ramette', type: '0' })).kind, 'ignore')
    assert.equal(readDolibarrProductEvent(envoi(ouverture, 'COMPANY_MODIFY')).kind, 'ignore')
  })

  it('refuse un envoi qui n’a pas la forme du module Webhook', () => {
    assert.equal(readDolibarrProductEvent(null).kind, 'invalid')
    assert.equal(readDolibarrProductEvent({ ref: 'courrier.ouverture' }).kind, 'invalid')
  })
})

describe('prix de la grille', () => {
  const tarif = (ref: string, price = '90.00000000', extra: Record<string, unknown> = {}) =>
    readDolibarrProductEvent(envoi({ ref, price, type: '1', status: '1', ...extra }))

  it('lit un prix par type de ressource', () => {
    assert.deepEqual(tarif('TARIF.SALLE.DEMI-JOURNEE'), {
      kind: 'tarif',
      ref: 'tarif.salle.demi-journee',
      resourceType: 'salle',
      resourceCode: null,
      unit: 'half_day',
      removed: false,
      amountCents: 9_000,
    })
  })

  it('lit un prix pour une ressource précise', () => {
    const decision = tarif('tarif.salle.sal-mb.heure', '25')
    assert.equal(decision.kind, 'tarif')
    if (decision.kind !== 'tarif') return
    assert.equal(decision.resourceCode, 'sal-mb')
    assert.equal(decision.unit, 'hour')
    assert.equal(decision.amountCents, 2_500)
  })

  it('lit toutes les unités et tous les types', () => {
    const units = ['heure', 'demi-journee', 'journee', 'semaine', 'mois', 'unite'].map((word) => {
      const decision = tarif(`tarif.boite_aux_lettres.${word}`)
      return decision.kind === 'tarif' ? decision.unit : decision.kind
    })
    assert.deepEqual(units, ['hour', 'half_day', 'day', 'week', 'month', 'unit'])
  })

  it('retire le prix d’un produit supprimé ou hors vente', () => {
    const supprime = readDolibarrProductEvent(envoi({ ref: 'tarif.salle.journee', price: '130' }, 'PRODUCT_DELETE'))
    assert.equal(supprime.kind === 'tarif' && supprime.removed, true)
    const horsVente = tarif('tarif.salle.journee', '130', { status: '0' })
    assert.equal(horsVente.kind === 'tarif' && horsVente.removed, true)
  })

  it('refuse un type, une unité ou une forme inconnus', () => {
    assert.equal(tarif('tarif.parking.journee').kind, 'invalid')
    assert.equal(tarif('tarif.salle.quinzaine').kind, 'invalid')
    assert.equal(tarif('tarif.salle').kind, 'invalid')
    assert.equal(tarif('tarif.salle.a.b.journee').kind, 'invalid')
    assert.equal(tarif('tarif.salle.journee', 'gratuit').kind, 'invalid')
  })
})
