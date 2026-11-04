import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { mailRequestRefusal } from './demandes-queries.ts'
import { groupStartNotice } from './demandes-regles.ts'

/**
 * Ce que l'équipe lit quand la base refuse une étape d'une demande de
 * courrier (ADR 037, ADR 057) : un message en français, jamais une page
 * d'erreur du serveur. Une panne sans traduction rend `undefined` : l'action
 * la journalise et dit un message général.
 */
const erreurDriver = (errno: number, sqlMessage: string) =>
  Object.assign(new Error(sqlMessage), { errno, sqlMessage, code: 'ER_X' })
/** Enveloppe façon Drizzle : l'erreur d'origine descend d'un cran. */
const enveloppe = (cause: unknown) => Object.assign(new Error('Failed query'), { cause })

describe('refus de la base, dits à l’équipe', () => {
  it('reprend le message d’une garde (CA008), sans son code', () => {
    const refus = enveloppe(erreurDriver(1644, 'CA008: Ce courrier a été retiré : la demande se refuse.'))
    assert.equal(mailRequestRefusal(refus), 'Ce courrier a été retiré : la demande se refuse.')
  })

  it('dit qu’une étape non datée vient de règles de la base absentes, pas d’un motif manquant', () => {
    // Sans le trigger `mail_requests_before_update`, la prise en charge n'a pas de date.
    const refus = enveloppe(erreurDriver(3819, "Check constraint 'mail_requests_status_consistent' is violated."))
    const message = mailRequestRefusal(refus) ?? ''
    assert.match(message, /règles ne sont peut-être pas à jour/)
    assert.doesNotMatch(message, /motif/)
  })

  it('invite à recommencer après un verrou ou un interblocage', () => {
    for (const errno of [1205, 1213]) {
      assert.match(mailRequestRefusal(enveloppe(erreurDriver(errno, 'Lock wait timeout exceeded'))) ?? '', /réessayez/)
    }
  })

  it('laisse remonter une panne qu’il ne sait pas dire', () => {
    assert.equal(mailRequestRefusal(new Error('connect ECONNREFUSED')), undefined)
    assert.equal(mailRequestRefusal(enveloppe(erreurDriver(1644, 'CA014: écriture refusée'))), undefined)
  })
})

describe('bilan d’une prise en charge groupée', () => {
  it('ne dit rien sans bilan dans l’adresse', () => {
    assert.equal(groupStartNotice({ produit: 'domiciliation' }), undefined)
  })

  it('dit ce qui a été pris en charge et ce qui a été ignoré', () => {
    assert.deepEqual(groupStartNotice({ prises: '2', ignorees: '1' }), {
      done: '2 demandes prises en charge. 1 ignorée : déjà prise en charge, faite ou annulée entre-temps.',
      failure: undefined,
    })
    assert.equal(groupStartNotice({ prises: '0', ignorees: '0' })?.done, 'Aucune demande prise en charge.')
  })

  it('dit à part ce qui a échoué, sans le confondre avec un succès', () => {
    const notice = groupStartNotice({ prises: '1', ignorees: '0', echecs: '2' })
    assert.equal(notice?.done, '1 demande prise en charge.')
    assert.match(notice?.failure ?? '', /^2 demandes n’ont pas pu être prises en charge/)
  })

  it('ignore une valeur bricolée', () => {
    assert.equal(groupStartNotice({ prises: 'abc', ignorees: '-3' })?.done, 'Aucune demande prise en charge.')
  })
})
