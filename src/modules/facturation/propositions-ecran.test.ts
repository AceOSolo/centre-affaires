import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  lineFormValues,
  parseManualLine,
  parseRequester,
  parseServiceLine,
  parseStatusGroup,
  proposalGuidance,
  requesterFormValues,
  type LineFormValues,
} from './propositions-ecran.ts'

const form = (entries: Record<string, string>) => ({ get: (name: string) => entries[name] ?? null })

const manual = (overrides: Partial<LineFormValues> = {}): LineFormValues => ({
  ...lineFormValues(form({})),
  mode: 'manual',
  label: 'Café d’accueil',
  unit: 'unit',
  quantity: '8',
  unitPrice: '3,50',
  vatRate: '10',
  ...overrides,
})

describe('parseManualLine', () => {
  it('rend les euros en centimes et le taux en points de base', () => {
    const { line, errors } = parseManualLine(manual())
    assert.deepEqual(errors, {})
    assert.deepEqual(line, {
      label: 'Café d’accueil',
      description: null,
      unit: 'unit',
      quantity: 8,
      unitPriceCents: 350,
      discountBp: null,
      discountAmountCents: null,
      vatRateBp: 1000,
    })
  })

  it('accepte une remise en pourcentage ou en euros', () => {
    assert.equal(parseManualLine(manual({ discountPercent: '12,5' })).line?.discountBp, 1250)
    assert.equal(parseManualLine(manual({ discountAmount: '5' })).line?.discountAmountCents, 500)
  })

  it('refuse les deux remises à la fois', () => {
    const { line, errors } = parseManualLine(manual({ discountPercent: '10', discountAmount: '5' }))
    assert.equal(line, undefined)
    assert.ok(errors.discountAmount)
  })

  it('refuse une remise plus grande que la ligne', () => {
    assert.ok(parseManualLine(manual({ discountAmount: '100' })).errors.discountAmount)
  })

  it('signale chaque champ manquant ou illisible', () => {
    const { errors } = parseManualLine(manual({ label: '', unit: 'siecle', quantity: '0', unitPrice: '12,345', vatRate: '120' }))
    assert.deepEqual(Object.keys(errors).sort(), ['label', 'quantity', 'unit', 'unitPrice', 'vatRate'])
  })

  it('refuse une quantité décimale', () => {
    assert.ok(parseManualLine(manual({ quantity: '1,5' })).errors.quantity)
  })
})

describe('parseServiceLine', () => {
  const service = {
    id: '0192f000-0000-7000-8000-000000000001',
    name: 'Numérisation du courrier',
    unit: 'month' as const,
    unitPriceCents: 1500,
    vatRateBp: 2000,
    description: 'Scans envoyés par courriel',
  }

  it('copie la désignation, le prix et la TVA du service', () => {
    const { line, errors } = parseServiceLine(manual({ mode: 'service', serviceId: service.id, quantity: '3' }), service)
    assert.deepEqual(errors, {})
    assert.equal(line?.source, 'service')
    assert.equal(line?.serviceId, service.id)
    assert.equal(line?.label, service.name)
    assert.equal(line?.unitPriceCents, 1500)
    assert.equal(line?.vatRateBp, 2000)
    assert.equal(line?.quantity, 3)
  })

  it('refuse un service absent du catalogue', () => {
    const { line, errors } = parseServiceLine(manual({ mode: 'service', serviceId: service.id }), undefined)
    assert.equal(line, undefined)
    assert.ok(errors.serviceId)
  })
})

describe('parseRequester', () => {
  const clientId = '0192f000-0000-7000-8000-0000000000aa'

  it('un client existant suffit', () => {
    const values = requesterFormValues(form({ recipient: 'client', clientId, requesterCompany: 'Ignorée' }))
    const { requester, errors } = parseRequester(values, new Set([clientId]))
    assert.deepEqual(errors, {})
    assert.equal(requester?.clientId, clientId)
    assert.equal(requester?.requesterCompany, null)
  })

  it('refuse un client hors de la liste', () => {
    const values = requesterFormValues(form({ recipient: 'client', clientId }))
    assert.ok(parseRequester(values, new Set()).errors.clientId)
  })

  it('un prospect a un courriel et un nom ou une entreprise', () => {
    const missing = parseRequester(requesterFormValues(form({ recipient: 'prospect' })), new Set())
    assert.deepEqual(Object.keys(missing.errors).sort(), ['requesterEmail', 'requesterName'])
    const ok = parseRequester(
      requesterFormValues(form({ recipient: 'prospect', requesterEmail: 'lea@atelier.fr', requesterCompany: 'Atelier' })),
      new Set(),
    )
    assert.deepEqual(ok.errors, {})
    assert.equal(ok.requester?.clientId, null)
    assert.equal(ok.requester?.requesterEmail, 'lea@atelier.fr')
  })

  it('refuse un courriel mal formé', () => {
    const values = requesterFormValues(form({ recipient: 'prospect', requesterEmail: 'lea@', requesterName: 'Léa' }))
    assert.ok(parseRequester(values, new Set()).errors.requesterEmail)
  })
})

describe('parseStatusGroup', () => {
  it('« À compléter » par défaut et sur une valeur inconnue', () => {
    assert.equal(parseStatusGroup(undefined), 'a-completer')
    assert.equal(parseStatusGroup('constructor'), 'a-completer')
    assert.equal(parseStatusGroup('clos'), 'clos')
    assert.equal(parseStatusGroup(['tous', 'clos']), 'tous')
  })
})

describe('proposalGuidance', () => {
  const draft = { status: 'draft' as const, product: 'espace' as const, hasBooking: false, dolibarrRef: null }

  it('dit qu’il manque le prix d’un brouillon sans ligne', () => {
    assert.equal(proposalGuidance({ ...draft, lines: [] }), 'Aucune ligne : ajoutez le prix avant de valider.')
  })

  it('signale une ligne à 0 €', () => {
    assert.match(proposalGuidance({ ...draft, lines: [{ unitPriceCents: 0 }] }), /0 €/)
  })

  it('annonce la référence Dolibarr d’un devis transmis', () => {
    assert.match(proposalGuidance({ ...draft, status: 'sent', lines: [], dolibarrRef: 'PR2610-0001' }), /PR2610-0001/)
  })
})
