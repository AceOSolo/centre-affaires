import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { contractRange } from '../contrats/occupation.ts'
import { bookingDisplayTitle, describeBusyBooking, occupationReference } from './occupation.ts'

/**
 * Affichage d'une occupation de contrat (ADR 018) : « Occupé — contrat X »,
 * par jours entiers, « sans terme » plutôt que le 31/12/9999.
 */
const PARIS = 'Europe/Paris'

const occupation = (endsOn: string | null) => ({
  kind: 'contract' as const,
  title: 'Contrat CT-2026-0007',
  ...contractRange({ startsOn: '2026-03-01', endsOn, terminatedOn: null }, PARIS),
})

describe('titre affiché', () => {
  it('lit la référence dans le titre tenu par la base', () => {
    assert.equal(occupationReference({ title: 'Contrat CT-2026-0007' }), 'CT-2026-0007')
  })

  it('garde une référence saisie à la main', () => {
    assert.equal(occupationReference({ title: 'Contrat DOM 2024/12' }), 'DOM 2024/12')
  })

  it('dit « Occupé — contrat X » pour une occupation', () => {
    assert.equal(bookingDisplayTitle(occupation('2026-06-30')), 'Occupé — contrat CT-2026-0007')
  })

  it('garde le titre d’une réservation', () => {
    assert.equal(bookingDisplayTitle({ kind: 'booking', title: 'Contrat à signer' }), 'Contrat à signer')
  })
})

describe('description de ce qui occupe un créneau', () => {
  it('donne la période d’une occupation, pas des heures', () => {
    assert.equal(
      describeBusyBooking(occupation('2026-06-30'), PARIS),
      'Occupé — contrat CT-2026-0007 (du 01/03/2026 au 30/06/2026)',
    )
  })

  it('dit « sans terme » pour un contrat à durée indéterminée', () => {
    assert.equal(
      describeBusyBooking(occupation(null), PARIS),
      'Occupé — contrat CT-2026-0007 (à partir du 01/03/2026, sans terme)',
    )
  })

  it('donne le jour et les heures d’une réservation, dans le fuseau du centre', () => {
    assert.equal(
      describeBusyBooking(
        {
          kind: 'booking',
          title: 'Réunion',
          startsAt: new Date('2026-03-12T08:00:00Z'),
          endsAt: new Date('2026-03-12T09:00:00Z'),
        },
        PARIS,
      ),
      '« Réunion » le 12/03/2026 de 09:00 à 10:00',
    )
  })

  it('donne les deux jours d’une réservation à cheval', () => {
    assert.equal(
      describeBusyBooking(
        {
          kind: 'unavailability',
          title: 'Travaux',
          startsAt: new Date('2026-03-12T08:00:00Z'),
          endsAt: new Date('2026-03-13T16:00:00Z'),
        },
        PARIS,
      ),
      '« Travaux » du 12/03/2026 09:00 au 13/03/2026 17:00',
    )
  })

  it('laisse sur sa journée une réservation qui finit à minuit', () => {
    assert.equal(
      describeBusyBooking(
        {
          kind: 'booking',
          title: 'Soirée',
          startsAt: new Date('2026-03-12T19:00:00Z'),
          endsAt: new Date('2026-03-12T23:00:00Z'),
        },
        PARIS,
      ),
      '« Soirée » le 12/03/2026 de 20:00 à 00:00',
    )
  })
})
