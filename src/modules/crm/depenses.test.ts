import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { ActSubscription } from '../facturation/souscriptions-regles.ts'
import type { BookingSource, MailOpeningSource, MailPagesSource, MailRequestSource } from './consommations.ts'
import {
  buildExpenseMonth,
  expenseMonths,
  expenseTotals,
  fixedFeeLines,
  noActPricing,
  periodInMonth,
  priceOn,
  serviceLines,
  type ActPricing,
  type ContractFeeSource,
  type ExpenseContext,
} from './depenses.ts'

/**
 * « Mes dépenses » de l'espace client (ADR 081) : quels mois, quels frais
 * fixes, quelles prestations, à quel prix estimé. Règles pures ; la base est
 * éprouvée par `depenses.db.test.ts`.
 */

const PARIS = 'Europe/Paris'
const CLIENT = '01999f00-0000-7000-8000-00000000c001'
const AUTRE = '01999f00-0000-7000-8000-00000000c002'

const contrat = (overrides: Partial<ContractFeeSource> = {}): ContractFeeSource => ({
  contractId: '01999f00-0000-7000-8000-0000000000k1',
  clientId: CLIENT,
  reference: 'CT2611-0003',
  contractType: 'domiciliation',
  billingPeriod: 'monthly',
  currency: 'EUR',
  startsOn: '2026-01-31',
  lastDay: null,
  prices: [{ startsOn: '2026-01-31', endsOn: null, amountCents: 3000 }],
  ...overrides,
})

const reservation = (overrides: Partial<BookingSource> = {}): BookingSource => ({
  nature: 'booking',
  sourceId: '01999f00-0000-7000-8000-00000000b001',
  clientId: CLIENT,
  kind: 'booking',
  status: 'confirmed',
  startsAt: new Date('2026-11-10T08:00:00Z'),
  endsAt: new Date('2026-11-10T12:00:00Z'),
  resourceId: '01999f00-0000-7000-8000-00000000a001',
  resourceName: 'Salle Mont Blanc',
  resourceCode: 'SAL-MB',
  resourceType: 'salle',
  contractId: null,
  contractReference: null,
  coveredByProposal: false,
  quote: {
    unit: 'half_day',
    quantity: 1,
    unitPriceCents: 9000,
    discountBp: null,
    discountAmountCents: null,
    vatRateBp: 2000,
    currency: 'EUR',
    amountCents: 9000,
  },
  ...overrides,
})

let suivant = 0
const id = (prefix: string) => `01999f00-0000-7000-8000-${prefix}${String(++suivant).padStart(12 - prefix.length, '0')}`

const pli = (at: string, clientId = CLIENT) => ({
  clientId,
  mailItemId: id('d'),
  mailKind: 'lettre' as const,
  receivedAt: new Date(at),
  removed: false,
})

const ouverture = (at: string, overrides: Partial<MailOpeningSource> = {}): MailOpeningSource => {
  const base = pli(at)
  return { ...base, nature: 'mail_opening', sourceId: base.mailItemId, openedAt: new Date(at), ...overrides }
}

const pages = (at: string, pageCount: number): MailPagesSource => ({
  ...pli(at),
  nature: 'mail_pages',
  sourceId: id('e'),
  openedAt: new Date(at),
  pageCount,
})

const reexpedition = (at: string, postageCents: number | null): MailRequestSource => ({
  ...pli(at),
  nature: 'mail_forward',
  sourceId: id('f'),
  status: 'done',
  completedAt: new Date(at),
  postageCents,
  postageCurrency: postageCents === null ? null : 'EUR',
})

const catalogue: ActPricing['catalogue'] = {
  mail_opening: { id: 's-ouverture', unitPriceCents: 300, vatRateBp: 2000, currency: 'EUR' },
  mail_pages: { id: 's-page', unitPriceCents: 20, vatRateBp: 2000, currency: 'EUR' },
  mail_scan: { id: 's-numerisation', unitPriceCents: 250, vatRateBp: 2000, currency: 'EUR' },
  mail_forward: { id: 's-reexpedition', unitPriceCents: 500, vatRateBp: 2000, currency: 'EUR' },
}

const forfait = (overrides: Partial<ActSubscription> = {}): ActSubscription => ({
  id: 'forfait-ouvertures',
  startsOn: '2026-01-01',
  endsOn: null,
  unitPriceCents: 200,
  discountBp: null,
  vatRateBp: 2000,
  currency: 'EUR',
  includedQuantity: 2,
  ...overrides,
})

