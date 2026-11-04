import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { QuoteDisplay } from '../facturation/devis.ts'
import { resourceTypes } from '../ressources/schema.ts'
import {
  MAX_OPTIONS_PER_BOOKING,
  acceptsEquipmentOptions,
  isEquipment,
  optionFromParent,
  optionRefusal,
  optionRefusalMessages,
  parseEquipmentIds,
  totalWithOptions,
} from './options.ts'

/**
 * Matériel en option d'une réservation de salle (ADR 062) : les règles pures.
 * Les règles de la base (`CA018`) et la cascade sont éprouvées contre MySQL
 * (`options.db.test.ts`).
 */
describe('matériel en option', () => {
  const salle = { kind: 'booking', status: 'confirmed', parentBookingId: null, resource: { resourceType: 'salle' as const } }

  it('ne se propose que sur une réservation de salle vivante, jamais sur une option', () => {
    assert.equal(optionRefusal(salle), undefined)
    assert.equal(optionRefusal({ ...salle, status: 'pending' }), undefined)
    assert.equal(optionRefusal({ ...salle, status: 'cancelled' }), 'annulee')
    assert.equal(optionRefusal({ ...salle, kind: 'contract' }), 'occupation')
    assert.equal(optionRefusal({ ...salle, parentBookingId: '01a00000-0000-7000-8000-000000000001' }), 'option')
    assert.equal(optionRefusal({ ...salle, resource: { resourceType: 'vehicule' } }), 'type')
    assert.equal(optionRefusal({ ...salle, resource: { resourceType: 'materiel' } }), 'type')
    for (const reason of ['type', 'annulee', 'option', 'occupation'] as const) {
      assert.ok(optionRefusalMessages[reason].length > 0)
    }
  })

  it('n’ouvre l’option qu’aux salles, et seul le matériel se loue en option', () => {
    assert.deepEqual(resourceTypes.filter(acceptsEquipmentOptions), ['salle'])
    assert.deepEqual(resourceTypes.filter(isEquipment), ['materiel'])
  })

  it('reprend la période, le client et l’objet de la salle', () => {
    const parent = {
      startsAt: new Date('2026-11-10T08:00:00Z'),
      endsAt: new Date('2026-11-12T17:00:00Z'),
      clientId: '01a00000-0000-7000-8000-0000000000c1',
      title: 'Séminaire ACME',
    }
    assert.deepEqual(optionFromParent(parent), parent)
  })

  it('lit les appareils cochés sans doublon, bornés', () => {
    const tv = '01A00000-0000-7000-8000-000000000a01'
    const clim = '01a00000-0000-7000-8000-000000000a02'
    assert.deepEqual(parseEquipmentIds([tv, clim, tv.toLowerCase(), 'pas-un-uuid', '', null]), [tv.toLowerCase(), clim])
    const many = Array.from({ length: 30 }, (_, index) => `01a00000-0000-7000-8000-${String(index).padStart(12, '0')}`)
    assert.equal(parseEquipmentIds(many).length, MAX_OPTIONS_PER_BOOKING)
  })

  it('additionne la salle et son matériel comme le devis, TVA par taux', () => {
    const line = (netCents: number, quantity = 1): QuoteDisplay => ({
      unit: 'day',
      quantity,
      unitPriceCents: netCents / quantity,
      discountBp: null,
      discountAmountCents: null,
      discountCents: 0,
      netCents,
      vatRateBp: 2_000,
      vatCents: netCents / 5,
      totalCents: (netCents * 6) / 5,
      currency: 'EUR',
    })
    // Salle à la journée (130 €) et télévision trois journées à 30 €.
    const total = totalWithOptions([line(13_000), line(9_000, 3), undefined])
    assert.equal(total.netCents, 22_000)
    assert.equal(total.vatCents, 4_400)
    assert.equal(total.totalCents, 26_400)
    assert.equal(total.currency, 'EUR')
    // Un appareil non chiffré ne compte pas, mais se dit.
    assert.equal(total.unpriced, 1)
    assert.equal(totalWithOptions([]).currency, null)
  })
})
