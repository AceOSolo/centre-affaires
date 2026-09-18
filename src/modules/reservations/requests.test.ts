import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  MAX_DAYS_AHEAD,
  MAX_REQUESTS_PER_EMAIL,
  rejectRequest,
  type RequestInput,
} from './requests.ts'

const NOW = new Date('2026-10-01T08:00:00Z')
const minutes = (count: number) => count * 60_000

/** Demande recevable ; chaque test n'en change qu'un aspect. */
const valide = (overrides: Partial<RequestInput> = {}): RequestInput => ({
  name: 'Camille Rousseau',
  email: 'camille@exemple.fr',
  phone: '06 12 34 56 78',
  title: 'Réunion de cadrage',
  range: {
    startsAt: new Date(NOW.getTime() + minutes(120)),
    endsAt: new Date(NOW.getTime() + minutes(180)),
  },
  resourceIsBookable: true,
  recentRequestCount: 0,
  ...overrides,
})

describe('recevabilité d’une demande publique', () => {
  it('accepte une demande complète sur un créneau futur', () => {
    assert.equal(rejectRequest(valide(), NOW), undefined)
  })

  describe('identité du demandeur', () => {
    it('exige un nom', () => {
      assert.equal(rejectRequest(valide({ name: '   ' }), NOW), 'nom-manquant')
    })

    it('exige une adresse plausible', () => {
      assert.equal(rejectRequest(valide({ email: 'camille' }), NOW), 'email-invalide')
      assert.equal(rejectRequest(valide({ email: 'camille@exemple' }), NOW), 'email-invalide')
      assert.equal(rejectRequest(valide({ email: 'a@b.fr' }), NOW), undefined)
    })

    it('exige un téléphone — le staff doit pouvoir rappeler', () => {
      assert.equal(rejectRequest(valide({ phone: '' }), NOW), 'telephone-manquant')
    })

    it('exige un objet', () => {
      assert.equal(rejectRequest(valide({ title: '' }), NOW), 'objet-manquant')
    })
  })

  describe('créneau', () => {
    it('refuse le passé', () => {
      const range = {
        startsAt: new Date(NOW.getTime() - minutes(120)),
        endsAt: new Date(NOW.getTime() - minutes(60)),
      }
      assert.equal(rejectRequest(valide({ range }), NOW), 'creneau-passe')
    })

    it('refuse l’instant présent — le temps de valider, il est passé', () => {
      const range = { startsAt: NOW, endsAt: new Date(NOW.getTime() + minutes(60)) }
      assert.equal(rejectRequest(valide({ range }), NOW), 'creneau-passe')
    })

    it('refuse au-delà de l’horizon d’ouverture', () => {
      const debut = new Date(NOW.getTime() + (MAX_DAYS_AHEAD + 1) * 86_400_000)
      const range = { startsAt: debut, endsAt: new Date(debut.getTime() + minutes(60)) }
      assert.equal(rejectRequest(valide({ range }), NOW), 'creneau-trop-lointain')
    })

    it('refuse une durée trop courte', () => {
      const range = {
        startsAt: new Date(NOW.getTime() + minutes(120)),
        endsAt: new Date(NOW.getTime() + minutes(135)),
      }
      assert.equal(rejectRequest(valide({ range }), NOW), 'duree-trop-courte')
    })

    it('refuse une durée trop longue', () => {
      const range = {
        startsAt: new Date(NOW.getTime() + minutes(120)),
        endsAt: new Date(NOW.getTime() + minutes(120 + 9 * 60)),
      }
      assert.equal(rejectRequest(valide({ range }), NOW), 'duree-trop-longue')
    })

    it('refuse un intervalle inversé sans le confondre avec le passé', () => {
      const range = {
        startsAt: new Date(NOW.getTime() + minutes(180)),
        endsAt: new Date(NOW.getTime() + minutes(120)),
      }
      assert.equal(rejectRequest(valide({ range }), NOW), 'duree-trop-courte')
    })

    it('refuse une date illisible', () => {
      const range = { startsAt: new Date('pas une date'), endsAt: new Date('pas une date') }
      assert.equal(rejectRequest(valide({ range }), NOW), 'creneau-illisible')
    })
  })

  describe('garde-fous', () => {
    it('refuse une ressource qui n’est pas en service', () => {
      assert.equal(
        rejectRequest(valide({ resourceIsBookable: false }), NOW),
        'ressource-indisponible',
      )
    })

    it('refuse au-delà du quota par adresse', () => {
      assert.equal(
        rejectRequest(valide({ recentRequestCount: MAX_REQUESTS_PER_EMAIL }), NOW),
        'trop-de-demandes',
      )
      assert.equal(
        rejectRequest(valide({ recentRequestCount: MAX_REQUESTS_PER_EMAIL - 1 }), NOW),
        undefined,
      )
    })

    it('signale d’abord ce que le demandeur peut corriger', () => {
      // Formulaire vide et créneau passé : lui parler du champ, pas du créneau.
      const range = {
        startsAt: new Date(NOW.getTime() - minutes(120)),
        endsAt: new Date(NOW.getTime() - minutes(60)),
      }
      assert.equal(rejectRequest(valide({ name: '', range }), NOW), 'nom-manquant')
    })
  })
})
