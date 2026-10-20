import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import ts from 'typescript'

/**
 * Deux règles de `CLAUDE.md` (UX/UI), éprouvées sur les sources du
 * back-office :
 *
 * - un tableau est enveloppé d'un `overflow-x-auto` : c'est lui qui défile de
 *   côté, jamais le corps de la page ;
 * - pas de police monospace : pour aligner codes, montants et horaires, la
 *   classe `.tabular` sur Rubik.
 */

const ROOT = 'src/app/(admin)'

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return tsxFiles(path)
    return entry.name.endsWith('.tsx') ? [path] : []
  })
}

const parse = (path: string) =>
  ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

/** Classes écrites d'un élément JSX : la valeur de `className`, telle qu'écrite. */
function classNameOf(element: ts.JsxOpeningLikeElement): string {
  const attribute = element.attributes.properties.find(
    (property): property is ts.JsxAttribute => ts.isJsxAttribute(property) && property.name.getText() === 'className',
  )
  return attribute?.initializer?.getText() ?? ''
}

describe('back-office : tableaux et polices (CLAUDE.md, UX/UI)', () => {
  const files = tsxFiles(ROOT)

  it('enveloppe chaque tableau d’un overflow-x-auto', () => {
    const unwrapped: string[] = []
    for (const path of files) {
      const source = parse(path)
      const visit = (node: ts.Node) => {
        if (ts.isJsxElement(node) && node.openingElement.tagName.getText() === 'table') {
          let parent: ts.Node | undefined = node.parent
          let wrapped = false
          while (parent && !wrapped) {
            wrapped = ts.isJsxElement(parent) && /\boverflow-x-auto\b/.test(classNameOf(parent.openingElement))
            parent = parent.parent
          }
          if (!wrapped) unwrapped.push(`${path}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`)
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
    assert.deepEqual(unwrapped, [])
  })

  it('n’emploie pas de police monospace', () => {
    const monospace = files.filter((path) => /\bfont-mono\b/.test(readFileSync(path, 'utf8')))
    assert.deepEqual(monospace, [])
  })
})
