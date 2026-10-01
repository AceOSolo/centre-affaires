import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  priceOffer,
  type OfferCatalogue,
  type OfferCatalogueService,
  type OfferInput,
  type OfferLineInput,
} from './offres-prix.ts'

/**
 * Prix d'une offre groupée (R09, ADR 024) : total, remise, TVA par ligne,
 * arrondis, actes inclus, engagement.
 */

const STANDARD: OfferCatalogueService = {
  id: 'svc-standard',
  name: 'Standard téléphonique',
  nature: 'package',
  unit: 'month',
  unitPriceCents: 5_000,
  vatRateBp: 2_000,
  currency: 'EUR',
  isActive: true,
  archived: false,
}

const NUMERISATION: OfferCatalogueService = {
  id: 'svc-numerisation',
  name: 'Ouverture et numérisation d’un pli',
  nature: 'act',
  unit: 'unit',
  unitPriceCents: 300,
  vatRateBp: 2_000,
  currency: 'EUR',
  isActive: true,
  archived: false,
}

const catalogue: OfferCatalogue = {
  defaultVatRateBp: 2_000,
  rateCurrency: 'EUR',
  rateItems: [
    { resourceType: 'boite_aux_lettres', resourceId: null, unit: 'month', amountCents: 3_000 },
    { resourceType: 'bureau', resourceId: null, unit: 'month', amountCents: 60_000 },
    { resourceType: 'bureau', resourceId: 'bur-03', unit: 'month', amountCents: 75_000 },
    { resourceType: 'salle', resourceId: null, unit: 'half_day', amountCents: 9_000 },
  ],
  services: [STANDARD, NUMERISATION],
  resources: [
    { id: 'bur-03', code: 'BUR-03', name: 'Bureau 3', resourceType: 'bureau', archived: false },
    { id: 'bur-04', code: 'BUR-04', name: 'Bureau 4', resourceType: 'bureau', archived: false },
    { id: 'bur-09', code: 'BUR-09', name: 'Bureau 9', resourceType: 'bureau', archived: true },
  ],
}

let sequence = 0
function line(values: Partial<OfferLineInput>): OfferLineInput {
  sequence += 1
  return {
    id: `ligne-${String(sequence).padStart(3, '0')}`,
    position: sequence,
    resourceType: null,
    resourceId: null,
    serviceId: null,
    quantity: 1,
    unit: 'month',
    priceCents: null,
    discountBp: null,
    discountAmountCents: null,
    vatRateBp: null,
    ...values,
  }
}

function offer(items: OfferLineInput[], values: Partial<OfferInput> = {}): OfferInput {
  return { billingPeriod: 'monthly', commitmentMonths: null, currency: 'EUR', items, ...values }
}

const boite = () => line({ resourceType: 'boite_aux_lettres' })
const standard = (values: Partial<OfferLineInput> = {}) =>
  line({ serviceId: STANDARD.id, ...values })
const numerisations = (quantity: number, values: Partial<OfferLineInput> = {}) =>
  line({ serviceId: NUMERISATION.id, unit: 'unit', quantity, ...values })

