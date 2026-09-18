import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { slugify, uniqueSlug } from './slug.ts'

describe('slugify', () => {
  it('met en minuscules et relie par des tirets', () => {
    assert.equal(slugify('Salle Europe'), 'salle-europe')
  })

  it('retire les accents plutôt que de les encoder', () => {
    assert.equal(slugify('Salle Amérique du Sud'), 'salle-amerique-du-sud')
    assert.equal(slugify('Bureau à côté'), 'bureau-a-cote')
  })

  it('écarte la ponctuation et les espaces en trop', () => {
    assert.equal(slugify('  Bureau 201 — 2ᵉ étage ! '), 'bureau-201-2-etage')
  })

  it('ne laisse jamais de tiret aux extrémités', () => {
    assert.equal(slugify('--- test ---'), 'test')
    assert.equal(slugify('!!!'), '')
  })

  it('borne la longueur sans couper sur un tiret', () => {
    const slug = slugify('a'.repeat(100))
    assert.equal(slug.length, 80)
    assert.equal(slug.endsWith('-'), false)
  })
})

describe('uniqueSlug', () => {
  it('garde le slug libre tel quel', () => {
    assert.equal(uniqueSlug('Salle Europe', []), 'salle-europe')
  })

  it('suffixe un compteur quand le slug est pris', () => {
    assert.equal(uniqueSlug('Bureau 201', ['bureau-201']), 'bureau-201-2')
    assert.equal(uniqueSlug('Bureau 201', ['bureau-201', 'bureau-201-2']), 'bureau-201-3')
  })

  it('donne un slug même à un nom sans caractère utilisable', () => {
    assert.equal(uniqueSlug('!!!', []), 'annonce')
    assert.equal(uniqueSlug('!!!', ['annonce']), 'annonce-2')
  })
})
