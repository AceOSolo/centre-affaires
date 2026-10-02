import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { priceOffer } from '../facturation/offres-prix.ts'
import type { RateCandidate } from '../facturation/tarifs.ts'
import { linesTotals } from './lignes.ts'
import {
  actFieldName,
  actToFormValues,
  proposeContractFromOffer,
  readActsForm,
  type OfferForContract,
  type OfferItemForContract,
  type OfferService,
} from './offres.ts'

/**
 * Un contrat tiré d'une offre groupée (R09, ADR 024) : la proposition
 * pré-remplie à l'écran avant d'être ajustée puis écrite.
 */
const BUREAU = { id: '01a00000-0000-7000-8000-0000000000b1', code: 'BUR-A1', name: 'Bureau 1', resourceType: 'bureau' as const }
const BAL = { id: '01a00000-0000-7000-8000-0000000000b2', code: 'BAL-12', name: 'Boîte 12', resourceType: 'boite_aux_lettres' as const }

const service = (overrides: Partial<OfferService> = {}): OfferService => ({
  id: '01a00000-0000-7000-8000-0000000000e1',
  name: 'Standard téléphonique',
  nature: 'package',
  unit: 'month',
  unitPriceCents: 5_000,
  vatRateBp: 2000,
  currency: 'EUR',
  isActive: true,
  deletedAt: null,
  ...overrides,
})

let sequence = 0
const item = (overrides: Partial<OfferItemForContract> = {}): OfferItemForContract => ({
  id: `01a00000-0000-7000-8000-${String(++sequence).padStart(12, '0')}`,
  position: 0,
  quantity: 1,
  unit: 'month',
  priceCents: null,
  discountBp: null,
  discountAmountCents: null,
  vatRateBp: null,
  resourceType: null,
  resource: null,
  service: null,
  ...overrides,
})

const offre = (items: OfferItemForContract[], overrides: Partial<OfferForContract> = {}): OfferForContract => ({
  id: '01a00000-0000-7000-8000-0000000000f1',
  name: 'Domiciliation Premium',
  billingPeriod: 'monthly',
  commitmentMonths: 12,
  currency: 'EUR',
  items,
  ...overrides,
})

const grille: RateCandidate[] = [
  { resourceType: 'bureau', resourceId: null, unit: 'month', amountCents: 80_000 },
  { resourceType: 'bureau', resourceId: BUREAU.id, unit: 'month', amountCents: 90_000 },
  { resourceType: 'boite_aux_lettres', resourceId: null, unit: 'month', amountCents: 3_000 },
]
const contexte = { rates: grille, defaultVatRateBp: 2000 }

