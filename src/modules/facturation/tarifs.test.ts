import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  DEFAULT_QUANTITY_RULES,
  billableQuantity,
  formatBasisPoints,
  formatCents,
  isRatePlanValidOn,
  parseAmountToCents,
  parsePercentToBasisPoints,
  pickRateItem,
  ratePlanValidityState,
  resolveRate,
  type RateCandidate,
} from './tarifs.ts'

const SALLE_EUROPE = 'resource-salle-europe'
const SALLE_ASIE = 'resource-salle-asie'
const JOUR = '2026-10-01'

const ligne = (overrides: Partial<RateCandidate> = {}): RateCandidate => ({
  resourceType: 'salle',
  resourceId: null,
  unit: 'hour',
  amountCents: 2_500,
  ...overrides,
})

const grilleDe = (items: RateCandidate[], validite: { validFrom?: string; validTo?: string } = {}) => ({
  validFrom: validite.validFrom ?? null,
  validTo: validite.validTo ?? null,
  items,
})

const regles = DEFAULT_QUANTITY_RULES

describe('resolveRate', () => {
  const grille = grilleDe([
    ligne({ amountCents: 2_500 }),
    ligne({ resourceId: SALLE_EUROPE, amountCents: 4_000 }),
    ligne({ unit: 'day', amountCents: 15_000 }),
    ligne({ resourceType: 'bureau', unit: 'month', amountCents: 90_000 }),
  ])

  it('préfère le tarif nominatif au tarif de type', () => {
    const tarif = resolveRate(grille, {
      resourceId: SALLE_EUROPE,
      resourceType: 'salle',
      unit: 'hour',
      on: JOUR,
    })
    assert.equal(tarif?.amountCents, 4_000)
  })

  it('retombe sur le tarif de type pour les autres ressources', () => {
    const tarif = resolveRate(grille, {
      resourceId: SALLE_ASIE,
      resourceType: 'salle',
      unit: 'hour',
      on: JOUR,
    })
    assert.equal(tarif?.amountCents, 2_500)
  })

  it('distingue les unités', () => {
    assert.equal(
      resolveRate(grille, { resourceId: SALLE_ASIE, resourceType: 'salle', unit: 'day', on: JOUR })
        ?.amountCents,
      15_000,
    )
  })

  it('ne confond pas deux types de ressources', () => {
    assert.equal(
      resolveRate(grille, { resourceId: 'bureau-12', resourceType: 'bureau', unit: 'hour', on: JOUR }),
      undefined,
    )
  })

  it('ne rend rien quand la grille ne couvre pas le besoin', () => {
    const lookup = { resourceId: SALLE_EUROPE, resourceType: 'salle' as const, unit: 'hour' as const, on: JOUR }
    assert.equal(resolveRate(grilleDe([]), lookup), undefined)
    assert.equal(resolveRate(undefined, lookup), undefined)
  })

  it('ignore une grille hors de ses dates de validité (R08)', () => {
    const lookup = { resourceId: SALLE_ASIE, resourceType: 'salle' as const, unit: 'hour' as const }
    const g2026 = grilleDe([ligne()], { validFrom: '2026-01-01', validTo: '2026-12-31' })
    assert.equal(resolveRate(g2026, { ...lookup, on: '2026-12-31' })?.amountCents, 2_500)
    assert.equal(resolveRate(g2026, { ...lookup, on: '2027-01-01' }), undefined)
    assert.equal(resolveRate(g2026, { ...lookup, on: '2025-12-31' }), undefined)
  })

  it('ne lit que la ligne de type pour une cible sans ressource précise', () => {
    // Une ligne d'offre ou de contrat qui vise « une salle » : le prix nominatif
    // de la salle Europe ne la concerne pas.
    assert.equal(
      pickRateItem(grille.items, { resourceId: null, resourceType: 'salle', unit: 'hour' })
        ?.amountCents,
      2_500,
    )
    assert.equal(
      pickRateItem(grille.items, { resourceId: SALLE_EUROPE, resourceType: 'salle', unit: 'hour' })
        ?.amountCents,
      4_000,
    )
  })

  it('ignore une grille archivée', () => {
    const archivee = { ...grilleDe([ligne()]), deletedAt: new Date('2026-09-01T00:00:00Z') }
    assert.equal(
      resolveRate(archivee, { resourceId: SALLE_ASIE, resourceType: 'salle', unit: 'hour', on: JOUR }),
      undefined,
    )
  })
})

describe('validité d’une grille', () => {
  it('compte les deux bornes comme valables', () => {
    const grille = { validFrom: '2026-01-01', validTo: '2026-12-31' }
    assert.equal(isRatePlanValidOn(grille, '2026-01-01'), true)
    assert.equal(isRatePlanValidOn(grille, '2026-12-31'), true)
    assert.equal(isRatePlanValidOn(grille, '2027-01-01'), false)
  })

  it('n’a pas de borne quand la date est nulle', () => {
    assert.equal(isRatePlanValidOn({ validFrom: null, validTo: null }, '1999-01-01'), true)
    assert.equal(isRatePlanValidOn({ validFrom: '2026-06-01', validTo: null }, '2099-01-01'), true)
  })

  it('dit où en est la grille, pour l’écran', () => {
    const grille = { validFrom: '2026-06-01', validTo: '2026-12-31' }
    assert.equal(ratePlanValidityState(grille, '2026-05-31'), 'upcoming')
    assert.equal(ratePlanValidityState(grille, '2026-06-01'), 'current')
    assert.equal(ratePlanValidityState(grille, '2027-01-01'), 'expired')
    assert.equal(ratePlanValidityState({ ...grille, deletedAt: new Date() }, '2026-07-01'), 'archived')
  })
})