const contexte = (overrides: Partial<ExpenseContext> = {}): ExpenseContext => ({
  timeZone: PARIS,
  includedPages: 5,
  now: new Date('2026-11-17T10:00:00Z'),
  pricing: { estimate: true, catalogue, subscriptions: {} },
  ...overrides,
})

describe('dépenses : les mois montrés', () => {
  it('le mois en cours, puis les mois passés, du plus récent au plus ancien', () => {
    assert.deepEqual(expenseMonths('2026-02', 3), ['2026-02', '2026-01', '2025-12', '2025-11'])
    assert.deepEqual(expenseMonths('2026-11', 0), ['2026-11'])
  })
})

describe('dépenses : frais fixes', () => {
  it('une période par mois pour un contrat mensuel ; le 31 devient le dernier jour du mois', () => {
    assert.deepEqual(periodInMonth(contrat(), '2026-01'), { startsOn: '2026-01-31', endsOn: '2026-02-27' })
    assert.deepEqual(periodInMonth(contrat(), '2026-02'), { startsOn: '2026-02-28', endsOn: '2026-03-30' })
    assert.deepEqual(periodInMonth(contrat(), '2026-04'), { startsOn: '2026-04-30', endsOn: '2026-05-30' })
    assert.equal(periodInMonth(contrat(), '2025-12'), null)
  })

  it('un trimestre, une année : comptés le mois où la période commence', () => {
    const trimestriel = contrat({ startsOn: '2026-11-01', billingPeriod: 'quarterly' })
    assert.deepEqual(periodInMonth(trimestriel, '2026-11'), { startsOn: '2026-11-01', endsOn: '2027-01-31' })
    assert.equal(periodInMonth(trimestriel, '2026-12'), null)
    assert.equal(periodInMonth(trimestriel, '2027-01'), null)
    assert.deepEqual(periodInMonth(trimestriel, '2027-02'), { startsOn: '2027-02-01', endsOn: '2027-04-30' })
    const annuel = contrat({ startsOn: '2026-03-15', billingPeriod: 'yearly' })
    assert.equal(periodInMonth(annuel, '2026-11'), null)
    assert.deepEqual(periodInMonth(annuel, '2027-03'), { startsOn: '2027-03-15', endsOn: '2028-03-14' })
  })

  it('s’arrête au dernier jour du contrat : la dernière période est raccourcie, la suivante n’existe pas', () => {
    const resilie = contrat({ startsOn: '2026-01-01', lastDay: '2026-11-10' })
    assert.deepEqual(periodInMonth(resilie, '2026-11'), { startsOn: '2026-11-01', endsOn: '2026-11-10' })
    assert.equal(periodInMonth(resilie, '2026-12'), null)
    assert.equal(periodInMonth(contrat({ startsOn: '2026-01-15', lastDay: '2026-11-10' }), '2026-11'), null)
  })

  it('le prix en vigueur au début de la période : un avenant compte à sa date', () => {
    const prix = [
      { startsOn: '2026-01-01', endsOn: '2026-09-30', amountCents: 3000 },
      { startsOn: '2026-10-01', endsOn: null, amountCents: 3500 },
    ]
    assert.equal(priceOn(prix, '2026-09-01'), 3000)
    assert.equal(priceOn(prix, '2026-10-01'), 3500)
    assert.equal(priceOn(prix, '2025-12-31'), null)
  })

  it('une ligne par contrat dont une période commence dans le mois, dite à venir avant son jour', () => {
    const lignes = fixedFeeLines(
      [
        contrat({ startsOn: '2026-01-01' }),
        contrat({ contractId: 'k2', reference: 'CT-B', contractType: 'bureau', startsOn: '2026-06-20', prices: [{ startsOn: '2026-06-20', endsOn: null, amountCents: 45000 }] }),
        contrat({ contractId: 'k3', billingPeriod: 'quarterly', startsOn: '2026-10-01' }),
      ],
      '2026-11',
      '2026-11-17',
    )
    assert.deepEqual(
      lignes.map((ligne) => [ligne.label, ligne.detail, ligne.amountCents, ligne.pricing, ligne.upcoming]),
      [
        ['Frais fixes — Domiciliation', 'Contrat CT2611-0003, mois du 01/11/2026 au 30/11/2026', 3000, 'contract', false],
        ['Frais fixes — Bureau privatif', 'Contrat CT-B, mois du 20/11/2026 au 19/12/2026', 45000, 'contract', true],
      ],
    )
  })
})

