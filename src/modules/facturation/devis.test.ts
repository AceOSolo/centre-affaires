import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { wallClockToUtc } from '../../lib/dates.ts'
import {
  NO_BOOKING_QUOTE,
  bookingDurationMinutes,
  bookingQuoteColumns,
  frozenQuoteDisplay,
  parseQuoteDiscount,
  quoteBooking,
  type BookingQuoteInput,
  type QuotePlan,
} from './devis.ts'
import { DEFAULT_QUANTITY_RULES } from './tarifs.ts'

const PARIS = 'Europe/Paris'
const SALLE = { id: 'salle-mont-blanc', resourceType: 'salle' as const }
const BUREAU = { id: 'bureau-3', resourceType: 'bureau' as const }
const BOITE = { id: 'bal-01', resourceType: 'boite_aux_lettres' as const }
const REGLES = { ...DEFAULT_QUANTITY_RULES, defaultVatRateBp: 2_000 }

let itemSequence = 0
const prix = (
  resourceType: 'salle' | 'bureau' | 'boite_aux_lettres',
  unit: 'hour' | 'half_day' | 'day' | 'week' | 'month',
  amountCents: number,
  resourceId: string | null = null,
) => ({ id: `item-${(itemSequence += 1)}`, resourceType, resourceId, unit, amountCents })

const grille = (
  id: string,
  items: QuotePlan['items'],
  validite: { validFrom?: string; validTo?: string } = {},
): QuotePlan => ({
  id,
  name: `Grille ${id}`,
  currency: 'EUR',
  validFrom: validite.validFrom ?? null,
  validTo: validite.validTo ?? null,
  items,
})

/** La grille publique réelle du centre (`infra/catalogue.mjs`, ADR 009). */
const PUBLIQUE = grille('publique', [
  prix('salle', 'half_day', 9_000),
  prix('salle', 'day', 13_000),
  prix('bureau', 'half_day', 700),
  prix('boite_aux_lettres', 'month', 3_000),
])

/** Créneau du centre, en heure murale de Paris. */
const creneau = (debut: string, fin: string) => ({
  startsAt: wallClockToUtc(debut, PARIS),
  endsAt: wallClockToUtc(fin, PARIS),
})

const devis = (overrides: Partial<BookingQuoteInput> & { startsAt: Date; endsAt: Date }) =>
  quoteBooking({
    resource: SALLE,
    timeZone: PARIS,
    plans: [{ plan: PUBLIQUE, source: { kind: 'default' } }],
    rules: REGLES,
    ...overrides,
  })

const retenu = (outcome: ReturnType<typeof quoteBooking>) => {
  assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.reason)
  if (!outcome.ok) throw new Error('devis attendu')
  return outcome.quote
}

