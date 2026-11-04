import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  decideContractMatch,
  percentToBasisPoints,
  readCrmContract,
  type ContractCandidate,
  type ReceivedContract,
} from './contrats-crm.ts'

/**
 * Contrats reçus du CRM (ADR 066) : lecture de l'envoi et rapprochement. La
 * base — occupation, chevauchement, prix suivi — est éprouvée par
 * `contrats-crm.db.test.ts`.
 */

const envoi = (overrides: Record<string, unknown> = {}) => ({
  dolibarrId: 57,
  reference: 'CT2611-0003',
  tiersDolibarrId: 412,
  type: 'bureau',
  statut: 'en_cours',
  debut: '2026-11-01',
  fin: null,
  ressource: 'BUR-12',
  prix: { montantHtCentimes: 45000, periodicite: 'mensuel', tauxTva: '20' },
  ...overrides,
})

const lu = (overrides: Record<string, unknown> = {}) => {
  const read = readCrmContract(envoi(overrides))
  assert.equal(read.ok, true, read.ok ? undefined : read.message)
  const value = (read as { value: ReceivedContract }).value
  if (value.removed) throw new Error('inattendu')
  return value
}

const refus = (overrides: Record<string, unknown>) => {
  const read = readCrmContract(envoi(overrides))
  assert.equal(read.ok, false)
  return (read as { message: string }).message
}

describe('contrats du CRM : lecture de l’envoi', () => {
  it('reprend type, période, ressource et prix', () => {
    const contrat = lu()
    assert.equal(contrat.crmId, '57')
    assert.equal(contrat.thirdPartyCrmId, '412')
    assert.equal(contrat.resourceCode, 'BUR-12')
    assert.deepEqual(contrat.fields, {
      reference: 'CT2611-0003',
      contractType: 'bureau',
      status: 'active',
      startsOn: '2026-11-01',
      endsOn: null,
      terminatedOn: null,
      terminationReason: null,
      amountCents: 45000,
      billingPeriod: 'monthly',
      vatRateBp: 2000,
      currency: 'EUR',
    })
  })

  it('un contrat terminé porte son dernier jour ; une résiliation datée le termine à cette date', () => {
    assert.equal(lu({ statut: 'termine', fin: '2027-10-31' }).fields.terminatedOn, '2027-10-31')
    const resilie = lu({ statut: 'en_cours', resilieLe: '2027-03-31', motifResiliation: 'Départ' })
    assert.equal(resilie.fields.status, 'terminated')
    assert.equal(resilie.fields.terminatedOn, '2027-03-31')
    assert.equal(resilie.fields.terminationReason, 'Départ')
    assert.match(refus({ statut: 'termine', fin: null }), /resilieLe/)
    assert.equal(lu({ statut: 'brouillon', resilieLe: '2027-03-31' }).fields.status, 'draft')
  })

  it('l’engagement et le préavis ne changent que s’ils sont envoyés', () => {
    assert.equal('commitmentMonths' in lu().fields, false)
    assert.equal('noticeDays' in lu().fields, false)
    assert.equal(lu({ engagementMois: 12 }).fields.commitmentMonths, 12)
    assert.equal(lu({ engagementMois: null }).fields.commitmentMonths, null)
    assert.equal(lu({ preavisJours: 30 }).fields.noticeDays, 30)
    assert.match(refus({ engagementMois: 0 }), /engagementMois/)
  })

  it('refuse ce qu’il ne sait pas lire, et dit quoi corriger', () => {
    assert.match(refus({ reference: '' }), /reference/)
    assert.match(refus({ reference: '@auto' }), /reference/)
    assert.match(refus({ tiersDolibarrId: undefined }), /tiersDolibarrId/)
    assert.match(refus({ type: 'parking' }), /type/)
    assert.match(refus({ statut: 'active' }), /statut/)
    assert.match(refus({ debut: '2026-02-30' }), /debut/)
    assert.match(refus({ fin: '2026-10-01' }), /précède/)
    assert.match(refus({ prix: undefined }), /prix/)
    assert.match(refus({ prix: { montantHtCentimes: 45.5, periodicite: 'mensuel' } }), /montantHtCentimes/)
    assert.match(refus({ prix: { montantHtCentimes: 45000, periodicite: 'hebdomadaire' } }), /periodicite/)
    assert.match(refus({ prix: { montantHtCentimes: 45000, periodicite: 'mensuel', devise: 'eur' } }), /devise/)
    assert.match(refus({ contratId: 'CT-1' }), /contratId/)
  })

  it('lit les taux de TVA en pourcentage décimal', () => {
    assert.equal(percentToBasisPoints('20'), 2000)
    assert.equal(percentToBasisPoints('5.5'), 550)
    assert.equal(percentToBasisPoints('2,1'), 210)
    assert.equal(percentToBasisPoints(0), 0)
    assert.equal(percentToBasisPoints('100.5'), undefined)
    assert.equal(percentToBasisPoints('vingt'), undefined)
  })

  it('une suppression ne demande que l’identifiant', () => {
    assert.deepEqual(readCrmContract({ dolibarrId: '57', supprime: true }), { ok: true, value: { removed: true, crmId: '57' } })
  })
})

