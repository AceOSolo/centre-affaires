import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { ActSubscription } from '../facturation/souscriptions-regles.ts'
import {
  announceNextAct,
  announcementText,
  canClientCancelRequest,
  clientMailQuery,
  clientRequestOptions,
  forwardAddressLines,
  isPendingRequest,
  pageCount,
  readClientMailFilters,
  readClientNote,
  readForwardAddress,
  readPage,
  readPostage,
  readRefusalReason,
  readRequestFilters,
  readTrackingNumber,
  requestFiltersQuery,
  requestSteps,
  sameForwardAddress,
  staffRequestActions,
  type ForwardAddress,
} from './demandes-regles.ts'

/**
 * Règles des demandes sur un pli (R21, R24, ADR 037) : ce que le client peut
 * demander, ce que l'accueil peut en faire, l'adresse figée d'une
 * réexpédition, les saisies, les filtres, le suivi daté et le prix annoncé.
 */

const fermé = { status: 'received' as const, openedAt: null, forwarded: false, pendingKinds: [] }
const ouvert = { status: 'opened' as const, openedAt: new Date('2026-09-03T09:00:00Z'), forwarded: false, pendingKinds: [] }

describe('ce que le client peut demander sur un pli', () => {
  it('ouvrir un pli fermé, réexpédier ; pas de numérisation seule tant qu’il est fermé', () => {
    assert.deepEqual(clientRequestOptions(fermé), { open_and_scan: true, scan: false, forward: true })
  })

  it('numériser de nouveau un pli ouvert, le réexpédier ; plus de demande d’ouverture', () => {
    assert.deepEqual(clientRequestOptions(ouvert), { open_and_scan: false, scan: true, forward: true })
  })

  it('une seule demande en cours par nature : la seconde n’est pas proposée', () => {
    assert.deepEqual(
      clientRequestOptions({ ...fermé, status: 'opening_requested', pendingKinds: ['open_and_scan', 'forward'] }),
      { open_and_scan: false, scan: false, forward: false },
    )
    assert.deepEqual(clientRequestOptions({ ...ouvert, pendingKinds: ['scan'] }), {
      open_and_scan: false,
      scan: false,
      forward: true,
    })
  })

  it('rien sur un pli réexpédié : il a quitté le centre', () => {
    assert.deepEqual(clientRequestOptions({ ...ouvert, forwarded: true }), {
      open_and_scan: false,
      scan: false,
      forward: false,
    })
  })

  it('n’annule qu’une demande que le centre n’a pas encore prise en charge', () => {
    assert.equal(canClientCancelRequest('requested'), true)
    for (const status of ['in_progress', 'done', 'refused', 'cancelled'] as const) {
      assert.equal(canClientCancelRequest(status), false, status)
    }
    assert.equal(isPendingRequest('requested'), true)
    assert.equal(isPendingRequest('in_progress'), true)
    assert.equal(isPendingRequest('done'), false)
  })
})

describe('ce que l’accueil peut faire d’une demande', () => {
  const libre = { otherPending: 0, withdrawn: false, billed: false }

  it('prend en charge, refuse ou annule une demande déposée ; la clôt selon sa nature', () => {
    assert.deepEqual(staffRequestActions({ kind: 'scan', status: 'requested' }, libre), {
      start: true,
      refuse: true,
      cancel: true,
      complete: 'scan',
      blockedBy: null,
      editShipping: false,
    })
    // L'ouverture se clôt en ouvrant le pli ; une prise en charge ne s'annule plus.
    const ouverture = staffRequestActions({ kind: 'open_and_scan', status: 'in_progress' }, libre)
    assert.equal(ouverture.complete, 'open')
    assert.equal(ouverture.start, false)
    assert.equal(ouverture.cancel, false)
    assert.equal(ouverture.refuse, true)
  })

  it('réexpédie en dernier : bloquée tant qu’une autre demande attend sur le pli', () => {
    const bloquee = staffRequestActions({ kind: 'forward', status: 'in_progress' }, { ...libre, otherPending: 2 })
    assert.equal(bloquee.complete, null)
    assert.match(bloquee.blockedBy ?? '', /2 autres demandes attendent/)
    assert.equal(bloquee.refuse, true)
    assert.equal(staffRequestActions({ kind: 'forward', status: 'requested' }, libre).complete, 'forward')
  })

  it('ne propose plus rien sur une demande close, ni sur un pli retiré', () => {
    for (const status of ['done', 'refused', 'cancelled'] as const) {
      const actions = staffRequestActions({ kind: 'scan', status }, libre)
      assert.deepEqual([actions.start, actions.refuse, actions.cancel, actions.complete], [false, false, false, null])
    }
    const retire = staffRequestActions({ kind: 'scan', status: 'requested' }, { ...libre, withdrawn: true })
    assert.deepEqual([retire.start, retire.refuse, retire.complete], [false, false, null])
  })

  it('laisse noter suivi et frais d’une réexpédition faite, tant qu’aucune facture ne la tient', () => {
    assert.equal(staffRequestActions({ kind: 'forward', status: 'done' }, libre).editShipping, true)
    assert.equal(staffRequestActions({ kind: 'forward', status: 'done' }, { ...libre, billed: true }).editShipping, false)
    assert.equal(staffRequestActions({ kind: 'scan', status: 'done' }, libre).editShipping, false)
  })
})

