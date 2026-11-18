import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  canonicalSender,
  currentSenderList,
  frequentMissing,
  knownSenders,
  MAX_SUGGESTED_SENDERS,
  MAX_OWN_SUGGESTIONS,
  MAX_SENDER_LENGTH,
  readSender,
  readSenderList,
  senderKey,
  senderSuggestions,
  STARTING_SENDERS,
  suggestionsFor,
  type SenderUse,
} from './expediteurs.ts'

/**
 * Expéditeur d'un pli (ADR 058) : saisie normalisée, suggestions de
 * l'entreprise, puis du centre, puis de la liste de départ, sans doublon.
 */
const ACME = 'client-acme'
const BETA = 'client-beta'
const use = (clientId: string, sender: string, uses: number, lastAt = '2026-11-01T09:00:00Z'): SenderUse => ({
  clientId,
  sender,
  uses,
  lastAt: new Date(lastAt),
})

describe('saisie de l’expéditeur', () => {
  it('ôte les espaces superflus et les caractères de contrôle', () => {
    assert.deepEqual(readSender('  Cabinet   Martin \n et\tassociés  '), { sender: 'Cabinet Martin et associés' })
  })

  it('un champ vide ou absent : pas d’expéditeur', () => {
    assert.deepEqual(readSender('   '), { sender: null })
    assert.deepEqual(readSender(undefined), { sender: null })
    assert.deepEqual(readSender(null), { sender: null })
  })

  it('refuse un expéditeur trop long plutôt que de le couper', () => {
    const read = readSender('x'.repeat(MAX_SENDER_LENGTH + 1))
    assert.equal(read.sender, null)
    assert.match(read.error ?? '', /120 caractères au plus/)
    assert.deepEqual(readSender('x'.repeat(MAX_SENDER_LENGTH)), { sender: 'x'.repeat(MAX_SENDER_LENGTH) })
  })
})

describe('même expéditeur, autre écriture', () => {
  it('ignore la casse, les accents et la ponctuation', () => {
    assert.equal(senderKey('Impôts / DGFiP'), senderKey('impots dgfip'))
    assert.equal(senderKey('  URSSAF '), senderKey('urssaf'))
    assert.notEqual(senderKey('CAF'), senderKey('CAF 69'))
  })

  it('ramène la saisie à l’écriture connue', () => {
    assert.equal(canonicalSender('urssaf', STARTING_SENDERS), 'URSSAF')
    assert.equal(canonicalSender('impots - dgfip', STARTING_SENDERS), 'Impôts / DGFiP')
    assert.equal(canonicalSender('Cabinet Martin', STARTING_SENDERS), 'Cabinet Martin')
  })

  it('préfère l’écriture de la liste de départ, puis la plus employée au centre', () => {
    const known = knownSenders([use(ACME, 'urssaf', 9), use(ACME, 'cabinet martin', 1), use(BETA, 'Cabinet Martin', 4)])
    assert.equal(canonicalSender('URSSAF ', known), 'URSSAF')
    assert.equal(canonicalSender('CABINET MARTIN', known), 'Cabinet Martin')
  })
})

describe('suggestions d’expéditeurs', () => {
  const uses = [
    use(ACME, 'Cabinet Martin', 2),
    use(ACME, 'urssaf', 5),
    use(BETA, 'Fournisseur Delta', 7),
    use(BETA, 'URSSAF', 1),
    use(BETA, 'Cabinet Martin', 1, '2026-11-03T09:00:00Z'),
  ]

  it('propose d’abord ceux de l’entreprise, les plus fréquents en tête, dans l’écriture retenue', () => {
    const suggestions = senderSuggestions(uses, [ACME])
    assert.deepEqual(suggestions.byClient[ACME], ['URSSAF', 'Cabinet Martin'])
    const list = suggestionsFor(suggestions, ACME)
    assert.deepEqual(list.slice(0, 3), ['URSSAF', 'Cabinet Martin', 'Fournisseur Delta'])
  })

  it('puis ceux du centre, puis la liste de départ, sans doublon', () => {
    const list = suggestionsFor(senderSuggestions(uses, [ACME]), ACME)
    const keys = list.map(senderKey)
    assert.equal(new Set(keys).size, keys.length)
    // Le centre : Delta (7), URSSAF (6), Cabinet Martin (3) ; puis la liste de départ.
    assert.ok(list.includes('Fournisseur Delta'))
    assert.ok(list.indexOf('Fournisseur Delta') < list.indexOf('CAF'))
    for (const sender of STARTING_SENDERS) assert.ok(list.includes(sender), sender)
  })

  it('un centre qui commence : la liste de départ seule', () => {
    const suggestions = senderSuggestions([], [ACME])
    assert.deepEqual(suggestions.byClient[ACME], [])
    assert.deepEqual(suggestionsFor(suggestions, ACME), [...STARTING_SENDERS])
    assert.deepEqual(suggestionsFor(suggestions, null), [...STARTING_SENDERS])
  })

  it('une entreprise inconnue de l’écran reçoit celles du centre', () => {
    const suggestions = senderSuggestions(uses, [ACME])
    assert.equal(suggestions.byClient[BETA], undefined)
    assert.equal(suggestionsFor(suggestions, BETA)[0], 'Fournisseur Delta')
  })

  it('borne les suggestions propres à une entreprise', () => {
    const many = Array.from({ length: MAX_OWN_SUGGESTIONS + 5 }, (_, i) => use(ACME, `Expéditeur ${i}`, i + 1))
    assert.equal(senderSuggestions(many, [ACME]).byClient[ACME].length, MAX_OWN_SUGGESTIONS)
    assert.equal(senderSuggestions(many, [ACME]).byClient[ACME][0], `Expéditeur ${MAX_OWN_SUGGESTIONS + 4}`)
  })
})

