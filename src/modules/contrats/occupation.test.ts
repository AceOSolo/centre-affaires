import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { OPEN_ENDED_BOOKING_END } from '../reservations/schema.ts'
import {
  canChangeContractResource,
  contractOccupiesResource,
  contractRange,
  formatCalendarDate,
  formatContractDays,
  lastContractDay,
  occupationDays,
} from './occupation.ts'

/**
 * Occupation d'une ressource par son contrat (ADR 018), côté code. Les mêmes
 * bornes que `apply_contract_occupation` : l'écran annonce ce que la base
 * écrira, et nomme ce qui bloque quand elle refuse.
 */
const PARIS = 'Europe/Paris'

const contrat = (overrides: Partial<Parameters<typeof contractOccupiesResource>[0]> = {}) => ({
  startsOn: '2026-03-01',
  endsOn: '2026-06-30' as string | null,
  terminatedOn: null as string | null,
  status: 'active' as const,
  resourceId: 'bureau' as string | null,
  deletedAt: null as Date | null,
  ...overrides,
})

describe('dernier jour du contrat', () => {
  it('prend le terme prévu tant que le contrat n’est pas résilié', () => {
    assert.equal(lastContractDay(contrat()), '2026-06-30')
  })

  it('prend la résiliation quand elle précède le terme', () => {
    assert.equal(lastContractDay(contrat({ terminatedOn: '2026-04-15' })), '2026-04-15')
  })

  it('garde le terme quand la résiliation vient après', () => {
    assert.equal(lastContractDay(contrat({ terminatedOn: '2026-09-30' })), '2026-06-30')
  })

  it('prend la résiliation d’un contrat sans terme', () => {
    assert.equal(lastContractDay(contrat({ endsOn: null, terminatedOn: '2026-12-31' })), '2026-12-31')
  })

  it('n’en a pas pour un contrat sans terme non résilié', () => {
    assert.equal(lastContractDay(contrat({ endsOn: null })), null)
  })
})

describe('le contrat occupe-t-il sa ressource', () => {
  it('oui, en cours avec une ressource', () => {
    assert.equal(contractOccupiesResource(contrat()), true)
  })

  it('oui, résilié : la période passée reste occupée', () => {
    assert.equal(
      contractOccupiesResource(contrat({ status: 'terminated', terminatedOn: '2026-04-15' })),
      true,
    )
  })

  it('non, en brouillon : un brouillon n’engage rien', () => {
    assert.equal(contractOccupiesResource(contrat({ status: 'draft' })), false)
  })

  it('non, archivé', () => {
    assert.equal(contractOccupiesResource(contrat({ deletedAt: new Date() })), false)
  })

  it('non, sans ressource', () => {
    assert.equal(contractOccupiesResource(contrat({ resourceId: null })), false)
  })

  it('non, résilié avant son début', () => {
    assert.equal(
      contractOccupiesResource(contrat({ status: 'terminated', terminatedOn: '2026-02-28' })),
      false,
    )
  })

  it('oui, résilié le jour même de son début : un jour occupé', () => {
    assert.equal(
      contractOccupiesResource(contrat({ status: 'terminated', terminatedOn: '2026-03-01' })),
      true,
    )
  })
})

describe('changement de ressource d’un contrat en cours', () => {
  // Contrat du 1er mars au 30 juin 2026.
  it('possible tant que le contrat n’a pas commencé', () => {
    assert.equal(canChangeContractResource(contrat(), '2026-02-28'), true)
  })

  it('refusé le jour même du début : l’occupation a commencé', () => {
    assert.equal(canChangeContractResource(contrat(), '2026-03-01'), false)
  })

  it('refusé en cours de contrat : l’ancienne ressource perdrait son historique', () => {
    assert.equal(canChangeContractResource(contrat(), '2026-04-15'), false)
  })

  it('refusé pour un brouillon : il se modifie en entier', () => {
    assert.equal(canChangeContractResource(contrat({ status: 'draft' }), '2026-02-01'), false)
  })

  it('refusé pour un contrat résilié', () => {
    assert.equal(
      canChangeContractResource(
        contrat({ status: 'terminated', terminatedOn: '2026-05-31' }),
        '2026-02-01',
      ),
      false,
    )
  })

  it('refusé pour un contrat archivé', () => {
    assert.equal(canChangeContractResource(contrat({ deletedAt: new Date() }), '2026-02-01'), false)
  })
})

describe('bornes de l’occupation', () => {
  it('va de minuit le premier jour au lendemain du dernier, heure du centre', () => {
    // Exemple de l'ADR 018 : heure d'hiver au début, heure d'été à la fin.
    const range = contractRange(contrat(), PARIS)
    assert.equal(range.startsAt.toISOString(), '2026-02-28T23:00:00.000Z')
    assert.equal(range.endsAt.toISOString(), '2026-06-30T22:00:00.000Z')
  })

  it('s’arrête au soir de la résiliation', () => {
    const range = contractRange(contrat({ terminatedOn: '2026-04-15' }), PARIS)
    assert.equal(range.endsAt.toISOString(), '2026-04-15T22:00:00.000Z')
  })

  it('court jusqu’à la borne lointaine sans terme', () => {
    const range = contractRange(contrat({ endsOn: null }), PARIS)
    assert.equal(range.endsAt.getTime(), OPEN_ENDED_BOOKING_END.getTime())
  })

  it('suit le fuseau du centre, pas l’UTC', () => {
    const range = contractRange(contrat(), 'America/New_York')
    assert.equal(range.startsAt.toISOString(), '2026-03-01T05:00:00.000Z')
  })
})

describe('jours civils d’une occupation', () => {
  it('rend le premier et le dernier jour, bornes comprises', () => {
    assert.deepEqual(occupationDays(contractRange(contrat(), PARIS), PARIS), {
      firstDay: '2026-03-01',
      lastDay: '2026-06-30',
    })
  })

  it('rend un dernier jour nul pour une occupation sans terme', () => {
    assert.deepEqual(occupationDays(contractRange(contrat({ endsOn: null }), PARIS), PARIS), {
      firstDay: '2026-03-01',
      lastDay: null,
    })
  })

  it('traverse le passage à l’heure d’hiver', () => {
    const range = contractRange(contrat({ startsOn: '2026-10-01', endsOn: '2026-10-31' }), PARIS)
    assert.deepEqual(occupationDays(range, PARIS), { firstDay: '2026-10-01', lastDay: '2026-10-31' })
  })
})

describe('affichage des jours', () => {
  it('écrit une date à la française', () => {
    assert.equal(formatCalendarDate('2026-03-01'), '01/03/2026')
  })

  it('dit « sans terme », jamais le 31/12/9999', () => {
    assert.equal(
      formatContractDays({ firstDay: '2026-03-01', lastDay: null }),
      'à partir du 01/03/2026, sans terme',
    )
  })

  it('dit la période bornée', () => {
    assert.equal(
      formatContractDays({ firstDay: '2026-03-01', lastDay: '2026-06-30' }),
      'du 01/03/2026 au 30/06/2026',
    )
  })

  it('dit un jour unique', () => {
    assert.equal(formatContractDays({ firstDay: '2026-03-01', lastDay: '2026-03-01' }), 'le 01/03/2026')
  })
})
