import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  accountState,
  accountStateLabel,
  banLastDay,
  isBanActive,
  readBanForm,
  REASON_MAX,
} from './regles.ts'

/**
 * Bannissement d'un compte du site (ADR 045). Une erreur ici laisse entrer un
 * compte que l'équipe a fermé, ou garde dehors un compte dont la peine est
 * finie.
 */
const PARIS = 'Europe/Paris'
const now = new Date('2026-10-20T10:00:00Z')

describe('bannissement en vigueur', () => {
  it('sans terme ni levée : en vigueur', () => {
    assert.equal(isBanActive({ bannedUntil: null, liftedAt: null }, now), true)
  })

  it('levé : plus en vigueur, même sans terme', () => {
    assert.equal(isBanActive({ bannedUntil: null, liftedAt: new Date('2026-10-19T00:00:00Z') }, now), false)
  })

  it('terme exclu : à l’instant du terme, le compte entre de nouveau', () => {
    const ban = { bannedUntil: now, liftedAt: null }
    assert.equal(isBanActive(ban, new Date(now.getTime() - 1)), true)
    assert.equal(isBanActive(ban, now), false)
  })
})

describe('état d’un compte', () => {
  it('aucun bannissement en vigueur : actif', () => {
    assert.deepEqual(accountState([], now), { kind: 'actif' })
    assert.deepEqual(
      accountState([{ bannedUntil: new Date('2026-10-01T00:00:00Z'), liftedAt: null }], now),
      { kind: 'actif' },
    )
  })

  it('un bannissement sans terme l’emporte sur un temporaire', () => {
    const state = accountState(
      [
        { bannedUntil: new Date('2026-12-01T00:00:00Z'), liftedAt: null },
        { bannedUntil: null, liftedAt: null },
      ],
      now,
    )
    assert.deepEqual(state, { kind: 'banni', until: null })
  })

  it('plusieurs temporaires : le terme le plus lointain', () => {
    const state = accountState(
      [
        { bannedUntil: new Date('2026-11-01T00:00:00Z'), liftedAt: null },
        { bannedUntil: new Date('2026-12-01T00:00:00Z'), liftedAt: null },
      ],
      now,
    )
    assert.deepEqual(state, { kind: 'banni', until: new Date('2026-12-01T00:00:00Z') })
  })
})

describe('formulaire de bannissement', () => {
  it('définitif : pas de terme, motif nettoyé', () => {
    assert.deepEqual(readBanForm({ reason: '  Spam  ', duration: 'definitif', until: '' }, PARIS, now), {
      input: { reason: 'Spam', bannedUntil: null },
    })
  })

  it('temporaire : jusqu’au jour inclus, fin à minuit heure du centre', () => {
    // Le 11 novembre est en heure d'hiver : minuit à Paris est 23 h UTC la veille.
    assert.deepEqual(
      readBanForm({ reason: 'Impayé', duration: 'temporaire', until: '2026-11-11' }, PARIS, now),
      { input: { reason: 'Impayé', bannedUntil: new Date('2026-11-11T23:00:00Z') } },
    )
  })

  it('aujourd’hui est accepté, hier non', () => {
    assert.ok('input' in readBanForm({ reason: 'x', duration: 'temporaire', until: '2026-10-20' }, PARIS, now))
    const refused = readBanForm({ reason: 'x', duration: 'temporaire', until: '2026-10-19' }, PARIS, now)
    assert.ok('errors' in refused && refused.errors.until)
  })

  it('motif absent, trop long, date invalide, durée inconnue : refusés', () => {
    const empty = readBanForm({ reason: '   ', duration: 'temporaire', until: '2026-02-30' }, PARIS, now)
    assert.ok('errors' in empty && empty.errors.reason && empty.errors.until)

    const long = readBanForm({ reason: 'a'.repeat(REASON_MAX + 1), duration: 'definitif', until: '' }, PARIS, now)
    assert.ok('errors' in long && long.errors.reason)

    const unknown = readBanForm({ reason: 'x', duration: 'toujours', until: '' }, PARIS, now)
    assert.ok('errors' in unknown && unknown.errors.until)
  })
})

describe('libellé de l’état', () => {
  it('dit le dernier jour inclus, à l’heure du centre', () => {
    const read = readBanForm({ reason: 'x', duration: 'temporaire', until: '2026-11-11' }, PARIS, now)
    assert.ok('input' in read)
    const until = read.input.bannedUntil!
    assert.equal(banLastDay(until, PARIS), '2026-11-11')
    assert.equal(accountStateLabel({ kind: 'banni', until }, PARIS), 'Banni jusqu’au 11/11/2026 inclus')
  })

  it('actif, banni sans terme', () => {
    assert.equal(accountStateLabel({ kind: 'actif' }, PARIS), 'Actif')
    assert.equal(accountStateLabel({ kind: 'banni', until: null }, PARIS), 'Banni')
  })
})
