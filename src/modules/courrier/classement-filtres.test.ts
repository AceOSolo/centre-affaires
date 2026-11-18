import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { clientMailQuery, readClientMailFilters, readSenderFilter } from './demandes-regles.ts'

/**
 * Filtres de la boîte aux lettres, recette du 17/11 (ADR 078) : période, non
 * lus, catégorie, type de pli, expéditeur — combinables, gardés dans
 * l'adresse de la page, ignorés compris.
 */
describe('filtres combinés de la boîte aux lettres (ADR 078)', () => {
  it('lit ensemble période, suivi, catégorie, type et expéditeur', () => {
    assert.deepEqual(
      readClientMailFilters({
        du: '2026-11-01',
        au: '2026-11-17',
        suivi: 'non-lus',
        categorie: 'impots',
        type: 'recommande',
        expediteur: '  DGFiP   Lyon ',
      }),
      {
        kind: 'recommande',
        from: '2026-11-01',
        to: '2026-11-17',
        state: undefined,
        category: 'impots',
        followUp: 'non-lus',
        sender: 'DGFiP Lyon',
        page: 1,
      },
    )
  })

  it('retrouve les plis ignorés par leur rubrique', () => {
    assert.equal(readClientMailFilters({ suivi: 'ignores' }).followUp, 'ignores')
  })

  it('garde tous les filtres dans l’adresse, et les relit à l’identique', () => {
    const filters = {
      from: '2026-11-01',
      to: '2026-11-17',
      followUp: 'non-lus' as const,
      category: 'banque' as const,
      kind: 'lettre' as const,
      sender: 'Crédit & Cie',
    }
    const query = clientMailQuery(filters, 2)
    assert.equal(
      query,
      '?type=lettre&du=2026-11-01&au=2026-11-17&categorie=banque&suivi=non-lus&expediteur=Cr%C3%A9dit+%26+Cie&page=2',
    )
    const reread = readClientMailFilters(Object.fromEntries(new URLSearchParams(query.slice(1))))
    assert.deepEqual(reread, { ...filters, state: undefined, page: 2 })
  })

  it('ignore un expéditeur vide ou démesuré', () => {
    assert.equal(readSenderFilter('   '), undefined)
    assert.equal(readSenderFilter('x'.repeat(101)), undefined)
    assert.equal(readSenderFilter('URSSAF'), 'URSSAF')
  })
})