describe('dépenses : prestations', () => {
  it('une réservation sans devis vivant, au prix annoncé ; sans prix, chiffrée sur la facture', () => {
    const lignes = serviceLines(
      [
        reservation(),
        reservation({ sourceId: 'b2', quote: null }),
        reservation({ sourceId: 'b3', status: 'cancelled' }),
        reservation({ sourceId: 'b4', coveredByProposal: true }),
        reservation({ sourceId: 'b5', clientId: null }),
        reservation({ sourceId: 'b6', startsAt: new Date('2026-10-30T08:00:00Z'), endsAt: new Date('2026-10-30T10:00:00Z') }),
      ],
      '2026-11',
      contexte(),
    )
    assert.deepEqual(
      lignes.map((ligne) => [ligne.key, ligne.amountCents, ligne.pricing, ligne.currency]),
      [
        ['booking|01999f00-0000-7000-8000-00000000b001', 9000, 'quote', 'EUR'],
        ['booking|b2', null, 'unpriced', null],
      ],
    )
    assert.equal(lignes[0]!.label, 'Réservation')
    assert.match(lignes[0]!.detail, /^Salle Mont Blanc — mardi 10 novembre 2026, 09:00 – 13:00$/)
  })

  it('une réservation plus tard dans le mois est à venir, et comptée', () => {
    const [ligne] = serviceLines(
      [reservation({ startsAt: new Date('2026-11-25T08:00:00Z'), endsAt: new Date('2026-11-25T12:00:00Z') })],
      '2026-11',
      contexte(),
    )
    assert.deepEqual([ligne!.upcoming, ligne!.amountCents], [true, 9000])
  })

  it('le mois est celui du centre : un pli ouvert le 1er à 0 h 30 à Paris est de novembre', () => {
    const tard = ouverture('2026-10-31T23:30:00Z')
    assert.equal(serviceLines([tard], '2026-10', contexte()).length, 0)
    assert.equal(serviceLines([tard], '2026-11', contexte()).length, 1)
  })

  it('les actes au tarif du centre, sans forfait', () => {
    const lignes = serviceLines(
      [ouverture('2026-11-03T09:00:00Z'), reexpedition('2026-11-04T09:00:00Z', 450)],
      '2026-11',
      contexte(),
    )
    assert.deepEqual(
      lignes.map((ligne) => [ligne.label, ligne.amountCents, ligne.feesCents, ligne.pricing, ligne.feesPending]),
      [
        ['Ouverture d’un pli', 300, null, 'catalogue', false],
        ['Réexpédition', 500, 450, 'catalogue', false],
      ],
    )
  })

  it('les premiers actes du mois sont compris dans le forfait, les suivants à son prix', () => {
    const lignes = serviceLines(
      [
        ouverture('2026-11-05T09:00:00Z'),
        ouverture('2026-11-03T09:00:00Z'),
        ouverture('2026-11-04T09:00:00Z'),
      ],
      '2026-11',
      contexte({
        pricing: { estimate: true, catalogue, subscriptions: { [CLIENT]: { mail_opening: [forfait()] } } },
      }),
    )
    const parJour = [...lignes].sort((a, b) => (a.day < b.day ? -1 : 1))
    assert.deepEqual(
      parJour.map((ligne) => [ligne.day, ligne.amountCents, ligne.pricing]),
      [
        ['2026-11-03', 0, 'included'],
        ['2026-11-04', 0, 'included'],
        ['2026-11-05', 200, 'subscription'],
      ],
    )
  })

  it('un forfait ne compte que pour son entreprise', () => {
    const autre = { ...ouverture('2026-11-03T09:00:00Z'), clientId: AUTRE }
    const [ligne] = serviceLines(
      [autre],
      '2026-11',
      contexte({ pricing: { estimate: true, catalogue, subscriptions: { [CLIENT]: { mail_opening: [forfait()] } } } }),
    )
    assert.deepEqual([ligne!.clientId, ligne!.amountCents, ligne!.pricing], [AUTRE, 300, 'catalogue'])
  })

  it('les pages au-delà de celles comprises, au prix de la page ; aucune ligne sans page en plus', () => {
    const lignes = serviceLines(
      [pages('2026-11-06T09:00:00Z', 12), pages('2026-11-07T09:00:00Z', 5)],
      '2026-11',
      contexte(),
    )
    assert.equal(lignes.length, 1)
    assert.deepEqual([lignes[0]!.quantity, lignes[0]!.amountCents, lignes[0]!.pricing], [7, 140, 'catalogue'])
    assert.match(lignes[0]!.detail, /^7 pages numérisées au-delà des 5 comprises/)
  })

  it('un forfait de pages remisé s’applique à la quantité, sans inclus', () => {
    const [ligne] = serviceLines(
      [pages('2026-11-06T09:00:00Z', 8)],
      '2026-11',
      contexte({
        pricing: {
          estimate: true,
          catalogue,
          subscriptions: {
            [CLIENT]: { mail_pages: [forfait({ id: 'forfait-pages', unitPriceCents: 15, discountBp: 1000, includedQuantity: 50 })] },
          },
        },
      }),
    )
    // 3 pages à 0,15 €, remise de 10 % : 0,405 € arrondi à 0,41 €.
    assert.deepEqual([ligne!.quantity, ligne!.amountCents, ligne!.pricing], [3, 41, 'subscription'])
  })

  it('une réexpédition sans affranchissement relevé le dit', () => {
    const [ligne] = serviceLines([reexpedition('2026-11-04T09:00:00Z', null)], '2026-11', contexte())
    assert.deepEqual([ligne!.amountCents, ligne!.feesCents, ligne!.feesPending], [500, null, true])
  })

  it('sans service au catalogue ni forfait, un acte n’a pas de prix inventé', () => {
    const [ligne] = serviceLines(
      [ouverture('2026-11-03T09:00:00Z')],
      '2026-11',
      contexte({ pricing: { estimate: true, catalogue: {}, subscriptions: {} } }),
    )
    assert.deepEqual([ligne!.amountCents, ligne!.pricing], [null, 'unpriced'])
  })

  it('le centre peut ne pas estimer les actes : comptés sans montant, l’affranchissement reste', () => {
    const lignes = serviceLines(
      [ouverture('2026-11-03T09:00:00Z'), reexpedition('2026-11-04T09:00:00Z', 450)],
      '2026-11',
      contexte({ pricing: noActPricing }),
    )
    assert.deepEqual(
      lignes.map((ligne) => [ligne.amountCents, ligne.feesCents, ligne.currency, ligne.pricing]),
      [
        [null, null, null, 'unpriced'],
        [null, 450, 'EUR', 'unpriced'],
      ],
    )
  })

  it('un pli retiré, une demande pas faite, un pli pas ouvert ne coûtent rien', () => {
    const retire = ouverture('2026-11-03T09:00:00Z', { removed: true })
    const fermee = ouverture('2026-11-03T09:00:00Z', { openedAt: null })
    const enCours = { ...reexpedition('2026-11-04T09:00:00Z', 450), status: 'pending' }
    assert.deepEqual(serviceLines([retire, fermee, enCours], '2026-11', contexte()), [])
  })
})