describe('quoteBooking : unité retenue (R11, ADR 023)', () => {
  it('chiffre une réunion de quatre heures à la demi-journée', () => {
    const quote = retenu(devis(creneau('2026-10-06T09:00', '2026-10-06T13:00')))
    assert.equal(quote.unit, 'half_day')
    assert.equal(quote.quantity, 1)
    assert.equal(quote.unitPriceCents, 9_000)
    assert.equal(quote.netCents, 9_000)
    assert.equal(quote.vatRateBp, 2_000)
    assert.equal(quote.vatCents, 1_800)
    assert.equal(quote.totalCents, 10_800)
    assert.equal(quote.ratePlanId, 'publique')
    assert.deepEqual(quote.source, { kind: 'default' })
  })

  it('retient la journée plutôt que trois demi-journées : le moins cher', () => {
    const quote = retenu(devis(creneau('2026-10-06T09:00', '2026-10-06T18:00')))
    assert.equal(quote.unit, 'day')
    assert.equal(quote.quantity, 1)
    assert.equal(quote.netCents, 13_000)
    // Les deux façons de chiffrer sont rendues, pour que l'écran les montre.
    assert.deepEqual(
      quote.options.map(({ unit, quantity, grossCents }) => ({ unit, quantity, grossCents })),
      [
        { unit: 'half_day', quantity: 3, grossCents: 27_000 },
        { unit: 'day', quantity: 1, grossCents: 13_000 },
      ],
    )
  })

  it('retient la journée dès que deux demi-journées coûtent plus', () => {
    const quote = retenu(devis(creneau('2026-10-06T09:00', '2026-10-06T14:00')))
    assert.equal(quote.unit, 'day')
    assert.equal(quote.netCents, 13_000)
  })

  it('préfère l’heure pour une réunion courte quand la grille en a une', () => {
    const avecHeure = grille('heure', [...PUBLIQUE.items, prix('salle', 'hour', 2_500)])
    const plans = [{ plan: avecHeure, source: { kind: 'default' as const } }]
    assert.equal(retenu(devis({ ...creneau('2026-10-06T09:00', '2026-10-06T11:00'), plans })).netCents, 5_000)
    // Quatre heures : 100 € à l'heure, 90 € la demi-journée.
    const quatre = retenu(devis({ ...creneau('2026-10-06T09:00', '2026-10-06T13:00'), plans }))
    assert.equal(quatre.unit, 'half_day')
    assert.equal(quatre.netCents, 9_000)
  })

  it('à montant égal, retient l’unité la plus large', () => {
    const egale = grille('egale', [prix('salle', 'hour', 2_250), prix('salle', 'half_day', 9_000)])
    const quote = retenu(
      devis({ ...creneau('2026-10-06T09:00', '2026-10-06T13:00'), plans: [{ plan: egale, source: { kind: 'default' } }] }),
    )
    assert.equal(quote.unit, 'half_day')
  })

  it('chiffre une semaine moins cher que cinq journées (R08)', () => {
    const semaine = grille('semaine', [prix('bureau', 'day', 2_000), prix('bureau', 'week', 8_000)])
    const plans = [{ plan: semaine, source: { kind: 'default' as const } }]
    const cinqJours = retenu(
      devis({ resource: BUREAU, plans, ...creneau('2026-10-05T00:00', '2026-10-10T00:00') }),
    )
    assert.equal(cinqJours.unit, 'week')
    assert.equal(cinqJours.quantity, 1)
    assert.equal(cinqJours.netCents, 8_000)
    const troisJours = retenu(
      devis({ resource: BUREAU, plans, ...creneau('2026-10-05T00:00', '2026-10-08T00:00') }),
    )
    assert.equal(troisJours.unit, 'day')
    assert.equal(troisJours.netCents, 6_000)
  })

  it('ne chiffre jamais une réservation au mois : c’est un tarif de contrat', () => {
    const outcome = devis({ resource: BOITE, ...creneau('2026-10-06T09:00', '2026-10-06T10:00') })
    assert.deepEqual(outcome, { ok: false, reason: 'aucun-tarif' })
  })

  it('le tarif nominatif prime sur celui du type', () => {
    const nominative = grille('nominative', [...PUBLIQUE.items, prix('salle', 'half_day', 11_000, SALLE.id)])
    const quote = retenu(
      devis({
        ...creneau('2026-10-06T09:00', '2026-10-06T13:00'),
        plans: [{ plan: nominative, source: { kind: 'default' } }],
      }),
    )
    assert.equal(quote.netCents, 11_000)
  })
})

describe('quoteBooking : durée en heure murale du centre', () => {
  it('compte trois jours pour trois jours, même à travers le changement d’heure', () => {
    // Nuit du 24 au 25 octobre 2026 : on recule d'une heure à Paris.
    const { startsAt, endsAt } = creneau('2026-10-24T00:00', '2026-10-27T00:00')
    assert.equal((endsAt.getTime() - startsAt.getTime()) / 3_600_000, 73)
    assert.equal(bookingDurationMinutes(startsAt, endsAt, PARIS), 72 * 60)
    const semaine = grille('jour', [prix('bureau', 'day', 2_000)])
    const quote = retenu(
      devis({ resource: BUREAU, startsAt, endsAt, plans: [{ plan: semaine, source: { kind: 'default' } }] }),
    )
    assert.equal(quote.quantity, 3)
  })

  it('refuse un créneau vide ou inversé', () => {
    const { startsAt } = creneau('2026-10-06T09:00', '2026-10-06T09:00')
    assert.deepEqual(devis({ startsAt, endsAt: startsAt }), { ok: false, reason: 'creneau-invalide' })
  })
})

describe('quoteBooking : règles du centre (R10)', () => {
  it('lit la tolérance de l’unité entamée', () => {
    const tolerant = { ...REGLES, startedUnitToleranceMinutes: 10 }
    const quote = retenu(devis({ ...creneau('2026-10-06T09:00', '2026-10-06T13:10'), rules: tolerant }))
    assert.equal(quote.unit, 'half_day')
    assert.equal(quote.quantity, 1)
    // Sans tolérance, la demi-journée entamée fait passer à la journée.
    assert.equal(retenu(devis(creneau('2026-10-06T09:00', '2026-10-06T13:10'))).unit, 'day')
  })

  it('lit la durée de la demi-journée', () => {
    const longue = { ...REGLES, halfDayMinutes: 300 }
    const quote = retenu(devis({ ...creneau('2026-10-06T09:00', '2026-10-06T14:00'), rules: longue }))
    assert.equal(quote.unit, 'half_day')
    assert.equal(quote.netCents, 9_000)
  })

  it('applique le taux de TVA du centre', () => {
    const quote = retenu(devis({ ...creneau('2026-10-06T09:00', '2026-10-06T13:00'), rules: { ...REGLES, defaultVatRateBp: 1_000 } }))
    assert.equal(quote.vatCents, 900)
    assert.equal(quote.totalCents, 9_900)
  })
})