describe('adresse de réexpédition', () => {
  const saisie = {
    forwardRecipient: '  Jeanne   Durand ',
    forwardAddressLine1: '12 rue des Lilas',
    forwardAddressLine2: '',
    forwardPostalCode: '38000',
    forwardCity: 'Grenoble',
    forwardCountry: 'fr',
  }

  it('lit une adresse complète, espaces resserrés, pays en majuscules', () => {
    assert.deepEqual(readForwardAddress(saisie).address, {
      recipient: 'Jeanne Durand',
      line1: '12 rue des Lilas',
      line2: null,
      postalCode: '38000',
      city: 'Grenoble',
      country: 'FR',
    })
  })

  it('exige destinataire, adresse, code postal, ville et un pays de la liste', () => {
    const { fieldErrors } = readForwardAddress({ forwardCountry: 'XX' })
    assert.deepEqual(Object.keys(fieldErrors ?? {}).sort(), [
      'forwardAddressLine1',
      'forwardCity',
      'forwardCountry',
      'forwardPostalCode',
      'forwardRecipient',
    ])
  })

  it('veut cinq chiffres pour un code postal français, accepte celui d’un autre pays', () => {
    assert.match(readForwardAddress({ ...saisie, forwardPostalCode: '3800' }).fieldErrors?.forwardPostalCode ?? '', /cinq chiffres/)
    assert.equal(
      readForwardAddress({ ...saisie, forwardPostalCode: 'sw1a 1aa', forwardCountry: 'GB' }).address?.postalCode,
      'SW1A 1AA',
    )
  })

  it('écrit l’adresse comme sur l’enveloppe, et reconnaît deux fois la même', () => {
    const adresse = readForwardAddress({ ...saisie, forwardAddressLine2: 'Bâtiment B' }).address as ForwardAddress
    assert.deepEqual(forwardAddressLines(adresse), [
      'Jeanne Durand',
      '12 rue des Lilas',
      'Bâtiment B',
      '38000 Grenoble',
      'France',
    ])
    assert.equal(sameForwardAddress(adresse, { ...adresse, recipient: 'JEANNE  DURAND', city: ' grenoble ' }), true)
    assert.equal(sameForwardAddress(adresse, { ...adresse, line1: '14 rue des Lilas' }), false)
  })
})

describe('saisies de l’accueil et du client', () => {
  it('lit des frais en euros, au centime, sans flottant ; vide : pas encore relevés', () => {
    assert.deepEqual(readPostage('4,35'), { cents: 435 })
    assert.deepEqual(readPostage('12'), { cents: 1_200 })
    assert.deepEqual(readPostage(''), { cents: null })
    assert.ok('error' in readPostage('quatre euros'))
    assert.ok('error' in readPostage('-2'))
    assert.ok('error' in readPostage('1000,01'))
  })

  it('lit un numéro de suivi, en majuscules', () => {
    assert.deepEqual(readTrackingNumber(' 1a 234 567 '), { value: '1A 234 567' })
    assert.deepEqual(readTrackingNumber(''), { value: null })
    assert.ok('error' in readTrackingNumber('<script>'))
  })

  it('exige le motif d’un refus, borne la consigne du client', () => {
    assert.ok('error' in readRefusalReason('   '))
    assert.deepEqual(readRefusalReason(' Pli remis en main propre. '), { value: 'Pli remis en main propre.' })
    assert.deepEqual(readClientNote(''), { value: null })
    assert.ok('error' in readClientNote('x'.repeat(501)))
  })
})

