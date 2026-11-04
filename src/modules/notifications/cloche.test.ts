import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { permissionsOf } from '../../lib/auth/permissions.ts'
import {
  boundedSummary,
  kindsVisibleTo,
  staffNotificationHref,
  staffNotificationKindLabels,
  staffNotificationPermissions,
  staffNotificationWhen,
  unreadBadge,
  unreadPhrase,
} from './cloche.ts'
import { staffNotificationKinds } from './schema-equipe.ts'

/** Règles de la cloche de l'équipe (ADR 059), sans base. */
describe('cloche de l’équipe : règles', () => {
  it('donne à chaque nature son libellé, son droit et son lien', () => {
    for (const kind of staffNotificationKinds) {
      assert.ok(staffNotificationKindLabels[kind], kind)
      assert.ok(staffNotificationPermissions[kind], kind)
      assert.match(staffNotificationHref(kind, 'abc'), /^\/(demandes#[a-z]+-abc|etats-des-lieux\/abc)$/, kind)
    }
  })

  it('mène chaque demande à son ancre dans « Demandes »', () => {
    assert.equal(staffNotificationHref('booking_request', 'r1'), '/demandes#demande-r1')
    assert.equal(staffNotificationHref('quote_request', 'r1'), '/demandes#demande-r1')
    assert.equal(staffNotificationHref('domiciliation_request', 'd1'), '/demandes#devis-d1')
    assert.equal(staffNotificationHref('offer_request', 'o1'), '/demandes#offre-o1')
    assert.equal(staffNotificationHref('mail_request', 'm1'), '/demandes#courrier-m1')
    assert.equal(staffNotificationHref('inspection_signed', 'e1'), '/etats-des-lieux/e1')
  })

  it('montre tout à l’accueil, à l’exploitant et à la direction, d’après leurs droits', () => {
    for (const role of ['staff', 'admin', 'super_admin'] as const) {
      assert.deepEqual(kindsVisibleTo(permissionsOf(role)), [...staffNotificationKinds], role)
    }
  })

  it('ne montre que ce que les droits ouvrent', () => {
    assert.deepEqual(kindsVisibleTo(['courrier.gerer']), ['mail_request'])
    assert.deepEqual(kindsVisibleTo(['etats-des-lieux.gerer']), ['inspection_signed'])
    assert.deepEqual(kindsVisibleTo(['demandes.traiter']), [
      'booking_request',
      'quote_request',
      'domiciliation_request',
      'offer_request',
    ])
    assert.deepEqual(kindsVisibleTo([]), [])
  })

  it('dit « quand » à l’heure du centre', () => {
    const now = new Date('2026-11-04T09:30:00Z') // 10:30 à Paris
    const paris = 'Europe/Paris'
    assert.equal(staffNotificationWhen(new Date('2026-11-04T09:29:40Z'), paris, now), 'à l’instant')
    assert.equal(staffNotificationWhen(new Date('2026-11-04T09:18:00Z'), paris, now), 'il y a 12 min')
    assert.equal(staffNotificationWhen(new Date('2026-11-04T07:05:00Z'), paris, now), 'aujourd’hui à 08:05')
    assert.equal(staffNotificationWhen(new Date('2026-11-03T16:02:00Z'), paris, now), 'hier à 17:02')
    assert.equal(staffNotificationWhen(new Date('2026-10-30T09:00:00Z'), paris, now), '30 oct. 2026 à 10:00')
    // Minuit passé à Paris, pas encore en UTC : la veille de Paris, c'est bien « hier ».
    assert.equal(
      staffNotificationWhen(new Date('2026-11-03T22:30:00Z'), paris, new Date('2026-11-03T23:30:00Z')),
      'hier à 23:30',
    )
  })

  it('annonce le nombre de non lues, et borne la pastille', () => {
    assert.equal(unreadPhrase(0), 'aucune non lue')
    assert.equal(unreadPhrase(1), '1 non lue')
    assert.equal(unreadPhrase(4), '4 non lues')
    assert.equal(unreadBadge(0), null)
    assert.equal(unreadBadge(7), '7')
    assert.equal(unreadBadge(150), '99+')
  })

  it('compose un résumé d’une ligne, borné à la colonne', () => {
    assert.equal(boundedSummary(['Salle Atlas', null, '  lundi 5 octobre  ']), 'Salle Atlas · lundi 5 octobre')
    assert.equal(boundedSummary([' ', undefined]), '')
    const long = boundedSummary(['x'.repeat(300)])
    assert.equal(long.length, 255)
    assert.ok(long.endsWith('…'))
  })
})