describe('dépenses : le mois', () => {
  it('frais fixes d’abord, prestations par jour ; totaux des montants connus, le reste compté à part', () => {
    const mois = buildExpenseMonth({
      month: '2026-11',
      contracts: [contrat({ startsOn: '2026-01-01' })],
      sources: [
        reexpedition('2026-11-12T09:00:00Z', 450),
        ouverture('2026-11-03T09:00:00Z'),
        reservation({ sourceId: 'b2', quote: null }),
        reexpedition('2026-11-13T09:00:00Z', null),
      ],
      context: contexte(),
    })
    assert.equal(mois.current, true)
    assert.deepEqual(
      mois.lines.map((ligne) => [ligne.kind, ligne.day]),
      [
        ['fixed', '2026-11-01'],
        ['mail_opening', '2026-11-03'],
        ['booking', '2026-11-10'],
        ['mail_forward', '2026-11-12'],
        ['mail_forward', '2026-11-13'],
      ],
    )
    // 30 € de frais fixes ; 3 € + 5 € + 4,50 € + 5 € de prestations.
    assert.deepEqual(mois.totals, [{ currency: 'EUR', fixedCents: 3000, servicesCents: 1750, totalCents: 4750 }])
    assert.deepEqual([mois.unpriced, mois.feesPending], [1, 1])
  })

  it('un mois passé n’est pas en cours ; un mois vide n’a pas de total', () => {
    const mois = buildExpenseMonth({ month: '2026-09', contracts: [], sources: [], context: contexte() })
    assert.deepEqual([mois.current, mois.lines, mois.totals, mois.unpriced], [false, [], [], 0])
  })

  it('les totaux se tiennent par devise', () => {
    const { totals } = expenseTotals([
      ...fixedFeeLines([contrat({ startsOn: '2026-01-01' })], '2026-11', '2026-11-17'),
      ...fixedFeeLines([contrat({ contractId: 'k-chf', currency: 'CHF', startsOn: '2026-01-01' })], '2026-11', '2026-11-17'),
    ])
    assert.deepEqual(
      totals.map((total) => [total.currency, total.totalCents]),
      [
        ['EUR', 3000],
        ['CHF', 3000],
      ],
    )
  })
})
