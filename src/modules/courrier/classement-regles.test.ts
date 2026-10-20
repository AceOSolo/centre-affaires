import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  applyClassification,
  classificationDoneMessage,
  emptyClassification,
  readCategoryFilter,
  readClassificationChange,
  readFollowUpFilter,
  readTagFilter,
  readTags,
  type MailClassification,
} from './classement-regles.ts'

const now = new Date('2026-10-20T08:00:00Z')
const before = new Date('2026-10-19T08:00:00Z')

describe('étiquettes saisies (ADR 044)', () => {
  it('sépare par virgules ou points-virgules, resserre les espaces, ignore le vide', () => {
    assert.deepEqual(readTags('  à payer ,comptable;;  dossier   Martin  '), {
      tags: ['à payer', 'comptable', 'dossier Martin'],
    })
    assert.deepEqual(readTags(''), { tags: [] })
  })

  it('retire les doublons à la casse près, la première forme l’emporte', () => {
    assert.deepEqual(readTags('URSSAF, urssaf, Urssaf'), { tags: ['URSSAF'] })
  })

  it('refuse une étiquette trop longue, ou plus de dix étiquettes', () => {
    assert.match(readTags('x'.repeat(31)).error ?? '', /30 caractères/)
    const onze = Array.from({ length: 11 }, (_, index) => `e${index}`).join(',')
    assert.match(readTags(onze).error ?? '', /10 étiquettes/)
  })
})

describe('gestes de classement', () => {
  it('marque lu une fois : la première lecture reste datée', () => {
    const lu = applyClassification(emptyClassification, { type: 'read' }, before)
    assert.equal(applyClassification(lu, { type: 'read' }, now).readAt, before)
    assert.equal(applyClassification(lu, { type: 'unread' }, now).readAt, null)
  })

  it('marquer traité marque lu ; remettre à traiter garde la lecture', () => {
    const traite = applyClassification(emptyClassification, { type: 'handled' }, now)
    assert.equal(traite.readAt, now)
    assert.equal(traite.handledAt, now)
    const repris = applyClassification(traite, { type: 'unhandled' }, now)
    assert.equal(repris.handledAt, null)
    assert.equal(repris.readAt, now)
  })

  it('classe dans une catégorie, ou déclasse', () => {
    const classe = applyClassification(emptyClassification, { type: 'category', category: 'impots' }, now)
    assert.equal(classe.category, 'impots')
    assert.equal(applyClassification(classe, { type: 'category', category: null }, now).category, null)
  })

  it('ajoute une étiquette sans doublon, dix au plus', () => {
    const une: MailClassification = { ...emptyClassification, tags: ['À payer'] }
    assert.deepEqual(applyClassification(une, { type: 'addTag', tag: ' à  payer ' }, now).tags, ['À payer'])
    assert.deepEqual(applyClassification(une, { type: 'addTag', tag: 'comptable' }, now).tags, [
      'À payer',
      'comptable',
    ])
    const pleine: MailClassification = {
      ...emptyClassification,
      tags: Array.from({ length: 10 }, (_, index) => `e${index}`),
    }
    assert.equal(applyClassification(pleine, { type: 'addTag', tag: 'de trop' }, now).tags.length, 10)
  })

  it('retire une étiquette à la casse près, et remplace la liste', () => {
    const deux: MailClassification = { ...emptyClassification, tags: ['À payer', 'comptable'] }
    assert.deepEqual(applyClassification(deux, { type: 'removeTag', tag: 'à payer' }, now).tags, ['comptable'])
    assert.deepEqual(applyClassification(deux, { type: 'setTags', tags: ['x', 'X', ' '] }, now).tags, ['x'])
  })
})

describe('barre de sélection', () => {
  it('lit chaque geste', () => {
    assert.deepEqual(readClassificationChange('lu', ''), { change: { type: 'read' } })
    assert.deepEqual(readClassificationChange('traite', ''), { change: { type: 'handled' } })
    assert.deepEqual(readClassificationChange('classer', 'banque'), {
      change: { type: 'category', category: 'banque' },
    })
    assert.deepEqual(readClassificationChange('classer', 'non-classe'), {
      change: { type: 'category', category: null },
    })
    assert.deepEqual(readClassificationChange('etiqueter', ' à payer '), {
      change: { type: 'addTag', tag: 'à payer' },
    })
  })

  it('refuse un geste incomplet ou inconnu', () => {
    assert.ok(readClassificationChange('classer', 'loisirs').error)
    assert.ok(readClassificationChange('etiqueter', '  ').error)
    assert.ok(readClassificationChange('supprimer', '').error)
  })

  it('confirme au singulier et au pluriel', () => {
    assert.equal(classificationDoneMessage('traite', 1), '1 courrier marqué comme traité.')
    assert.equal(classificationDoneMessage('lu', 3), '3 courriers marqués comme lus.')
  })
})

describe('rubriques lues dans l’URL', () => {
  it('garde les valeurs connues, ignore le reste', () => {
    assert.equal(readCategoryFilter('impots'), 'impots')
    assert.equal(readCategoryFilter('non-classe'), 'non-classe')
    assert.equal(readCategoryFilter('loisirs'), undefined)
    assert.equal(readFollowUpFilter('a-traiter'), 'a-traiter')
    assert.equal(readFollowUpFilter('tous'), undefined)
    assert.equal(readTagFilter('  à   payer '), 'à payer')
    assert.equal(readTagFilter('x'.repeat(31)), undefined)
  })
})
