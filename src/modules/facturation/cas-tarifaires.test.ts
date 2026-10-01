import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { wallClockToUtc } from '../../lib/dates.ts'
import { contractSchedule, scheduleTotalCents } from '../contrats/echeancier.ts'
import {
  GRILLE_REELLE,
  REGLES_PAR_DEFAUT,
  STATUT_DES_CAS,
  casContrats,
  casReservations,
} from './cas-tarifaires.ts'
import { quoteBooking } from './devis.ts'

/**
 * Rejoue le jeu de cas tarifaires figé (R10, ADR 016 D5) — statut : à valider
 * par l'exploitation. Un montant attendu corrigé par le centre fait échouer ce
 * test jusqu'à ce que la règle soit changée.
 */
const PARIS = 'Europe/Paris'

describe(`cas tarifaires des réservations (${STATUT_DES_CAS})`, () => {
  for (const cas of casReservations) {
    it(`${cas.id} — ${cas.libelle}`, () => {
      const outcome = quoteBooking({
        resource: cas.ressource,
        startsAt: wallClockToUtc(cas.debut, PARIS),
        endsAt: wallClockToUtc(cas.fin, PARIS),
        timeZone: PARIS,
        plans: [{ plan: cas.grille ?? GRILLE_REELLE, source: { kind: 'default' } }],
        rules: { ...REGLES_PAR_DEFAUT, ...cas.regles },
        discount: cas.remise,
      })
      assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.reason)
      if (!outcome.ok) return
      const { unit, quantity, netCents, vatCents, totalCents } = outcome.quote
      assert.deepEqual({ unit, quantity, netCents, vatCents, totalCents }, cas.attendu)
    })
  }
})

describe(`cas tarifaires des contrats (${STATUT_DES_CAS})`, () => {
  for (const cas of casContrats) {
    it(`${cas.id} — ${cas.libelle}`, () => {
      const periods = contractSchedule(
        cas.contrat,
        cas.options.versions ?? [],
        cas.jusquAu,
        cas.options.prorataRule,
      )
      assert.deepEqual(
        periods.flatMap((period) =>
          period.pieces.map((piece) => piece.amountCents + piece.oneOffCents),
        ),
        cas.attendu.echeances,
      )
      assert.equal(scheduleTotalCents(periods), cas.attendu.totalCents)
    })
  }

  it('chaque cas a un identifiant unique', () => {
    const ids = [...casReservations, ...casContrats].map((cas) => cas.id)
    assert.equal(new Set(ids).size, ids.length)
  })
})
