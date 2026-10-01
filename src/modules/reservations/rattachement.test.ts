import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { wallClockToUtc } from '../../lib/dates.ts'
import { bookingContractProblem, type AttachableContract } from './rattachement.ts'

/**
 * Rattachement d'une réservation à un contrat (R05) : même client, contrat
 * actif, période couverte. La base ne contrôle que l'appartenance au centre ;
 * cette règle est le seul garde contre une réservation rattachée au contrat
 * d'un autre client.
 */
const PARIS = 'Europe/Paris'
const ACME = '01a00000-0000-7000-8000-0000000000a1'
const BETA = '01a00000-0000-7000-8000-0000000000b2'

const contrat = (overrides: Partial<AttachableContract> = {}): AttachableContract => ({
  clientId: ACME,
  status: 'active',
  deletedAt: null,
  startsOn: '2026-03-01',
  endsOn: '2026-06-30',
  terminatedOn: null,
  ...overrides,
})

/** Créneau en heure murale de Paris. */
const creneau = (start: string, end: string, clientId: string | null = ACME) => ({
  clientId,
  startsAt: wallClockToUtc(start, PARIS),
  endsAt: wallClockToUtc(end, PARIS),
})

describe('rattachement d’une réservation à un contrat', () => {
  it('accepte un créneau du même client, pendant le contrat actif', () => {
    assert.equal(
      bookingContractProblem(contrat(), creneau('2026-04-10T09:00', '2026-04-10T11:00'), PARIS),
      undefined,
    )
  })

  it('exige un client sur la réservation', () => {
    assert.equal(
      bookingContractProblem(contrat(), creneau('2026-04-10T09:00', '2026-04-10T11:00', null), PARIS),
      'sans-client',
    )
  })

  it('refuse le contrat d’un autre client', () => {
    assert.equal(
      bookingContractProblem(contrat(), creneau('2026-04-10T09:00', '2026-04-10T11:00', BETA), PARIS),
      'autre-client',
    )
  })

  it('refuse un brouillon', () => {
    assert.equal(
      bookingContractProblem(
        contrat({ status: 'draft' }),
        creneau('2026-04-10T09:00', '2026-04-10T11:00'),
        PARIS,
      ),
      'pas-actif',
    )
  })

  it('refuse un contrat résilié, même avant sa date de fin', () => {
    assert.equal(
      bookingContractProblem(
        contrat({ status: 'terminated', terminatedOn: '2026-05-31' }),
        creneau('2026-04-10T09:00', '2026-04-10T11:00'),
        PARIS,
      ),
      'pas-actif',
    )
  })

  it('refuse un contrat archivé', () => {
    assert.equal(
      bookingContractProblem(
        contrat({ deletedAt: new Date('2026-04-01T00:00:00Z') }),
        creneau('2026-04-10T09:00', '2026-04-10T11:00'),
        PARIS,
      ),
      'pas-actif',
    )
  })

  it('refuse un créneau avant le début du contrat', () => {
    assert.equal(
      bookingContractProblem(contrat(), creneau('2026-02-28T09:00', '2026-02-28T11:00'), PARIS),
      'hors-periode',
    )
  })

  it('refuse un créneau après le dernier jour', () => {
    assert.equal(
      bookingContractProblem(contrat(), creneau('2026-07-01T09:00', '2026-07-01T11:00'), PARIS),
      'hors-periode',
    )
  })

  it('refuse un créneau qui déborde du dernier jour', () => {
    assert.equal(
      bookingContractProblem(contrat(), creneau('2026-06-30T23:00', '2026-07-01T01:00'), PARIS),
      'hors-periode',
    )
  })

  it('accepte le premier jour dès minuit, heure du centre', () => {
    assert.equal(
      bookingContractProblem(contrat(), creneau('2026-03-01T00:00', '2026-03-01T08:00'), PARIS),
      undefined,
    )
  })

  it('accepte un créneau qui finit à minuit le lendemain du dernier jour : fin exclue', () => {
    assert.equal(
      bookingContractProblem(contrat(), creneau('2026-06-30T20:00', '2026-07-01T00:00'), PARIS),
      undefined,
    )
  })

  it('lit le premier jour dans le fuseau du centre, pas en UTC', () => {
    // 00h30 à Paris le 1er mars : encore le 28 février en UTC, déjà dans le contrat.
    assert.equal(
      bookingContractProblem(contrat(), creneau('2026-03-01T00:30', '2026-03-01T01:30'), PARIS),
      undefined,
    )
  })

  it('accepte une date lointaine sur un contrat sans terme', () => {
    assert.equal(
      bookingContractProblem(
        contrat({ endsOn: null }),
        creneau('2031-01-15T09:00', '2031-01-15T10:00'),
        PARIS,
      ),
      undefined,
    )
  })
})