describe('quoteBooking : grilles et validité (R08)', () => {
  it('ignore la grille par défaut hors de ses dates', () => {
    const g2026 = grille('2026', PUBLIQUE.items, { validFrom: '2026-01-01', validTo: '2026-12-31' })
    const plans = [{ plan: g2026, source: { kind: 'default' as const } }]
    assert.equal(retenu(devis({ ...creneau('2026-12-31T09:00', '2026-12-31T13:00'), plans })).netCents, 9_000)
    assert.deepEqual(devis({ ...creneau('2027-01-04T09:00', '2027-01-04T13:00'), plans }), {
      ok: false,
      reason: 'aucune-grille',
    })
  })

  it('juge la validité au jour du centre, pas au jour UTC', () => {
    // 0 h 30 le 1er janvier à Paris : encore le 31 décembre en UTC.
    const g2027 = grille('2027', PUBLIQUE.items, { validFrom: '2027-01-01' })
    const quote = devis({
      ...creneau('2027-01-01T00:30', '2027-01-01T04:30'),
      plans: [{ plan: g2027, source: { kind: 'default' } }],
    })
    assert.equal(quote.ok, true)
  })

  it('applique la grille du contrat du client avant celle du centre', () => {
    const contrat = grille('contrat', [prix('salle', 'half_day', 7_000)])
    const quote = retenu(
      devis({
        ...creneau('2026-10-06T09:00', '2026-10-06T13:00'),
        plans: [
          { plan: contrat, source: { kind: 'contract', contractId: 'c1', contractReference: 'CT-2026-0001' } },
          { plan: PUBLIQUE, source: { kind: 'default' } },
        ],
      }),
    )
    assert.equal(quote.netCents, 7_000)
    assert.equal(quote.ratePlanId, 'contrat')
    assert.deepEqual(quote.source, { kind: 'contract', contractId: 'c1', contractReference: 'CT-2026-0001' })
  })

  it('retombe sur la grille du centre quand celle du contrat ne tarife pas la ressource', () => {
    const contrat = grille('contrat', [prix('bureau', 'half_day', 500)])
    const quote = retenu(
      devis({
        ...creneau('2026-10-06T09:00', '2026-10-06T13:00'),
        plans: [
          { plan: contrat, source: { kind: 'contract', contractId: 'c1', contractReference: 'CT-2026-0001' } },
          { plan: PUBLIQUE, source: { kind: 'default' } },
        ],
      }),
    )
    assert.equal(quote.ratePlanId, 'publique')
  })

  it('retombe sur la grille du centre quand celle du contrat a expiré', () => {
    const contrat = grille('contrat', [prix('salle', 'half_day', 7_000)], { validTo: '2026-09-30' })
    const quote = retenu(
      devis({
        ...creneau('2026-10-06T09:00', '2026-10-06T13:00'),
        plans: [
          { plan: contrat, source: { kind: 'contract', contractId: 'c1', contractReference: 'CT-2026-0001' } },
          { plan: PUBLIQUE, source: { kind: 'default' } },
        ],
      }),
    )
    assert.equal(quote.netCents, 9_000)
  })

  it('dit quand aucune grille n’existe', () => {
    assert.deepEqual(devis({ ...creneau('2026-10-06T09:00', '2026-10-06T13:00'), plans: [] }), {
      ok: false,
      reason: 'aucune-grille',
    })
  })
})

