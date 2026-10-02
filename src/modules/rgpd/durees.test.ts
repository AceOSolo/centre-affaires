import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  formatRetentionMonths,
  parseRetentionDurations,
  retentionDurations,
  retentionKeys,
  retentionValues,
  shortenedRetentions,
  type RetentionDurations,
} from './durees.ts'

/**
 * Durées de conservation réglées à l'écran (R29) : lues en entier, dans les
 * bornes de la base, sans en oublier une.
 */
const defauts: RetentionDurations = {
  prospectRetentionMonths: 36,
  clientRetentionMonths: 60,
  removedMemberRetentionMonths: 12,
  mailScanRetentionMonths: 12,
  mailAccessLogRetentionMonths: 12,
  publicRequestRetentionMonths: 12,
  notificationLogRetentionMonths: 12,
  inspectionPhotoRetentionMonths: 36,
  inspectionAccessLogRetentionMonths: 12,
}

const saisie = (valeurs: Partial<Record<keyof RetentionDurations, string>> = {}) => ({
  ...retentionValues(defauts),
  ...valeurs,
})

describe('durées de conservation du centre (R29)', () => {
  it('présente chaque durée de `tenants` une fois, avec son départ, son effet et son défaut', () => {
    assert.deepEqual(
      retentionDurations.map((duration) => duration.key),
      [...retentionKeys],
    )
    for (const duration of retentionDurations) {
      assert.equal(duration.defaultMonths, defauts[duration.key], duration.key)
      assert.ok(duration.label && duration.start && duration.effect && duration.status, duration.key)
    }
  })

  it('lit les neuf durées en mois', () => {
    assert.deepEqual(parseRetentionDurations(saisie({ clientRetentionMonths: ' 72 ' })), {
      ok: true,
      update: { ...defauts, clientRetentionMonths: 72 },
    })
  })

  it('tient les bornes de la base : de 1 à 120 mois, entiers', () => {
    const result = parseRetentionDurations(
      saisie({
        prospectRetentionMonths: '0',
        clientRetentionMonths: '121',
        removedMemberRetentionMonths: '1,5',
        mailScanRetentionMonths: '-3',
        notificationLogRetentionMonths: '',
        inspectionPhotoRetentionMonths: 'douze',
      }),
    )
    assert.equal(result.ok, false)
    assert.deepEqual(Object.keys(result.ok ? {} : result.fieldErrors).sort(), [
      'clientRetentionMonths',
      'inspectionPhotoRetentionMonths',
      'mailScanRetentionMonths',
      'notificationLogRetentionMonths',
      'prospectRetentionMonths',
      'removedMemberRetentionMonths',
    ])
    assert.equal(parseRetentionDurations(saisie({ prospectRetentionMonths: '1' })).ok, true)
    assert.equal(parseRetentionDurations(saisie({ prospectRetentionMonths: '120' })).ok, true)
  })

  it('refuse une durée manquante plutôt que de garder l’ancienne en silence', () => {
    const incomplete: Record<string, string | undefined> = saisie()
    delete incomplete.clientRetentionMonths
    const result = parseRetentionDurations(incomplete)
    assert.equal(result.ok, false)
    assert.deepEqual(Object.keys(result.ok ? {} : result.fieldErrors), ['clientRetentionMonths'])
  })

  it('dit la durée en années', () => {
    assert.equal(formatRetentionMonths(1), '1 mois')
    assert.equal(formatRetentionMonths(12), '12 mois (1 an)')
    assert.equal(formatRetentionMonths(18), '18 mois (1 an et 6 mois)')
    assert.equal(formatRetentionMonths(60), '60 mois (5 ans)')
  })

  it('repère les durées raccourcies, qui effacent dès la nuit suivante', () => {
    assert.deepEqual(shortenedRetentions(defauts, defauts), [])
    assert.deepEqual(
      shortenedRetentions(defauts, { ...defauts, clientRetentionMonths: 24, mailScanRetentionMonths: 24 }),
      ['clientRetentionMonths'],
    )
  })
})
