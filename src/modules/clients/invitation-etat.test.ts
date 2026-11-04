import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { canResendInvitation, describeMemberAccess, memberAccessState } from './invitation-etat.ts'

/** État d'un accès sur la fiche du client (ADR 059), sans base. */
describe('état d’un accès à l’espace client', () => {
  const paris = 'Europe/Paris'
  const envoyee = new Date('2026-11-04T09:02:00Z')

  it('est actif dès la première connexion, quelle que soit l’invitation', () => {
    const state = memberAccessState({ authUserId: 'u1' }, { status: 'sent', sentAt: envoyee })
    assert.deepEqual(state, { kind: 'actif' })
    assert.equal(canResendInvitation(state), false)
    assert.deepEqual(describeMemberAccess(state, paris), { label: 'Compte activé', active: true, detail: null })
  })

  it('dit jusqu’à quand vaut le lien d’une invitation envoyée', () => {
    const state = memberAccessState({ authUserId: null }, { status: 'sent', sentAt: envoyee }, new Date('2026-11-05T10:00:00Z'))
    assert.equal(state.kind, 'invite')
    assert.equal(canResendInvitation(state), true)
    assert.deepEqual(describeMemberAccess(state, paris), {
      label: 'Invitée',
      active: false,
      detail: 'Envoyée le 4 nov. 2026 à 10:02, lien valable jusqu’au 11 nov. 2026 à 10:02.',
    })
  })

  it('dit le lien expiré au bout de sept jours, borne exclue', () => {
    const juste = memberAccessState({ authUserId: null }, { status: 'sent', sentAt: envoyee }, new Date('2026-11-11T09:01:59Z'))
    assert.equal(juste.kind === 'invite' && juste.expired, false)
    const passe = memberAccessState({ authUserId: null }, { status: 'sent', sentAt: envoyee }, new Date('2026-11-11T09:02:00Z'))
    assert.equal(passe.kind === 'invite' && passe.expired, true)
    assert.equal(describeMemberAccess(passe, paris).label, 'Invitation expirée')
  })

  it('dit qu’aucun courriel n’est parti, ou que l’envoi a échoué', () => {
    const nonConfigure = memberAccessState({ authUserId: null }, { status: 'not_configured', sentAt: envoyee })
    assert.equal(describeMemberAccess(nonConfigure, paris).label, 'Invitation non envoyée')
    assert.match(describeMemberAccess(nonConfigure, paris).detail ?? '', /pas configuré/)
    const echec = memberAccessState({ authUserId: null }, { status: 'failed', sentAt: envoyee })
    assert.equal(describeMemberAccess(echec, paris).label, 'Échec de l’invitation')
  })

  it('propose de renvoyer l’invitation d’un accès sans invitation au journal', () => {
    const state = memberAccessState({ authUserId: null }, undefined)
    assert.deepEqual(state, { kind: 'sans-invitation' })
    assert.equal(canResendInvitation(state), true)
    assert.equal(describeMemberAccess(state, paris).label, 'En attente de connexion')
  })
})