describe('filtres et pages', () => {
  it('lit les filtres de la boîte aux lettres, ignore l’illisible, remet la période dans l’ordre', () => {
    assert.deepEqual(
      readClientMailFilters({ type: 'colis', du: '2026-09-30', au: '2026-09-01', etat: 'reexpedie', page: '3' }),
      { kind: 'colis', from: '2026-09-01', to: '2026-09-30', state: 'reexpedie', page: 3 },
    )
    assert.deepEqual(readClientMailFilters({ type: 'pli', du: '2026-02-30', etat: 'perdu', page: '-1' }), {
      kind: undefined,
      from: undefined,
      to: undefined,
      state: undefined,
      page: 1,
    })
  })

  it('garde les filtres dans les liens de page', () => {
    assert.equal(clientMailQuery({ kind: 'lettre', state: 'numerise' }, 2), '?type=lettre&etat=numerise&page=2')
    assert.equal(clientMailQuery({}), '')
  })

  it('lit l’état et la nature des demandes, « à traiter » par défaut', () => {
    const defaut = readRequestFilters({})
    assert.equal(defaut.state, 'a-traiter')
    assert.deepEqual(defaut.statuses, ['requested', 'in_progress'])
    const filtre = readRequestFilters({ etat: 'refusee', nature: 'reexpedition', page: '2' })
    assert.deepEqual([filtre.statuses, filtre.kind, filtre.page], [['refused'], 'forward', 2])
    assert.equal(readRequestFilters({ etat: 'n-importe' }, 'toutes').state, 'toutes')
    assert.equal(requestFiltersQuery({ state: 'faite', kindSlug: 'numerisation' }, 3), '?etat=faite&nature=numerisation&page=3')
  })

  it('compte au moins une page, et borne la page demandée', () => {
    assert.equal(pageCount(0, 20), 1)
    assert.equal(pageCount(41, 20), 3)
    assert.equal(readPage('2.5'), 1)
    assert.equal(readPage(['4', '5']), 4)
  })
})

describe('suivi d’une demande', () => {
  it('date chaque étape, avec son auteur ; une annulation reste visible', () => {
    const steps = requestSteps({
      requestedAt: new Date('2026-09-01T08:00:00Z'),
      requestedByName: 'Jeanne Durand',
      startedAt: null,
      completedAt: null,
      refusedAt: null,
      refusalReason: null,
      cancelledAt: new Date('2026-09-01T09:00:00Z'),
      cancelledByName: 'Paul Durand',
    })
    assert.deepEqual(
      steps.map((step) => [step.status, step.by]),
      [
        ['requested', 'Jeanne Durand'],
        ['cancelled', 'Paul Durand'],
      ],
    )
  })

  it('montre le motif d’un refus, et le centre comme auteur', () => {
    const steps = requestSteps({
      requestedAt: new Date('2026-09-01T08:00:00Z'),
      requestedByName: 'Jeanne Durand',
      startedAt: new Date('2026-09-01T08:30:00Z'),
      completedAt: null,
      refusedAt: new Date('2026-09-01T10:00:00Z'),
      refusalReason: 'Colis remis au destinataire.',
      cancelledAt: null,
      cancelledByName: null,
    })
    assert.deepEqual(
      steps.map((step) => step.status),
      ['requested', 'in_progress', 'refused'],
    )
    assert.equal(steps[2].detail, 'Colis remis au destinataire.')
    assert.equal(steps[2].by, 'le centre')
  })
})

describe('prix annoncé avant la demande (ADR 024)', () => {
  const catalogue = { id: 'svc', unitPriceCents: 500, vatRateBp: 2000, currency: 'EUR' }
  const forfait: ActSubscription = {
    id: 'sub',
    startsOn: '2026-01-01',
    endsOn: null,
    unitPriceCents: 300,
    discountBp: 1000,
    vatRateBp: 2000,
    currency: 'EUR',
    includedQuantity: 2,
  }
  const maintenant = { day: '2026-10-15', at: new Date('2026-10-15T10:00:00Z') }
  const fait = (id: string, day: string) => ({ id, day, at: new Date(`${day}T09:00:00Z`) })

  it('annonce un acte inclus tant qu’il en reste dans le mois, et combien ensuite', () => {
    assert.deepEqual(announceNextAct([], [forfait], catalogue, maintenant), { source: 'included', remainingAfter: 1 })
    assert.deepEqual(announceNextAct([fait('a', '2026-10-02')], [forfait], catalogue, maintenant), {
      source: 'included',
      remainingAfter: 0,
    })
  })

  it('puis le prix du forfait, remise comprise ; sans forfait, le catalogue', () => {
    assert.deepEqual(
      announceNextAct([fait('a', '2026-10-02'), fait('b', '2026-10-03')], [forfait], catalogue, maintenant),
      { source: 'subscription', netCents: 270, currency: 'EUR' },
    )
    assert.deepEqual(announceNextAct([], [], catalogue, maintenant), {
      source: 'catalogue',
      netCents: 500,
      currency: 'EUR',
    })
  })

  it('n’invente aucun prix sans service au catalogue', () => {
    const annonce = announceNextAct([], [], null, maintenant)
    assert.deepEqual(annonce, { source: 'unpriced' })
    assert.match(announcementText(annonce), /communiqué sur demande/)
  })

  it('le dit en une phrase, montant au format français', () => {
    assert.equal(
      announcementText({ source: 'catalogue', netCents: 350, currency: 'EUR' }).replace(/\s/g, ' '),
      '3,50 € HT, au tarif du centre.',
    )
    assert.match(announcementText({ source: 'included', remainingAfter: 3 }), /encore 3/)
  })
})
