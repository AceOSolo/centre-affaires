import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, it } from 'node:test'

/**
 * Chaque porte de l'espace client revérifie le compte (ADR 015, ADR 019).
 *
 * La coque `compte/layout.tsx` ne protège pas une page appelée seule, et les
 * vues imprimables de l'espace (`(impression)/compte`) n'ont pas de coque du
 * tout. Ce test relit les sources et refuse une page ou une route de l'espace
 * sans `requireClientAccount()` : c'est lui qui dit quelles entreprises
 * forment la portée client des requêtes (`inClientSpace`).
 */
const SRC = join(import.meta.dirname, '..', '..')
const ESPACES = [join(SRC, 'app', '(portail)', 'compte'), join(SRC, 'app', '(impression)', 'compte')]

/** L'entrée de l'espace ne fait que rediriger vers une rubrique gardée. */
const REDIRECTIONS = ['app/(portail)/compte/page.tsx']

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  )

const rel = (file: string) => relative(SRC, file).split(sep).join('/')

/** Le code sans ses commentaires : une garde citée dans un commentaire ne garde rien. */
const code = (file: string) =>
  readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

describe('gardes de l’espace client', () => {
  const portes = ESPACES.flatMap(walk).filter((file) => /[/\\](page\.tsx|route\.ts|layout\.tsx)$/.test(file))

  it('trouve les pages de l’espace client, imprimables comprises', () => {
    const chemins = portes.map(rel)
    for (const attendu of [
      'app/(portail)/compte/factures/page.tsx',
      'app/(portail)/compte/contrats/page.tsx',
      'app/(portail)/compte/historique/page.tsx',
      'app/(impression)/compte/factures/[id]/page.tsx',
      'app/(impression)/compte/contrats/[id]/document/page.tsx',
    ]) {
      assert.ok(chemins.includes(attendu), `${attendu} introuvable`)
    }
  })

  it('revérifie le compte dans chaque page et chaque route', () => {
    const sansGarde = portes
      .filter((file) => !REDIRECTIONS.includes(rel(file)))
      .filter((file) => !/\brequireClientAccount\(\)/.test(code(file)))
      .map(rel)
    assert.deepEqual(sansGarde, [])
  })
})
