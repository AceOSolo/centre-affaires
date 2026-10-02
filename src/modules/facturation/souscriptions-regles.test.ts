import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  cancellationRefusal,
  checkSubscriptionEnd,
  planConditionChange,
  priceActs,
  readSubscriptionForm,
  readTerms,
  sameTerms,
  subscriptionHold,
  subscriptionState,
  subscriptionValues,
  type ActOccurrence,
  type ActSubscription,
  type SubscribableService,
} from './souscriptions-regles.ts'

/**
 * Services souscrits (R18, ADR 024) : saisie, changement de conditions, fin,
 * annulation, et valorisation des actes avec leurs quantités incluses.
 */

const FORFAIT: SubscribableService = { id: 'svc-standard', nature: 'package', isActive: true, archived: false }
const ACTE: SubscribableService = { id: 'svc-pli', nature: 'act', isActive: true, archived: false }
const ANCIEN: SubscribableService = { id: 'svc-ancien', nature: 'package', isActive: false, archived: false }
const context = { services: [FORFAIT, ACTE, ANCIEN], contractIds: ['k-durand'] }

function form(values: Record<string, string>) {
  const data = new FormData()
  for (const [key, value] of Object.entries(values)) data.set(key, value)
  return data
}

const forfait = (values: Record<string, string> = {}) =>
  form({
    serviceId: FORFAIT.id,
    quantity: '2',
    unitPrice: '50,00',
    discountKind: 'none',
    vatRate: '20',
    startsOn: '2026-10-01',
    ...values,
  })

describe('état d’une souscription', () => {
  const ligne = { startsOn: '2026-10-01', endsOn: '2026-12-31', deletedAt: null }

  it('est à venir avant son premier jour, en cours jusqu’à son dernier, terminée ensuite', () => {
    assert.equal(subscriptionState(ligne, '2026-09-30'), 'upcoming')
    assert.equal(subscriptionState(ligne, '2026-10-01'), 'active')
    assert.equal(subscriptionState(ligne, '2026-12-31'), 'active')
    assert.equal(subscriptionState(ligne, '2027-01-01'), 'ended')
    assert.equal(subscriptionState({ ...ligne, endsOn: null }, '2030-01-01'), 'active')
  })

  it('est annulée une fois archivée, quelles que soient ses dates', () => {
    assert.equal(subscriptionState({ ...ligne, deletedAt: new Date() }, '2026-11-01'), 'cancelled')
  })

  it('attend l’activation d’un contrat brouillon, ne se facture plus sous un contrat archivé (ADR 035)', () => {
    assert.equal(subscriptionHold(null), null)
    assert.equal(subscriptionHold({ status: 'active', archived: false }), null)
    assert.equal(subscriptionHold({ status: 'terminated', archived: false }), null)
    assert.equal(subscriptionHold({ status: 'draft', archived: false }), 'contract-draft')
    assert.equal(subscriptionHold({ status: 'draft', archived: true }), 'contract-archived')
  })
})