describe('liste des expéditeurs réglée par le centre (ADR 079)', () => {
  const uses = [
    use(ACME, 'URSSAF', 4),
    use(ACME, 'Cabinet Martin', 3),
    use(BETA, 'Fournisseur Delta', 9),
    use(BETA, 'Free', 2),
  ]

  it('ne change rien tant que le centre n’y a pas touché', () => {
    assert.deepEqual(senderSuggestions(uses, [ACME], null), senderSuggestions(uses, [ACME]))
    // Le point de départ de l'écran : exactement ce que l'accueil voit.
    assert.deepEqual(currentSenderList(uses, null), senderSuggestions(uses, []).centre)
    assert.equal(currentSenderList(uses, null)[0], 'Fournisseur Delta')
  })

  it('réglée, elle remplace les suggestions du centre, dans son ordre', () => {
    const list = ['Impôts / DGFiP', 'URSSAF', 'Banque du Léman']
    const suggestions = senderSuggestions(uses, [ACME], list)
    assert.deepEqual(suggestions.centre, list)
    // Un expéditeur retiré de la liste n'est plus proposé à une autre entreprise…
    assert.equal(suggestionsFor(suggestions, BETA).includes('Free'), false)
    assert.deepEqual(suggestionsFor(suggestions, null), list)
    // … mais ceux déjà saisis pour l'entreprise du pli restent en tête.
    assert.deepEqual(suggestionsFor(suggestions, ACME).slice(0, 2), ['URSSAF', 'Cabinet Martin'])
    assert.equal(suggestionsFor(suggestions, ACME).filter((sender) => sender === 'URSSAF').length, 1)
  })

  it('ramène une saisie à l’écriture de la liste du centre', () => {
    const list = ['Banque du Léman']
    assert.equal(canonicalSender('banque du leman', knownSenders(uses, list)), 'Banque du Léman')
    // Les écritures déjà saisies au centre restent connues.
    assert.equal(canonicalSender('fournisseur delta', knownSenders(uses, list)), 'Fournisseur Delta')
  })

  it('propose d’ajouter les expéditeurs souvent saisis qui n’y sont pas', () => {
    assert.deepEqual(frequentMissing(uses, ['urssaf', 'Free']), ['Fournisseur Delta', 'Cabinet Martin'])
    assert.deepEqual(frequentMissing(uses, currentSenderList(uses, null)), [])
  })

  it('lit la liste saisie : lignes normalisées, lignes vides retirées, ordre gardé', () => {
    assert.deepEqual(readSenderList(['  URSSAF ', '', 'Impôts   /  DGFiP', '   ']), {
      list: ['URSSAF', 'Impôts / DGFiP'],
      lineErrors: {},
    })
    assert.deepEqual(readSenderList([]), { list: [], lineErrors: {} })
  })

  it('refuse un doublon, à la casse, aux accents et à la ponctuation près, sur sa seconde ligne', () => {
    const read = readSenderList(['Impôts / DGFiP', 'URSSAF', 'impots dgfip'])
    assert.deepEqual(read.list, ['Impôts / DGFiP', 'URSSAF'])
    assert.match(read.lineErrors[2], /Déjà dans la liste, ligne 1 : « Impôts \/ DGFiP »/)
  })

  it('refuse une ligne trop longue ou sans lettre ni chiffre, et une liste trop longue', () => {
    const read = readSenderList(['x'.repeat(MAX_SENDER_LENGTH + 1), '---'])
    assert.deepEqual(read.list, [])
    assert.ok(read.lineErrors[0])
    assert.ok(read.lineErrors[1])
    const many = readSenderList(Array.from({ length: MAX_SUGGESTED_SENDERS + 1 }, (_, i) => `Expéditeur ${i}`))
    assert.match(many.error ?? '', /200 au plus/)
  })
})
