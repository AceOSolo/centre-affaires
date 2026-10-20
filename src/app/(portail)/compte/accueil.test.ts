import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * L'accueil de l'espace client ne parle pas d'argent dû (ADR 046).
 *
 * Dolibarr facture ; les tables de facturation du site sont en sommeil. Un
 * « reste à régler » calculé depuis elles serait faux le jour où Dolibarr
 * émet une facture que le site ignore. La page « Factures » reste en place et
 * vide ; l'accueil ne l'annonce pas, ni en alerte ni en carte, jusqu'à la
 * seconde tranche Dolibarr.
 *
 * Éprouvé sur les sources, comme les gardes de l'espace
 * (`lib/auth/gardes-espace-client.test.ts`) : la page et son chargement
 * demandent une session et une base.
 */
const COMPTE = import.meta.dirname

/** Le code sans ses commentaires : une règle citée en commentaire ne compte pas. */
const code = (file: string) =>
  readFileSync(join(COMPTE, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

describe('accueil de l’espace client sans facturation du site', () => {
  it('ne calcule ni reste à régler ni factures échues', () => {
    const espace = code('espace.ts')
    assert.doesNotMatch(espace, /facturation\/compte-regles/)
    assert.doesNotMatch(espace, /\b(outstanding|overdueInvoices|invoiceCount)\b/)
  })

  it('n’affiche ni alerte ni carte de factures', () => {
    const accueil = code('page.tsx')
    assert.doesNotMatch(accueil, /\/compte\/factures/)
    assert.doesNotMatch(accueil, /\bformatCents\b/)
    assert.doesNotMatch(accueil, /à régler/)
  })
})