describe('souscrire un service', () => {
  it('lit un forfait : quantité, prix figé, remise en pourcentage, TVA', () => {
    const read = readSubscriptionForm(
      forfait({ discountKind: 'percent', discountPercent: '12,5', vatRate: '5,5', contractId: 'k-durand' }),
      context,
    )
    assert.equal(read.fieldErrors, undefined)
    assert.deepEqual(read.input, {
      serviceId: FORFAIT.id,
      contractId: 'k-durand',
      quantity: 2,
      unitPriceCents: 5_000,
      discountBp: 1_250,
      discountAmountCents: null,
      vatRateBp: 550,
      includedQuantity: null,
      startsOn: '2026-10-01',
      endsOn: null,
      notes: null,
    })
  })

  it('souscrit un acte en quantité 1, avec ses actes inclus par période', () => {
    const read = readSubscriptionForm(
      form({
        serviceId: ACTE.id,
        quantity: '7',
        unitPrice: '3',
        discountKind: 'none',
        vatRate: '20',
        includedQuantity: '10',
        startsOn: '2026-10-01',
        endsOn: '2027-09-30',
      }),
      context,
    )
    assert.equal(read.fieldErrors, undefined)
    assert.equal(read.input?.quantity, 1)
    assert.equal(read.input?.unitPriceCents, 300)
    assert.equal(read.input?.includedQuantity, 10)
    assert.equal(read.input?.endsOn, '2027-09-30')
  })

  it('compte zéro acte inclus quand le champ est vide', () => {
    const read = readSubscriptionForm(
      form({ serviceId: ACTE.id, unitPrice: '3,00', vatRate: '20', startsOn: '2026-10-01' }),
      context,
    )
    assert.equal(read.fieldErrors, undefined)
    assert.equal(read.input?.includedQuantity, 0)
  })

  it('refuse une remise en montant sur un acte', () => {
    const read = readSubscriptionForm(
      form({
        serviceId: ACTE.id,
        unitPrice: '3,00',
        discountKind: 'amount',
        discountAmount: '1,00',
        vatRate: '20',
        startsOn: '2026-10-01',
      }),
      context,
    )
    assert.match(read.fieldErrors?.discountAmount ?? '', /pourcentage/)
  })

  it('refuse une remise en montant qui dépasse la période', () => {
    // 2 × 50,00 € = 100,00 € par période : une remise de 120,00 € la rendrait négative.
    const read = readSubscriptionForm(
      forfait({ discountKind: 'amount', discountAmount: '120,00' }),
      context,
    )
    assert.match(read.fieldErrors?.discountAmount ?? '', /dépasse/)
    assert.equal(
      readSubscriptionForm(forfait({ discountKind: 'amount', discountAmount: '100,00' }), context)
        .fieldErrors,
      undefined,
    )
  })

  it('rend toutes les erreurs d’un coup', () => {
    const read = readSubscriptionForm(
      form({
        serviceId: 'inconnu',
        contractId: 'k-autre-client',
        quantity: '0',
        unitPrice: 'cinquante',
        discountKind: 'percent',
        discountPercent: '120',
        vatRate: '',
        startsOn: '2026-02-30',
        endsOn: 'demain',
      }),
      context,
    )
    assert.deepEqual(Object.keys(read.fieldErrors ?? {}).sort(), [
      'contractId',
      'discountPercent',
      'endsOn',
      'quantity',
      'serviceId',
      'startsOn',
      'unitPrice',
      'vatRate',
    ])
    // La saisie est rendue telle quelle, pour être réaffichée.
    assert.equal(read.values.unitPrice, 'cinquante')
  })

  it('refuse un service qui n’est plus proposé, et une fin avant le début', () => {
    const read = readSubscriptionForm(
      forfait({ serviceId: ANCIEN.id, endsOn: '2026-09-30' }),
      context,
    )
    assert.match(read.fieldErrors?.serviceId ?? '', /plus proposé/)
    assert.match(read.fieldErrors?.endsOn ?? '', /précéder/)
  })
})

describe('conditions d’une souscription', () => {
  const terms = (values: Record<string, string>) =>
    readTerms(subscriptionValues(form({ quantity: '1', unitPrice: '50', vatRate: '20', ...values })), 'package')
      .terms

  it('reconnaît des conditions inchangées', () => {
    const a = terms({ discountKind: 'percent', discountPercent: '10' })
    const b = terms({ discountKind: 'percent', discountPercent: '10,00' })
    assert.ok(a && b && sameTerms(a, b))
    const c = terms({ quantity: '2' })
    assert.ok(a && c && !sameTerms(a, c))
  })
})

describe('changer les conditions à une date d’effet', () => {
  const courante = { startsOn: '2026-01-01', endsOn: null }

  it('met fin la veille et souscrit à nouveau le jour même', () => {
    assert.deepEqual(planConditionChange(courante, '2026-10-01', '2026-09-30'), {
      ok: true,
      mode: 'split',
      previousEndsOn: '2026-09-30',
      nextStartsOn: '2026-10-01',
      nextEndsOn: null,
    })
  })

  it('garde la fin prévue sur la nouvelle souscription', () => {
    const plan = planConditionChange({ startsOn: '2026-01-01', endsOn: '2026-12-31' }, '2026-07-01', null)
    assert.ok(plan.ok && plan.mode === 'split' && plan.nextEndsOn === '2026-12-31')
  })

  it('remplace une souscription dont rien n’a été facturé, au premier jour', () => {
    assert.deepEqual(planConditionChange(courante, '2026-01-01', null), {
      ok: true,
      mode: 'replace',
      nextStartsOn: '2026-01-01',
      nextEndsOn: null,
    })
  })

  it('refuse une date hors de la souscription', () => {
    assert.equal(planConditionChange(courante, '2025-12-31', null).ok, false)
    assert.equal(
      planConditionChange({ startsOn: '2026-01-01', endsOn: '2026-06-30' }, '2026-07-01', null).ok,
      false,
    )
    assert.equal(planConditionChange(courante, '2026-13-01', null).ok, false)
  })

  it('refuse un jour déjà facturé aux anciennes conditions', () => {
    const plan = planConditionChange(courante, '2026-09-15', '2026-09-30')
    assert.equal(plan.ok, false)
    assert.match(plan.ok ? '' : plan.error, /au plus tôt le 1 oct\. 2026/)
    // Le lendemain du dernier jour facturé est permis.
    assert.equal(planConditionChange(courante, '2026-10-01', '2026-09-30').ok, true)
  })
})

