import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { readDolibarrProductEvent } from '../facturation/produits-dolibarr.ts'
import { rateUnits } from '../facturation/schema.ts'
import {
  resourceTariffPattern,
  resourceTariffRef,
  showsMediaOnResource,
  tariffLines,
  tariffRefProblem,
  typeTariffRef,
} from './fiche-ressource.ts'
import { resourceTypes } from './schema.ts'

/** Ce que Dolibarr enverrait pour un produit de cette référence (ADR 049). */
const envoi = (ref: string) =>
  readDolibarrProductEvent({ triggercode: 'PRODUCT_MODIFY', object: { ref, type: '1', price: '90.00000000' } })

const SALLE = { id: '01a00000-0000-7000-8000-0000000000a1', resourceType: 'salle' as const, code: 'SAL-MB' }
const AUTRE = '01a00000-0000-7000-8000-0000000000a2'

describe('référence Dolibarr d’une ressource (ADR 049, ADR 082)', () => {
  it('se déduit du type, du code en minuscules et de l’unité', () => {
    assert.equal(resourceTariffRef('salle', 'SAL-MB', 'day'), 'tarif.salle.sal-mb.journee')
    assert.equal(resourceTariffRef('bureau', ' B-201 ', 'half_day'), 'tarif.bureau.b-201.demi-journee')
    assert.equal(typeTariffRef('vehicule', 'week'), 'tarif.vehicule.semaine')
    assert.equal(resourceTariffPattern('materiel', 'TV-55'), 'tarif.materiel.tv-55.<unité>')
  })

  it('est celle que la route des produits relit, pour chaque type et chaque unité', () => {
    for (const type of resourceTypes) {
      for (const unit of rateUnits) {
        // Dolibarr garde la casse saisie : la route la remet en minuscules.
        const decision = envoi(resourceTariffRef(type, 'Code-1', unit).toUpperCase())
        assert.equal(decision.kind, 'tarif', `${type} ${unit}`)
        if (decision.kind !== 'tarif') continue
        assert.deepEqual([decision.resourceType, decision.resourceCode, decision.unit], [type, 'code-1', unit])

        const shared = envoi(typeTariffRef(type, unit))
        assert.equal(shared.kind === 'tarif' && shared.resourceCode, null)
      }
    }
  })

  it('signale un code inutilisable : un point casse la référence', () => {
    assert.equal(tariffRefProblem('SAL-MB'), undefined)
    assert.match(tariffRefProblem('S.101') ?? '', /contient un point/)
    // Et la route la refuserait bien.
    assert.equal(envoi(resourceTariffRef('salle', 'S.101', 'day')).kind, 'invalid')
  })
})

describe('prix d’une ressource sur sa fiche', () => {
  it('donne le prix propre, sinon celui du type, unité par unité, de l’heure au mois', () => {
    const lines = tariffLines(SALLE, [
      { resourceType: 'salle', resourceId: null, unit: 'day', amountCents: 13000 },
      { resourceType: 'salle', resourceId: SALLE.id, unit: 'day', amountCents: 15000 },
      { resourceType: 'salle', resourceId: null, unit: 'half_day', amountCents: 9000 },
      { resourceType: 'salle', resourceId: SALLE.id, unit: 'hour', amountCents: 3500 },
      // Le prix propre d'une autre salle, et un autre type : ignorés.
      { resourceType: 'salle', resourceId: AUTRE, unit: 'week', amountCents: 50000 },
      { resourceType: 'bureau', resourceId: null, unit: 'month', amountCents: 40000 },
    ])
    assert.deepEqual(lines, [
      { unit: 'hour', resourceRef: 'tarif.salle.sal-mb.heure', typeRef: 'tarif.salle.heure', resourceCents: 3500, typeCents: null },
      {
        unit: 'half_day',
        resourceRef: 'tarif.salle.sal-mb.demi-journee',
        typeRef: 'tarif.salle.demi-journee',
        resourceCents: null,
        typeCents: 9000,
      },
      { unit: 'day', resourceRef: 'tarif.salle.sal-mb.journee', typeRef: 'tarif.salle.journee', resourceCents: 15000, typeCents: 13000 },
    ])
  })

  it('ne dit rien qu’il n’a pas : aucune ligne sans prix', () => {
    assert.deepEqual(tariffLines(SALLE, []), [])
  })
})

describe('photos et vidéos sur la fiche', () => {
  it('pour les salles, bureaux, camion et matériel vivants', () => {
    for (const type of ['salle', 'bureau', 'vehicule', 'materiel'] as const) {
      assert.equal(showsMediaOnResource(type, false, false), true, type)
    }
    assert.equal(showsMediaOnResource('casier', false, false), false)
    assert.equal(showsMediaOnResource('boite_aux_lettres', false, false), false)
  })

  it('aussi pour une ressource qui a déjà une annonce, jamais pour une archivée', () => {
    assert.equal(showsMediaOnResource('casier', true, false), true)
    assert.equal(showsMediaOnResource('salle', true, true), false)
  })
})
