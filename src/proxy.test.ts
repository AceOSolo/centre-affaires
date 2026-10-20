import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import ts from 'typescript'

/**
 * Le filtre d'accès (`proxy.ts`) doit couvrir chaque écran du back-office :
 * sans lui, une personne sans session qui ouvre un lien vers `/aujourdhui`
 * n'est pas renvoyée vers la connexion avec la page demandée, et la perd.
 *
 * `proxy.ts` importe Next, que le lanceur de tests ne charge pas : la liste
 * est lue dans la source, telle que Next la lit (littérale, exigée par lui).
 */
const source = readFileSync(join(import.meta.dirname, 'proxy.ts'), 'utf8')

function matcher(): string[] {
  const fichier = ts.createSourceFile('proxy.ts', source, ts.ScriptTarget.Latest)
  let entrees: string[] | undefined
  const visiter = (noeud: ts.Node) => {
    if (
      ts.isPropertyAssignment(noeud) &&
      ts.isIdentifier(noeud.name) &&
      noeud.name.text === 'matcher' &&
      ts.isArrayLiteralExpression(noeud.initializer)
    ) {
      entrees = noeud.initializer.elements.map((element) => {
        assert.ok(ts.isStringLiteral(element), 'matcher : uniquement des chaînes littérales')
        return element.text
      })
    }
    ts.forEachChild(noeud, visiter)
  }
  visiter(fichier)
  assert.ok(entrees, 'matcher introuvable dans proxy.ts')
  return entrees
}

/** Premiers segments des écrans d'un groupe de routes (`app/(admin)`…). */
const ecrans = (groupe: string) =>
  readdirSync(join(import.meta.dirname, 'app', groupe), { withFileTypes: true })
    .filter((entree) => entree.isDirectory())
    .map((entree) => entree.name)

describe('filtre d’accès au back-office', () => {
  const entrees = matcher()

  it('couvre chaque écran du back-office', () => {
    const manquants = ecrans('(admin)').filter((ecran) => !entrees.includes(`/${ecran}/:path*`))
    assert.deepEqual(manquants, [])
  })

  it('couvre l’espace client et les pages à imprimer', () => {
    assert.ok(entrees.includes('/compte/:path*'))
    const manquants = ecrans('(impression)').filter((ecran) => !entrees.includes(`/${ecran}/:path*`))
    assert.deepEqual(manquants, [])
  })

  it('laisse passer la connexion, le relais d’authentification et le site public', () => {
    for (const libre of ['/auth', '/api', '/annonces', '/_next']) {
      assert.ok(
        entrees.every((entree) => !entree.startsWith(`${libre}/`) && entree !== libre),
        `${libre} doit rester joignable sans session`,
      )
    }
  })
})
