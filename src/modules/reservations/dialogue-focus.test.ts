import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Focus dans le dialogue de réservation de la page publique (`CLAUDE.md` :
 * accessibilité clavier, focus visible partout, y compris dans les dialogues).
 *
 * Choisir un produit, ou revenir sur ce choix (« Changer »), retire du dialogue
 * le bouton qui avait le focus. Sans relais, le focus retombe sur la page et
 * le lecteur d'écran n'annonce rien. Chaque écran du dialogue — le choix du
 * produit, chaque formulaire — met donc le focus sur son titre en s'ouvrant,
 * et ce titre montre le même repère clavier que les actions.
 *
 * Éprouvé sur les sources : le dialogue natif (`showModal`) demande un
 * navigateur.
 */
const read = (file: string) => readFileSync(join(import.meta.dirname, file), 'utf8')

const FILES = ['booking-dialog.tsx', 'public-booking-form.tsx', 'public-domiciliation-form.tsx', 'etapes-demande.tsx']

describe('focus du dialogue de réservation', () => {
  it('chaque formulaire met le focus sur son titre en s’ouvrant', () => {
    for (const file of ['public-booking-form.tsx', 'public-domiciliation-form.tsx']) {
      assert.match(read(file), /useEffect\(\(\) => showStep\(headingRef\), \[\]\)/, file)
    }
  })

  it('le choix du produit reprend le focus quand il réapparaît', () => {
    assert.match(read('booking-dialog.tsx'), /useEffect\(\(\) => \{ if \(choosing\) showStep\(choiceHeadingRef\) \}, \[choosing\]\)/)
  })

  it('tout titre focalisable par programme montre un repère de focus', () => {
    const sansRepere: string[] = []
    for (const file of FILES) {
      for (const [heading] of read(file).matchAll(/<h[1-6]\b[^>]*tabIndex=\{-1\}[^>]*>/g)) {
        if (/\boutline-none\b/.test(heading) || !/focusClass|focus-visible:/.test(heading)) sansRepere.push(`${file} : ${heading}`)
      }
    }
    assert.deepEqual(sansRepere, [])
  })
})
