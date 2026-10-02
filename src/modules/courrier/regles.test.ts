import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  canCancelOpeningRequest,
  canOpen,
  canRequestOpening,
  groupOpeningsByClient,
  openingOrigin,
  type OpeningLine,
} from './regles.ts'

describe('cycle d’un pli', () => {
  it('ne laisse demander l’ouverture que d’un pli fermé', () => {
    assert.equal(canRequestOpening('received'), true)
    // Une seconde demande ferait croire à deux prestations.
    assert.equal(canRequestOpening('opening_requested'), false)
    assert.equal(canRequestOpening('opened'), false)
  })

  it('n’annule une demande que tant que le pli n’est pas ouvert', () => {
    assert.equal(canCancelOpeningRequest('opening_requested'), true)
    // Ouvert, le travail est fait : annuler effacerait une prestation due.
    assert.equal(canCancelOpeningRequest('opened'), false)
    assert.equal(canCancelOpeningRequest('received'), false)
  })

  it('laisse le centre ouvrir un pli demandé ou de lui-même, une seule fois', () => {
    assert.equal(canOpen('opening_requested'), true)
    assert.equal(canOpen('received'), true)
    assert.equal(canOpen('opened'), false)
  })

  it('attribue l’ouverture au client quand il l’a demandée', () => {
    assert.equal(openingOrigin({ openingRequestedAt: new Date() }), 'client')
    assert.equal(openingOrigin({ openingRequestedAt: null }), 'centre')
  })
})

describe('relevé des ouvertures', () => {
  const ouverture = (overrides: Partial<OpeningLine>): OpeningLine => ({
    mailItemId: 'm1',
    clientId: 'c1',
    clientName: 'Atelier Durand',
    clientSiret: null,
    kind: 'lettre',
    sender: 'URSSAF',
    receivedAt: new Date('2026-09-01T08:00:00Z'),
    openingRequestedAt: null,
    requestedBy: null,
    openedAt: new Date('2026-09-02T08:00:00Z'),
    openedBy: 'Camille',
    ...overrides,
  })

  it('regroupe par client et compte chaque ouverture', () => {
    const releve = groupOpeningsByClient([
      ouverture({ mailItemId: 'm1', clientId: 'c1' }),
      ouverture({ mailItemId: 'm2', clientId: 'c2', clientName: 'Boulangerie Petit' }),
      ouverture({ mailItemId: 'm3', clientId: 'c1' }),
    ])
    assert.deepEqual(
      releve.map((groupe) => [groupe.clientName, groupe.total]),
      [
        ['Atelier Durand', 2],
        ['Boulangerie Petit', 1],
      ],
    )
  })

  it('distingue les ouvertures demandées par le client', () => {
    const [groupe] = groupOpeningsByClient([
      ouverture({ mailItemId: 'm1', openingRequestedAt: new Date('2026-09-02T07:00:00Z') }),
      ouverture({ mailItemId: 'm2' }),
    ])
    assert.equal(groupe.total, 2)
    assert.equal(groupe.requestedByClient, 1)
  })

  it('classe les clients par nom, sans tenir compte des accents ni de la casse', () => {
    const releve = groupOpeningsByClient([
      ouverture({ clientId: 'c1', clientName: 'Zèbre SAS' }),
      ouverture({ clientId: 'c2', clientName: 'élan conseil' }),
      ouverture({ clientId: 'c3', clientName: 'Axe' }),
    ])
    assert.deepEqual(
      releve.map((groupe) => groupe.clientName),
      ['Axe', 'élan conseil', 'Zèbre SAS'],
    )
  })

  it('présente les ouvertures d’un client dans l’ordre où elles ont eu lieu', () => {
    const [groupe] = groupOpeningsByClient([
      ouverture({ mailItemId: 'tard', openedAt: new Date('2026-09-20T08:00:00Z') }),
      ouverture({ mailItemId: 'tot', openedAt: new Date('2026-09-03T08:00:00Z') }),
    ])
    assert.deepEqual(
      groupe.lines.map((ligne) => ligne.mailItemId),
      ['tot', 'tard'],
    )
  })

  it('rend un relevé vide sans ouverture', () => {
    assert.deepEqual(groupOpeningsByClient([]), [])
  })
})