describe('billableQuantity (règles par défaut : demi-journée de 4 h, sans tolérance)', () => {
  it('facture une heure pleine pour une heure', () => {
    assert.equal(billableQuantity('hour', 60, regles), 1)
  })

  it('facture toute heure entamée', () => {
    assert.equal(billableQuantity('hour', 61, regles), 2)
    assert.equal(billableQuantity('hour', 90, regles), 2)
  })

  it('facture une demi-journée pour un créneau de quatre heures', () => {
    assert.equal(billableQuantity('half_day', 240, regles), 1)
  })

  it('facture toute demi-journée entamée', () => {
    assert.equal(billableQuantity('half_day', 270, regles), 2)
    // Une journée de bureau couvre trois demi-journées entamées : le devis
    // retient alors la journée, si la grille en a une (devis.ts).
    assert.equal(billableQuantity('half_day', 540, regles), 3)
  })

  it('facture les journées entamées', () => {
    assert.equal(billableQuantity('day', 600, regles), 1)
    assert.equal(billableQuantity('day', 25 * 60, regles), 2)
  })

  it('facture les semaines entamées (R08)', () => {
    // Sept jours pleins : une semaine.
    assert.equal(billableQuantity('week', 7 * 24 * 60, regles), 1)
    // Un lundi matin : une semaine entamée est due.
    assert.equal(billableQuantity('week', 4 * 60, regles), 1)
    // Huit jours : deux semaines entamées.
    assert.equal(billableQuantity('week', 8 * 24 * 60, regles), 2)
  })

  it('traite le mois et la prestation comme des forfaits', () => {
    assert.equal(billableQuantity('month', 60, regles), 1)
    assert.equal(billableQuantity('unit', 4 * 24 * 60, regles), 1)
  })

  it('ne facture rien pour un intervalle vide', () => {
    assert.equal(billableQuantity('hour', 0, regles), 0)
    assert.equal(billableQuantity('half_day', -30, regles), 0)
  })
})

describe('billableQuantity : règles du centre (R10, ADR 023)', () => {
  it('lit la durée de la demi-journée du centre', () => {
    const cinqHeures = { ...regles, halfDayMinutes: 300 }
    assert.equal(billableQuantity('half_day', 300, cinqHeures), 1)
    assert.equal(billableQuantity('half_day', 300, regles), 2)
  })

  it('applique la tolérance avant de compter une unité entamée', () => {
    const dixMinutes = { ...regles, startedUnitToleranceMinutes: 10 }
    // 1 h 10 : une heure avec la tolérance, deux sans.
    assert.equal(billableQuantity('hour', 70, dixMinutes), 1)
    assert.equal(billableQuantity('hour', 70, regles), 2)
    // 1 h 11 dépasse la tolérance.
    assert.equal(billableQuantity('hour', 71, dixMinutes), 2)
  })

  it('facture au moins une unité, même sous la tolérance', () => {
    assert.equal(billableQuantity('hour', 5, { ...regles, startedUnitToleranceMinutes: 10 }), 1)
  })

  it('applique la tolérance à toutes les unités de durée', () => {
    const quinze = { ...regles, startedUnitToleranceMinutes: 15 }
    assert.equal(billableQuantity('half_day', 4 * 60 + 15, quinze), 1)
    assert.equal(billableQuantity('day', 24 * 60 + 15, quinze), 1)
    assert.equal(billableQuantity('week', 7 * 24 * 60 + 15, quinze), 1)
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

describe('parsePercentToBasisPoints', () => {
  it('lit un pourcentage en points de base', () => {
    assert.equal(parsePercentToBasisPoints('20'), 2_000)
    assert.equal(parsePercentToBasisPoints('5,5'), 550)
    assert.equal(parsePercentToBasisPoints('2.1'), 210)
    assert.equal(parsePercentToBasisPoints('12,5 %'), 1_250)
    assert.equal(parsePercentToBasisPoints('0'), 0)
    assert.equal(parsePercentToBasisPoints('100'), 10_000)
  })

  it('évite l’arrondi binaire : 0,07 % vaut 7 points', () => {
    assert.equal(parsePercentToBasisPoints('0,07'), 7)
    assert.equal(parsePercentToBasisPoints('19,99'), 1_999)
  })

  it('refuse au-delà de 100 % et les saisies illisibles', () => {
    for (const saisie of ['', 'abc', '100,01', '-5', '1,234', '150']) {
      assert.equal(parsePercentToBasisPoints(saisie), undefined, saisie)
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

describe('formatBasisPoints', () => {
  it('affiche un taux en pourcentage français', () => {
    assert.match(formatBasisPoints(2_000), /^20\s?%$/)
    assert.match(formatBasisPoints(550), /^5,5\s?%$/)
  })
})