describe('proposition de contrat depuis une offre', () => {
  it('reprend la période, l’engagement et une ligne par ressource, au prix de la grille', () => {
    const proposal = proposeContractFromOffer(
      offre([item({ resource: BUREAU, position: 0 }), item({ resourceType: 'bureau', quantity: 2, position: 1, discountBp: 1000 })]),
      contexte,
    )
    assert.equal(proposal.billingPeriod, 'monthly')
    assert.equal(proposal.commitmentMonths, 12)
    assert.equal(proposal.contractType, 'bureau')
    assert.equal(proposal.resourceId, BUREAU.id)
    assert.deepEqual(
      proposal.lines.map((line) => [line.target, line.description, line.quantity, line.unitPriceCents, line.discountBp]),
      [
        // La ligne nominative de la grille l'emporte sur celle du type.
        [{ kind: 'resource', resourceId: BUREAU.id }, 'Bureau Bureau 1 (BUR-A1)', 1, 90_000, null],
        [{ kind: 'type', resourceType: 'bureau' }, 'Bureau', 2, 80_000, 1000],
      ],
    )
    // Le montant du contrat découle des lignes : 900 + 2 × 800 − 10 %.
    assert.equal(linesTotals(proposal.lines).recurringNetCents, 90_000 + 144_000)
    assert.deepEqual(proposal.warnings, [])
  })

  it('garde un prix imposé par l’offre et la traçabilité de la ligne d’offre', () => {
    const imposee = item({ resource: BUREAU, priceCents: 85_000, vatRateBp: 1000 })
    const [line] = proposeContractFromOffer(offre([imposee]), contexte).lines
    assert.equal(line.unitPriceCents, 85_000)
    assert.equal(line.vatRateBp, 1000)
    assert.equal(line.offerItemId, imposee.id)
    assert.equal(line.isRecurring, true)
  })

  it('fait d’un forfait une ligne visant le service, et d’un acte une souscription avec ses inclus', () => {
    const standard = service()
    const numerisation = service({
      id: '01a00000-0000-7000-8000-0000000000e2',
      name: 'Numérisation',
      nature: 'act',
      unit: 'unit',
      unitPriceCents: 150,
    })
    const acte = item({ service: numerisation, quantity: 10, discountBp: 2000 })
    const proposal = proposeContractFromOffer(
      offre([item({ resource: BAL }), item({ service: standard }), acte]),
      contexte,
    )
    assert.equal(proposal.contractType, 'domiciliation')
    assert.deepEqual(
      proposal.lines.map((line) => [line.target.kind, line.description, line.unitPriceCents]),
      [
        ['resource', 'Boîte aux lettres Boîte 12 (BAL-12)', 3_000],
        ['service', 'Standard téléphonique', 5_000],
      ],
    )
    assert.deepEqual(proposal.subscriptions, [
      {
        offerItemId: acte.id,
        serviceId: numerisation.id,
        serviceName: 'Numérisation',
        // Dix actes inclus par période, au-delà au prix du catalogue, remisé.
        includedQuantity: 10,
        unitPriceCents: 150,
        discountBp: 2000,
        discountAmountCents: null,
        vatRateBp: 2000,
      },
    ])
  })

  it('reprend la quantité de l’offre, due par période : aucun multiplicateur caché (ADR 024)', () => {
    // Un bureau dans une offre trimestrielle s'écrit trois mois à l'écran des
    // offres ; le contrat le facture tel quel.
    const proposal = proposeContractFromOffer(
      offre([item({ resource: BUREAU, quantity: 3, discountAmountCents: 15_000 })], {
        billingPeriod: 'quarterly',
      }),
      contexte,
    )
    const [line] = proposal.lines
    assert.equal(line.quantity, 3)
    assert.equal(line.discountAmountCents, 15_000)
    assert.equal(linesTotals(proposal.lines).recurringNetCents, 3 * 90_000 - 15_000)
  })

  it('tombe sur le prix par période que l’écran des offres annonce (priceOffer)', () => {
    const items = [
      item({ resource: BUREAU, quantity: 3, discountBp: 1_000 }),
      item({ position: 1, service: service(), quantity: 3, discountAmountCents: 1_000 }),
      item({ position: 2, resourceType: 'boite_aux_lettres', quantity: 3, priceCents: 2_500 }),
    ]
    const offer = offre(items, { billingPeriod: 'quarterly' })
    const proposal = proposeContractFromOffer(offer, contexte)
    const quote = priceOffer(
      {
        billingPeriod: offer.billingPeriod,
        commitmentMonths: offer.commitmentMonths,
        currency: offer.currency,
        items: items.map((line) => ({
          id: line.id,
          position: line.position,
          resourceType: line.resourceType,
          resourceId: line.resource?.id ?? null,
          serviceId: line.service?.id ?? null,
          quantity: line.quantity,
          unit: line.unit,
          priceCents: line.priceCents,
          discountBp: line.discountBp,
          discountAmountCents: line.discountAmountCents,
          vatRateBp: line.vatRateBp,
        })),
      },
      {
        defaultVatRateBp: contexte.defaultVatRateBp,
        rateItems: contexte.rates,
        rateCurrency: 'EUR',
        services: [{ ...service(), archived: false }],
        resources: [{ ...BUREAU, archived: false }],
      },
    )
    assert.equal(quote.complete, true)
    assert.equal(linesTotals(proposal.lines).recurringNetCents, quote.totalExclTaxCents)
  })

  it('n’invente aucun prix : une ligne sans prix de grille est proposée à 0 € et signalée', () => {
    const proposal = proposeContractFromOffer(offre([item({ resourceType: 'salle', unit: 'day' })]), contexte)
    assert.equal(proposal.lines[0].unitPriceCents, 0)
    assert.equal(proposal.contractType, 'autre')
    assert.equal(proposal.warnings.length, 1)
    assert.match(proposal.warnings[0], /Aucun prix de grille/)
  })

  it('signale un service archivé ou dans une autre devise', () => {
    const proposal = proposeContractFromOffer(
      offre([item({ service: service({ deletedAt: new Date(), currency: 'CHF' }) })]),
      contexte,
    )
    assert.equal(proposal.warnings.length, 2)
  })

  it('relit à l’identique un acte inclus ajusté à l’écran, et refuse une saisie fautive', () => {
    const acte = {
      offerItemId: '01a00000-0000-7000-8000-0000000000a1',
      serviceId: '01a00000-0000-7000-8000-0000000000e2',
      serviceName: 'Numérisation',
      includedQuantity: 10,
      unitPriceCents: 150,
      discountBp: 2000,
      discountAmountCents: null,
      vatRateBp: 2000,
    }
    const champs = new Map(
      Object.entries(actToFormValues('0', acte)).map(([field, value]) => [
        actFieldName('0', field as never),
        value,
      ]),
    )
    const lu = readActsForm(['0'], (name) => champs.get(name) ?? '')
    assert.ok(lu.ok)
    assert.deepEqual(lu.subscriptions, [acte])

    champs.set(actFieldName('0', 'includedQuantity'), '-1')
    champs.set(actFieldName('0', 'discountKind'), 'amount')
    champs.set(actFieldName('0', 'discount'), '2,00')
    const refuse = readActsForm(['0'], (name) => champs.get(name) ?? '')
    assert.ok(!refuse.ok)
    assert.deepEqual(Object.keys(refuse.fieldErrors).sort(), ['acte-0-discount', 'acte-0-includedQuantity'])
  })

  it('suit l’ordre des lignes de l’offre', () => {
    const proposal = proposeContractFromOffer(
      offre([item({ service: service(), position: 2 }), item({ resource: BUREAU, position: 1 })]),
      contexte,
    )
    assert.deepEqual(proposal.lines.map((line) => line.target.kind), ['resource', 'service'])
  })
})