describe('prix d’une offre groupée', () => {
  it('additionne les lignes au prix du catalogue et ajoute la TVA', () => {
    const quote = priceOffer(offer([boite(), standard(), numerisations(10)]), catalogue)

    assert.equal(quote.complete, true)
    assert.deepEqual(quote.problems, [])
    // 30,00 € de boîte aux lettres, 50,00 € de standard ; les dix numérisations
    // sont incluses.
    assert.equal(quote.totalExclTaxCents, 8_000)
    assert.equal(quote.totalTaxCents, 1_600)
    assert.equal(quote.totalInclTaxCents, 9_600)
    assert.deepEqual(quote.vatBreakdown, [
      { vatRateBp: 2_000, taxableAmountCents: 8_000, vatAmountCents: 1_600 },
    ])
    assert.deepEqual(
      quote.lines.map((priced) => [priced.kind, priced.priceSource, priced.netAmountCents]),
      [
        ['rent', 'catalogue', 3_000],
        ['package', 'catalogue', 5_000],
        ['act', 'catalogue', 0],
      ],
    )
  })

  it('porte les actes inclus à zéro, et dit leur prix au-delà', () => {
    const quote = priceOffer(offer([numerisations(10, { discountBp: 5_000 })]), catalogue)
    const [actes] = quote.lines

    assert.equal(actes.kind, 'act')
    assert.equal(actes.includedActs, 10)
    assert.equal(actes.netAmountCents, 0)
    assert.equal(actes.vatAmountCents, 0)
    // 3,00 € l'acte, remise de 50 % : 1,50 € au-delà des dix.
    assert.equal(actes.extraActNetCents, 150)
    // Les actes inclus comptent dans le prix catalogue de l'ensemble.
    assert.equal(quote.listAmountCents, 3_000)
    assert.equal(quote.savingsCents, 3_000)
    assert.deepEqual(quote.vatBreakdown, [])
  })

  it('applique un prix forfaitaire et mesure la remise par rapport au catalogue', () => {
    const quote = priceOffer(offer([line({ resourceType: 'bureau', priceCents: 50_000 }), standard()]), catalogue)

    assert.equal(quote.lines[0].priceSource, 'offer')
    assert.equal(quote.lines[0].unitPriceCents, 50_000)
    assert.equal(quote.lines[0].catalogueUnitPriceCents, 60_000)
    assert.equal(quote.totalExclTaxCents, 55_000)
    assert.equal(quote.listAmountCents, 65_000)
    assert.equal(quote.savingsCents, 10_000)
  })

  it('arrondit une remise en pourcentage une seule fois, à la règle de la base', () => {
    // 3 × 19,99 € = 59,97 € ; 12,5 % de remise : 52,47375 € → 52,47 €.
    const quote = priceOffer(
      offer([standard({ quantity: 3, priceCents: 1_999, discountBp: null })]),
      catalogue,
    )
    assert.equal(quote.lines[0].netAmountCents, 5_997)

    const remise = priceOffer(offer([standard({ quantity: 3, discountBp: 1_250 })]), {
      ...catalogue,
      services: [{ ...STANDARD, unitPriceCents: 1_999 }, NUMERISATION],
    })
    assert.equal(remise.lines[0].netAmountCents, 5_247)
    // 1,25 € à 50 % : 0,625 € → 0,63 €, la moitié s'éloigne de zéro.
    const moitie = priceOffer(offer([standard({ discountBp: 5_000 })]), {
      ...catalogue,
      services: [{ ...STANDARD, unitPriceCents: 125 }, NUMERISATION],
    })
    assert.equal(moitie.lines[0].netAmountCents, 63)
  })

  it('retranche une remise en montant par période', () => {
    const quote = priceOffer(
      offer([line({ resourceType: 'bureau', quantity: 2, discountAmountCents: 5_000 })]),
      catalogue,
    )
    // 2 × 600,00 € − 50,00 € = 1 150,00 €.
    assert.equal(quote.totalExclTaxCents, 115_000)
    assert.equal(quote.savingsCents, 5_000)
  })

  it('signale une remise qui dépasse le prix, et la sort du total', () => {
    const quote = priceOffer(
      offer([boite(), standard({ discountAmountCents: 6_000 })]),
      catalogue,
    )
    assert.equal(quote.complete, false)
    assert.equal(quote.lines[1].netAmountCents, null)
    assert.match(quote.lines[1].problem ?? '', /remise dépasse/)
    assert.equal(quote.totalExclTaxCents, 3_000)
    assert.equal(quote.savingsCents, null)
    assert.deepEqual(quote.problems, ['Standard téléphonique : la remise dépasse le prix de la ligne.'])
  })

  it('calcule la TVA par taux sur la somme des bases et répartit l’écart d’arrondi', () => {
    // Trois lignes de 0,33 € à 20 % : 0,99 € de base, 0,198 € → 0,20 € de TVA.
    // Ligne à ligne, 0,066 € → 0,07 € chacune, soit 0,21 € : l'écart d'un
    // centime revient à la première ligne de plus forte valeur.
    const lignes = [1, 2, 3].map(() => standard({ priceCents: 33 }))
    const quote = priceOffer(offer(lignes), catalogue)

    assert.equal(quote.totalExclTaxCents, 99)
    assert.equal(quote.totalTaxCents, 20)
    assert.deepEqual(
      quote.lines.map((priced) => priced.vatAmountCents),
      [6, 7, 7],
    )
    assert.equal(
      quote.lines.reduce((total, priced) => total + (priced.vatAmountCents ?? 0), 0),
      quote.totalTaxCents,
    )
  })

  it('prend le taux de la ligne, puis celui du service, puis celui du centre', () => {
    const quote = priceOffer(
      offer([
        boite(),
        standard({ vatRateBp: 1_000 }),
        line({ serviceId: 'svc-repas', unit: 'unit' }),
      ]),
      {
        ...catalogue,
        defaultVatRateBp: 2_000,
        services: [
          STANDARD,
          NUMERISATION,
          { ...STANDARD, id: 'svc-repas', name: 'Plateau-repas', unit: 'unit', unitPriceCents: 1_500, vatRateBp: 550 },
        ],
      },
    )
    assert.deepEqual(
      quote.lines.map((priced) => priced.vatRateBp),
      [2_000, 1_000, 550],
    )
    assert.deepEqual(quote.vatBreakdown, [
      { vatRateBp: 2_000, taxableAmountCents: 3_000, vatAmountCents: 600 },
      { vatRateBp: 1_000, taxableAmountCents: 5_000, vatAmountCents: 500 },
      // 15,00 € à 5,5 % : 0,825 € → 0,83 €.
      { vatRateBp: 550, taxableAmountCents: 1_500, vatAmountCents: 83 },
    ])
    assert.equal(quote.totalInclTaxCents, 9_500 + 1_183)
  })

  it('préfère le prix nominatif d’une ressource à celui de son type', () => {
    const quote = priceOffer(
      offer([line({ resourceId: 'bur-03' }), line({ resourceId: 'bur-04' })]),
      catalogue,
    )
    assert.deepEqual(
      quote.lines.map((priced) => [priced.label, priced.unitPriceCents]),
      [
        ['Bureau 3 (BUR-03)', 75_000],
        ['Bureau 4 (BUR-04)', 60_000],
      ],
    )
  })

  it('signale une ligne sans prix au lieu d’en inventer un', () => {
    const quote = priceOffer(
      offer([boite(), line({ resourceType: 'salle', unit: 'hour', quantity: 5 })]),
      catalogue,
    )
    assert.equal(quote.complete, false)
    assert.equal(quote.lines[1].unitPriceCents, null)
    assert.equal(quote.lines[1].netAmountCents, null)
    assert.match(quote.problems[0], /^Salle de réunion, au choix du centre : aucun prix/)
    assert.equal(quote.totalExclTaxCents, 3_000)
    assert.equal(quote.listAmountCents, null)

    // Un prix forfaitaire comble le manque.
    const forfait = priceOffer(
      offer([line({ resourceType: 'salle', unit: 'hour', quantity: 5, priceCents: 2_000 })]),
      catalogue,
    )
    assert.equal(forfait.complete, true)
    assert.equal(forfait.totalExclTaxCents, 10_000)
    assert.equal(forfait.savingsCents, null)
  })

  it('refuse une remise en montant sur un acte', () => {
    const quote = priceOffer(offer([numerisations(10, { discountAmountCents: 100 })]), catalogue)
    assert.equal(quote.complete, false)
    assert.match(quote.lines[0].problem ?? '', /pourcentage/)
  })

  it('signale un service archivé ou une ressource archivée, mais chiffre un service qui n’est plus proposé', () => {
    const quote = priceOffer(offer([standard(), line({ resourceId: 'bur-09' })]), {
      ...catalogue,
      services: [{ ...STANDARD, isActive: false }, NUMERISATION],
    })
    assert.equal(quote.lines[0].netAmountCents, 5_000)
    assert.match(quote.lines[0].notice ?? '', /plus proposé/)
    assert.match(quote.lines[1].problem ?? '', /archivée/)

    const archive = priceOffer(offer([standard()]), {
      ...catalogue,
      services: [{ ...STANDARD, archived: true }],
    })
    assert.match(archive.lines[0].problem ?? '', /archivé/)
  })

  it('signale une devise différente de celle de l’offre', () => {
    const quote = priceOffer(offer([standard(), boite()], { currency: 'CHF' }), catalogue)
    assert.equal(quote.complete, false)
    assert.equal(quote.problems.length, 2)
  })

  it('annonce le total sur la durée d’engagement quand elle compte des périodes entières', () => {
    const mensuelle = priceOffer(offer([boite(), standard()], { commitmentMonths: 12 }), catalogue)
    assert.deepEqual(mensuelle.commitment, {
      months: 12,
      periods: 12,
      totalExclTaxCents: 96_000,
      totalInclTaxCents: 115_200,
    })

    const trimestrielle = priceOffer(
      offer([boite(), standard()], { billingPeriod: 'quarterly', commitmentMonths: 12 }),
      catalogue,
    )
    assert.equal(trimestrielle.periodMonths, 3)
    assert.equal(trimestrielle.commitment?.periods, 4)

    const bancale = priceOffer(
      offer([boite()], { billingPeriod: 'quarterly', commitmentMonths: 5 }),
      catalogue,
    )
    assert.equal(bancale.commitment, null)
    assert.equal(priceOffer(offer([boite()]), catalogue).commitment, null)
  })

  it('range les lignes par position', () => {
    const premiere = line({ resourceType: 'boite_aux_lettres', position: 2 })
    const seconde = line({ serviceId: STANDARD.id, position: 1 })
    const quote = priceOffer(offer([premiere, seconde]), catalogue)
    assert.deepEqual(
      quote.lines.map((priced) => priced.label),
      ['Standard téléphonique', 'Boîte aux lettres, au choix du centre'],
    )
  })

  it('ne dit pas complète une offre sans ligne', () => {
    const quote = priceOffer(offer([]), catalogue)
    assert.equal(quote.complete, false)
    assert.equal(quote.totalInclTaxCents, 0)
    assert.equal(quote.listAmountCents, 0)
  })
})