describe('quoteBooking : remises (R10, ADR 023)', () => {
  const journee = creneau('2026-10-06T09:00', '2026-10-06T18:00')

  it('applique une remise en pourcentage, un seul arrondi', () => {
    const quote = retenu(devis({ ...journee, discount: { kind: 'percent', basisPoints: 1_000 } }))
    assert.equal(quote.grossCents, 13_000)
    assert.equal(quote.discountBp, 1_000)
    assert.equal(quote.discountAmountCents, null)
    assert.equal(quote.discountCents, 1_300)
    assert.equal(quote.netCents, 11_700)
    assert.equal(quote.vatCents, 2_340)
    assert.equal(quote.totalCents, 14_040)
  })

  it('applique une remise en montant', () => {
    const quote = retenu(devis({ ...journee, discount: { kind: 'amount', cents: 1_000 } }))
    assert.equal(quote.discountAmountCents, 1_000)
    assert.equal(quote.netCents, 12_000)
  })

  it('arrondit la moitié en s’éloignant de zéro', () => {
    const impaire = grille('impaire', [prix('salle', 'half_day', 3_335)])
    const quote = retenu(
      devis({
        ...creneau('2026-10-06T09:00', '2026-10-06T13:00'),
        plans: [{ plan: impaire, source: { kind: 'default' } }],
        discount: { kind: 'percent', basisPoints: 1_000 },
      }),
    )
    // 33,35 € × 0,9 = 30,015 € → 30,02 € ; TVA 6,004 € → 6,00 €.
    assert.equal(quote.netCents, 3_002)
    assert.equal(quote.vatCents, 600)
  })

  it('ignore une remise nulle', () => {
    const quote = retenu(devis({ ...journee, discount: { kind: 'percent', basisPoints: 0 } }))
    assert.equal(quote.discountBp, null)
    assert.equal(quote.netCents, 13_000)
  })

  it('refuse une remise plus grande que le montant', () => {
    assert.deepEqual(devis({ ...journee, discount: { kind: 'amount', cents: 13_001 } }), {
      ok: false,
      reason: 'remise-excessive',
    })
  })

  it('refuse une remise illisible', () => {
    assert.deepEqual(devis({ ...journee, discount: { kind: 'percent', basisPoints: 10_001 } }), {
      ok: false,
      reason: 'remise-invalide',
    })
    assert.deepEqual(devis({ ...journee, discount: { kind: 'amount', cents: 12.5 } }), {
      ok: false,
      reason: 'remise-invalide',
    })
  })
})

describe('parseQuoteDiscount', () => {
  it('lit un pourcentage ou un montant saisis', () => {
    assert.deepEqual(parseQuoteDiscount('percent', '12,5'), {
      ok: true,
      discount: { kind: 'percent', basisPoints: 1_250 },
    })
    assert.deepEqual(parseQuoteDiscount('amount', '15,50'), {
      ok: true,
      discount: { kind: 'amount', cents: 1_550 },
    })
  })

  it('ne pose aucune remise sans forme ou sans valeur', () => {
    assert.deepEqual(parseQuoteDiscount('', '10'), { ok: true, discount: null })
    assert.deepEqual(parseQuoteDiscount('percent', '  '), { ok: true, discount: null })
  })

  it('refuse une saisie illisible ou une forme inconnue', () => {
    assert.equal(parseQuoteDiscount('percent', '120').ok, false)
    assert.equal(parseQuoteDiscount('amount', '-5').ok, false)
    assert.equal(parseQuoteDiscount('cadeau', '5').ok, false)
  })
})

describe('frozenQuoteDisplay', () => {
  it('relit le devis figé sur une réservation, HT de la base compris', () => {
    const quote = retenu(devis({ ...creneau('2026-10-06T09:00', '2026-10-06T18:00'), discount: { kind: 'percent', basisPoints: 1_000 } }))
    const columns = bookingQuoteColumns(quote, new Date('2026-10-01T08:00:00Z'))
    const affiche = frozenQuoteDisplay({ ...columns, quoteAmountCents: 11_700 })
    assert.deepEqual(affiche, {
      unit: 'day',
      quantity: 1,
      unitPriceCents: 13_000,
      discountBp: 1_000,
      discountAmountCents: null,
      discountCents: 1_300,
      netCents: 11_700,
      vatRateBp: 2_000,
      vatCents: 2_340,
      totalCents: 14_040,
      currency: 'EUR',
    })
  })

  it('ne montre rien pour une réservation non chiffrée', () => {
    assert.equal(frozenQuoteDisplay({ ...NO_BOOKING_QUOTE, quoteAmountCents: null }), undefined)
  })
})

describe('bookingQuoteColumns', () => {
  it('fige le devis dans les colonnes de la réservation, sans le montant calculé par la base', () => {
    const quote = retenu(devis({ ...creneau('2026-10-06T09:00', '2026-10-06T13:00'), discount: { kind: 'amount', cents: 500 } }))
    const quotedAt = new Date('2026-10-01T08:00:00Z')
    const columns = bookingQuoteColumns(quote, quotedAt)
    assert.deepEqual(columns, {
      quoteUnit: 'half_day',
      quoteQuantity: 1,
      quoteUnitPriceCents: 9_000,
      quoteDiscountBp: null,
      quoteDiscountAmountCents: 500,
      quoteVatRateBp: 2_000,
      quoteCurrency: 'EUR',
      quoteRatePlanItemId: quote.ratePlanItemId,
      quotedAt,
    })
    // Mêmes clés que la réservation non chiffrée : tout ou rien.
    assert.deepEqual(Object.keys(columns).sort(), Object.keys(NO_BOOKING_QUOTE).sort())
  })
})
