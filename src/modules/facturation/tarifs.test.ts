import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  billableQuantity,
  formatCents,
  parseAmountToCents,
  priceCents,
  resolveRate,
  type RateCandidate,
} from './tarifs.ts'

const SALLE_EUROPE = 'resource-salle-europe'
const SALLE_ASIE = 'resource-salle-asie'

const ligne = (overrides: Partial<RateCandidate> = {}): RateCandidate => ({
  resourceType: 'salle',
  resourceId: null,
  unit: 'hour',
  amountCents: 2_500,
  ...overrides,
})

const at = (iso: string) => new Date(iso)

describe('resolveRate', () => {
  const grille: RateCandidate[] = [
    ligne({ amountCents: 2_500 }),
    ligne({ resourceId: SALLE_EUROPE, amountCents: 4_000 }),
    ligne({ unit: 'day', amountCents: 15_000 }),
    ligne({ resourceType: 'bureau', unit: 'month', amountCents: 90_000 }),
  ]

  it('préfère le tarif nominatif au tarif de type', () => {
    const tarif = resolveRate(grille, {
      resourceId: SALLE_EUROPE,
      resourceType: 'salle',
      unit: 'hour',
    })
    assert.equal(tarif?.amountCents, 4_000)
  })

  it('retombe sur le tarif de type pour les autres ressources', () => {
    const tarif = resolveRate(grille, {
      resourceId: SALLE_ASIE,
      resourceType: 'salle',
      unit: 'hour',
    })
    assert.equal(tarif?.amountCents, 2_500)
  })

  it('distingue les unités', () => {
    assert.equal(
      resolveRate(grille, { resourceId: SALLE_ASIE, resourceType: 'salle', unit: 'day' })
        ?.amountCents,
      15_000,
    )
  })

  it('ne confond pas deux types de ressources', () => {
    assert.equal(
      resolveRate(grille, { resourceId: 'bureau-12', resourceType: 'bureau', unit: 'hour' }),
      undefined,
    )
  })

  it('ne rend rien quand la grille ne couvre pas le besoin', () => {
    assert.equal(
      resolveRate([], { resourceId: SALLE_EUROPE, resourceType: 'salle', unit: 'hour' }),
      undefined,
    )
  })
})