describe('mettre fin à une souscription', () => {
  const courante = { startsOn: '2026-01-01', endsOn: null }

  it('accepte une fin au plus tôt le dernier jour facturé', () => {
    assert.equal(checkSubscriptionEnd(courante, '2026-09-30', '2026-09-30'), null)
    assert.equal(checkSubscriptionEnd(courante, '2026-12-31', '2026-09-30'), null)
    assert.match(checkSubscriptionEnd(courante, '2026-09-29', '2026-09-30') ?? '', /avoir/)
  })

  it('renvoie vers l’annulation pour une fin avant le premier jour', () => {
    assert.match(checkSubscriptionEnd(courante, '2025-12-31', null) ?? '', /annulez/)
    assert.equal(checkSubscriptionEnd(courante, '2026-01-01', null), null)
  })

  it('accepte de retirer la date de fin', () => {
    assert.equal(checkSubscriptionEnd({ startsOn: '2026-01-01', endsOn: '2026-06-30' }, null, '2026-06-30'), null)
  })

  it('n’annule qu’une souscription jamais facturée', () => {
    assert.equal(cancellationRefusal(0), null)
    assert.match(cancellationRefusal(1) ?? '', /mettez-y fin/)
  })
})

describe('valorisation des actes et quantités incluses', () => {
  const souscription = (values: Partial<ActSubscription> = {}): ActSubscription => ({
    id: 'sub-1',
    startsOn: '2026-01-01',
    endsOn: null,
    unitPriceCents: 250,
    discountBp: null,
    vatRateBp: 2_000,
    currency: 'EUR',
    includedQuantity: 3,
    ...values,
  })
  const catalogue = { id: 'svc-pli', unitPriceCents: 300, vatRateBp: 2_000, currency: 'EUR' }

  /** Un acte par jour de septembre, à 9h UTC, dans le désordre. */
  const actes = (jours: number[]): ActOccurrence[] =>
    jours.map((jour) => {
      const day = `2026-09-${String(jour).padStart(2, '0')}`
      return { id: `pli-${day}`, day, at: new Date(`${day}T09:00:00Z`) }
    })

  it('inclut les premiers actes de la période, par ordre chronologique, puis facture au prix figé', () => {
    const valorises = priceActs(actes([12, 3, 25, 7, 18]), [souscription()], catalogue)
    assert.deepEqual(
      valorises.map((acte) => [acte.actId.slice(-2), acte.source, acte.netAmountCents]),
      [
        ['03', 'included', 0],
        ['07', 'included', 0],
        ['12', 'included', 0],
        ['18', 'subscription', 250],
        ['25', 'subscription', 250],
      ],
    )
    assert.ok(valorises.every((acte) => acte.subscriptionId === 'sub-1'))
  })

  it('applique la remise de la souscription aux actes au-delà des inclus', () => {
    // 2,50 € à 15 % : 2,125 € → 2,13 €.
    const valorises = priceActs(actes([1, 2]), [souscription({ includedQuantity: 1, discountBp: 1_500 })], catalogue)
    assert.deepEqual(
      valorises.map((acte) => acte.netAmountCents),
      [0, 213],
    )
  })

  it('facture au prix du catalogue hors de la souscription', () => {
    const valorises = priceActs(
      actes([5, 20]),
      [souscription({ startsOn: '2026-09-15', includedQuantity: 0 })],
      catalogue,
    )
    assert.deepEqual(
      valorises.map((acte) => [acte.source, acte.netAmountCents, acte.subscriptionId]),
      [
        ['catalogue', 300, null],
        ['subscription', 250, 'sub-1'],
      ],
    )
  })

  it('ne valorise pas un acte sans souscription ni service au catalogue', () => {
    const [acte] = priceActs(actes([5]), [], null)
    assert.equal(acte.source, 'unpriced')
    assert.equal(acte.netAmountCents, null)
  })

  it('compte les inclus de chaque souscription à part, et choisit la plus avantageuse', () => {
    const contrat = souscription({ id: 'sub-contrat', includedQuantity: 1, unitPriceCents: 200 })
    const libre = souscription({ id: 'sub-libre', includedQuantity: 2, unitPriceCents: 280 })
    const valorises = priceActs(actes([1, 2, 3, 4, 5]), [libre, contrat], catalogue)
    assert.deepEqual(
      valorises.map((acte) => [acte.source, acte.subscriptionId, acte.netAmountCents]),
      [
        // D'abord les inclus, la moins chère d'abord à égalité.
        ['included', 'sub-contrat', 0],
        ['included', 'sub-libre', 0],
        ['included', 'sub-libre', 0],
        // Puis le prix le plus bas.
        ['subscription', 'sub-contrat', 200],
        ['subscription', 'sub-contrat', 200],
      ],
    )
  })

  it('ne compte aucun inclus sur une souscription qui n’en prévoit pas', () => {
    const valorises = priceActs(actes([1]), [souscription({ includedQuantity: null })], catalogue)
    assert.equal(valorises[0].source, 'subscription')
  })
})
