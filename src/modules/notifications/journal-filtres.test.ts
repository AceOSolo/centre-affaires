import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { journalHref, journalPeriodUtc, parseJournalFilters, recipientPattern } from './journal-filtres.ts'

describe('filtres du journal des envois', () => {
  it('lit événement, statut, période, destinataire et page', () => {
    const { filters, errors } = parseJournalFilters({
      evenement: 'invoice_issued',
      statut: 'failed',
      du: '2026-09-01',
      au: '2026-09-30',
      destinataire: ' Compta@Durand ',
      page: '3',
    })
    assert.deepEqual(errors, {})
    assert.deepEqual(filters, {
      event: 'invoice_issued',
      status: 'failed',
      from: '2026-09-01',
      to: '2026-09-30',
      recipient: 'compta@durand',
      page: 3,
    })
  })

  it('ignore et signale une valeur illisible, sans l’interpréter', () => {
    const { filters, errors } = parseJournalFilters({ evenement: 'drop table', statut: 'perdu', du: '31/09/2026' })
    assert.deepEqual(filters, { page: 1 })
    assert.ok(errors.evenement && errors.statut && errors.du)
  })

  it('refuse une période à l’envers', () => {
    const { filters, errors } = parseJournalFilters({ du: '2026-10-01', au: '2026-09-01' })
    assert.equal(filters.to, undefined)
    assert.ok(errors.au)
  })

  it('prend la première valeur d’un paramètre répété, et une page entière positive', () => {
    assert.equal(parseJournalFilters({ statut: ['sent', 'failed'] }).filters.status, 'sent')
    assert.equal(parseJournalFilters({ page: '-2' }).filters.page, 1)
    assert.equal(parseJournalFilters({ page: '1.5' }).filters.page, 1)
  })

  it('borne la période aux jours du centre, en [) et en UTC', () => {
    // Paris, heure d'été : minuit du 1er septembre = 22:00 UTC la veille.
    const { from, to } = journalPeriodUtc({ from: '2026-09-01', to: '2026-09-30' }, 'Europe/Paris')
    assert.equal(from?.toISOString(), '2026-08-31T22:00:00.000Z')
    assert.equal(to?.toISOString(), '2026-09-30T22:00:00.000Z')
  })

  it('cherche une partie d’adresse sans laisser % ni _ devenir des jokers', () => {
    assert.equal(recipientPattern('a_b%c'), '%a\\_b\\%c%')
  })

  it('garde les filtres dans les liens de pagination', () => {
    assert.equal(
      journalHref({ evenement: 'mail_received', statut: '', du: '', au: '', destinataire: 'durand' }, 2),
      '/notifications?evenement=mail_received&destinataire=durand&page=2',
    )
    assert.equal(journalHref({ evenement: '', statut: '', du: '', au: '', destinataire: '' }, 1), '/notifications')
  })
})
