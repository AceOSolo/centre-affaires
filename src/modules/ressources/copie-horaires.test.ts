import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { centreRanges, planCopieHoraires, type OpeningRule } from './ouverture.ts'

const SALLE = 'resource-salle'
const BUREAU = 'resource-bureau'

const regle = (
  weekday: number,
  opensAt: string,
  closesAt: string,
  resourceId: string | null = null,
): OpeningRule => ({ resourceId, weekday, opensAt, closesAt })

/** Semaine type du centre : 9h-18h du lundi au vendredi. */
const semaineType = [1, 2, 3, 4, 5].map((jour) => regle(jour, '09:00:00', '18:00:00'))

describe('centreRanges', () => {
  it('ne retient que les plages du centre', () => {
    const ranges = centreRanges([...semaineType, regle(6, '10:00:00', '12:00:00', SALLE)])
    assert.equal(ranges.length, 5)
    assert.ok(ranges.every((range) => range.weekday >= 1 && range.weekday <= 5))
  })

  it('conserve une journée coupée à midi comme deux plages', () => {
    const ranges = centreRanges([
      regle(1, '09:00:00', '12:30:00'),
      regle(1, '14:00:00', '18:00:00'),
    ])
    assert.deepEqual(
      ranges.map((range) => [range.opensAt, range.closesAt]),
      [
        ['09:00:00', '12:30:00'],
        ['14:00:00', '18:00:00'],
      ],
    )
  })

  it('dédoublonne sur la clé d’unicité de la base', () => {
    // Deux lignes même jour, même heure d'ouverture : la copie violerait
    // `opening_hours_slot_key` si on les recopiait toutes les deux.
    const ranges = centreRanges([regle(1, '09:00:00', '18:00:00'), regle(1, '09:00:00', '17:00:00')])
    assert.equal(ranges.length, 1)
  })

  it('ordonne par jour puis par heure', () => {
    const ranges = centreRanges([
      regle(3, '09:00:00', '18:00:00'),
      regle(1, '14:00:00', '18:00:00'),
      regle(1, '09:00:00', '12:30:00'),
    ])
    assert.deepEqual(
      ranges.map((range) => `${range.weekday}@${range.opensAt}`),
      ['1@09:00:00', '1@14:00:00', '3@09:00:00'],
    )
  })
})

describe('planCopieHoraires', () => {
  it('copie les horaires du centre sur une ressource qui n’en a pas', () => {
    const plan = planCopieHoraires(semaineType, [SALLE])
    assert.equal(plan.length, 1)
    assert.equal(plan[0].resourceId, SALLE)
    assert.equal(plan[0].ranges.length, 5)
  })

  it('laisse intacte une ressource qui a déjà ses horaires', () => {
    // Le cœur de la règle : des horaires propres sont une saisie délibérée.
    const rules = [...semaineType, regle(6, '10:00:00', '12:00:00', SALLE)]
    const plan = planCopieHoraires(rules, [SALLE, BUREAU])
    assert.deepEqual(
      plan.map((entree) => entree.resourceId),
      [BUREAU],
    )
  })

  it('ne copie rien quand le centre n’a aucun horaire', () => {
    // Plutôt une ressource visiblement fermée qu'une amplitude inventée.
    assert.deepEqual(planCopieHoraires([], [SALLE, BUREAU]), [])
  })

  it('ne copie rien quand il n’y a aucune ressource', () => {
    assert.deepEqual(planCopieHoraires(semaineType, []), [])
  })

  it('est idempotent : rejouée après copie, elle ne propose plus rien', () => {
    const plan = planCopieHoraires(semaineType, [SALLE])
    const apres: OpeningRule[] = [
      ...semaineType,
      ...plan[0].ranges.map((range) => regle(range.weekday, range.opensAt, range.closesAt, SALLE)),
    ]
    assert.deepEqual(planCopieHoraires(apres, [SALLE]), [])
  })
})