describe('contrats du CRM : rapprochement', () => {
  const CLIENT = '01999f00-0000-7000-8000-00000000c001'
  const contrat = (overrides: Partial<ContractCandidate> = {}): ContractCandidate => ({
    contractId: '01999f00-0000-7000-8000-00000000a0c1',
    reference: 'CT2611-0003',
    clientId: CLIENT,
    archived: false,
    linkedTo: null,
    ...overrides,
  })
  const aucun = { linked: null, explicit: null, byReference: null, clientId: CLIENT }

  it('retrouve le contrat déjà relié, puis celui que le CRM désigne', () => {
    assert.deepEqual(decideContractMatch(lu(), { ...aucun, linked: contrat({ linkedTo: '57' }) }), {
      kind: 'update',
      contractId: contrat().contractId,
      how: 'link',
    })
    assert.deepEqual(decideContractMatch(lu({ contratId: contrat().contractId }), { ...aucun, explicit: contrat() }), {
      kind: 'update',
      contractId: contrat().contractId,
      how: 'explicit',
    })
    assert.equal(decideContractMatch(lu({ contratId: contrat().contractId }), { ...aucun, explicit: 'missing' }).kind, 'refuse')
    assert.equal(
      decideContractMatch(lu({ contratId: contrat().contractId }), { ...aucun, explicit: contrat({ linkedTo: '99' }) }).kind,
      'refuse',
    )
  })

  it('reprend un contrat du site de même référence et même client, jamais celui d’un autre', () => {
    assert.deepEqual(decideContractMatch(lu(), { ...aucun, byReference: contrat() }), {
      kind: 'update',
      contractId: contrat().contractId,
      how: 'reference',
    })
    assert.equal(decideContractMatch(lu(), { ...aucun, byReference: contrat({ clientId: 'autre' }) }).kind, 'refuse')
    assert.equal(decideContractMatch(lu(), { ...aucun, byReference: contrat({ linkedTo: '99' }) }).kind, 'refuse')
  })

  it('crée un contrat inconnu ; un contrat archivé sur le site ne se met plus à jour', () => {
    assert.deepEqual(decideContractMatch(lu(), aucun), { kind: 'create' })
    assert.equal(decideContractMatch(lu(), { ...aucun, linked: contrat({ archived: true }) }).kind, 'ignore')
  })

  it('une suppression archive le contrat relié', () => {
    const supprime: ReceivedContract = { removed: true, crmId: '57' }
    assert.deepEqual(decideContractMatch(supprime, { ...aucun, linked: contrat() }), { kind: 'remove', contractId: contrat().contractId })
    assert.equal(decideContractMatch(supprime, aucun).kind, 'ignore')
    assert.equal(decideContractMatch(supprime, { ...aucun, linked: contrat({ archived: true }) }).kind, 'ignore')
  })
})