describe('billableQuantity', () => {
  it('facture une heure pleine pour une heure', () => {
    assert.equal(billableQuantity('hour', at('2026-10-01T09:00:00Z'), at('2026-10-01T10:00:00Z')), 1)
  })

  it('facture toute heure entamée', () => {
    assert.equal(billableQuantity('hour', at('2026-10-01T09:00:00Z'), at('2026-10-01T10:01:00Z')), 2)
    assert.equal(billableQuantity('hour', at('2026-10-01T09:00:00Z'), at('2026-10-01T10:30:00Z')), 2)
  })

  it('facture une demi-journée pour un créneau de quatre heures', () => {
    assert.equal(
      billableQuantity('half_day', at('2026-10-01T08:00:00Z'), at('2026-10-01T12:00:00Z')),
      1,
    )
  })

  it('facture toute demi-journée entamée', () => {
    assert.equal(
      billableQuantity('half_day', at('2026-10-01T08:00:00Z'), at('2026-10-01T12:30:00Z')),
      2,
    )
    // Une journée de bureau couvre trois demi-journées entamées : c'est bien
    // pour cela qu'une ressource vendue à la journée porte une ligne `day`.
    assert.equal(
      billableQuantity('half_day', at('2026-10-01T09:00:00Z'), at('2026-10-01T18:00:00Z')),
      3,
    )
  })

  it('facture les journées entamées', () => {
    assert.equal(billableQuantity('day', at('2026-10-01T08:00:00Z'), at('2026-10-01T18:00:00Z')), 1)
    assert.equal(billableQuantity('day', at('2026-10-01T08:00:00Z'), at('2026-10-02T09:00:00Z')), 2)
  })

  it('facture les semaines entamées (R08)', () => {
    // Sept jours pleins : une semaine.
    assert.equal(billableQuantity('week', at('2026-10-05T00:00:00Z'), at('2026-10-12T00:00:00Z')), 1)
    // Un lundi matin : une semaine entamée est due.
    assert.equal(billableQuantity('week', at('2026-10-05T08:00:00Z'), at('2026-10-05T12:00:00Z')), 1)
    // Huit jours : deux semaines entamées.
    assert.equal(billableQuantity('week', at('2026-10-05T00:00:00Z'), at('2026-10-13T00:00:00Z')), 2)
  })

  it('traite le mois et la prestation comme des forfaits', () => {
    assert.equal(billableQuantity('month', at('2026-10-01T09:00:00Z'), at('2026-10-01T10:00:00Z')), 1)
    assert.equal(billableQuantity('unit', at('2026-10-01T09:00:00Z'), at('2026-10-05T10:00:00Z')), 1)
  })

  it('ne facture rien pour un intervalle vide', () => {
    assert.equal(billableQuantity('hour', at('2026-10-01T09:00:00Z'), at('2026-10-01T09:00:00Z')), 0)
    assert.equal(
      billableQuantity('half_day', at('2026-10-01T09:00:00Z'), at('2026-10-01T09:00:00Z')),
      0,
    )
  })

  it("la demi-journée n'est pas la moitié de la journée", () => {
    // Le tarif du centre le dit : 90 € la demi-journée, 130 € la journée. Si
    // l'une se déduisait de l'autre, la grille n'aurait besoin que d'une ligne.
    const demiJournee = ligne({ unit: 'half_day', amountCents: 9_000 })
    const journee = ligne({ unit: 'day', amountCents: 13_000 })
    const matin = [at('2026-10-01T08:00:00Z'), at('2026-10-01T12:00:00Z')] as const

    assert.equal(priceCents(demiJournee, ...matin), 9_000)
    assert.notEqual(priceCents(demiJournee, ...matin) * 2, journee.amountCents)
  })
})

describe('priceCents', () => {
  it('multiplie le tarif par la quantité entamée', () => {
    const tarif = ligne({ amountCents: 2_500 })
    assert.equal(priceCents(tarif, at('2026-10-01T09:00:00Z'), at('2026-10-01T10:30:00Z')), 5_000)
  })

  it('rend un entier de centimes', () => {
    const montant = priceCents(
      ligne({ amountCents: 3_333 }),
      at('2026-10-01T09:00:00Z'),
      at('2026-10-01T12:00:00Z'),
    )
    assert.equal(montant, 9_999)
    assert.equal(Number.isInteger(montant), true)
  })
})

describe('parseAmountToCents', () => {
  it('lit une saisie française', () => {
    assert.equal(parseAmountToCents('1 250,50'), 125_050)
    assert.equal(parseAmountToCents('1250,5'), 125_050)
  })

  it('lit une saisie à point décimal', () => {
    assert.equal(parseAmountToCents('1250.50'), 125_050)
    assert.equal(parseAmountToCents('900'), 90_000)
  })

  it('évite l’arrondi binaire de la multiplication par 100', () => {
    // 19.99 * 100 vaut 1998.9999999999998 en flottant.
    assert.equal(parseAmountToCents('19,99'), 1_999)
    assert.equal(parseAmountToCents('1,10'), 110)
  })

  it('refuse une saisie illisible plutôt que de rendre NaN', () => {
    for (const saisie of ['', 'abc', '12,345', '-5', '1.2.3']) {
      assert.equal(parseAmountToCents(saisie), undefined, saisie)
    }
  })
})

describe('formatCents', () => {
  it('affiche un montant en euros', () => {
    // Les espaces sont insécables dans le format français.
    assert.match(formatCents(125_050), /1\s?250,50\s?€/)
    assert.match(formatCents(90_000), /900,00\s?€/)
  })
})
