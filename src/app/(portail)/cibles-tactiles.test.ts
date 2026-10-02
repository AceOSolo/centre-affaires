import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import ts from 'typescript'

/**
 * Revue mobile du portail (R25, `CLAUDE.md` : portail vérifié à 375 px, cibles
 * de 44 px), éprouvée sur les sources.
 *
 * Sans navigateur, on vérifie ce qui se lit dans les classes : chaque lien et
 * chaque bouton du portail et de l'espace client porte une hauteur d'au moins
 * 44 px (`min-h-11`, `size-11`, ou plus), sauf
 *
 * - un lien dans une phrase (« contactez le centre au 04… ») : WCAG 2.5.8
 *   l'exempte, l'agrandir casserait la ligne ;
 * - un élément réservé au grand écran (ancêtre `hidden` + `lg:block`…), où la
 *   cible minimale du web est de 24 px ;
 * - un composant qui reçoit ses classes de son appelant (`section-nav.tsx`) :
 *   ce sont ses appels qui sont vérifiés.
 *
 * Et aucune largeur fixe, sans préfixe d'écran, ne dépasse ce que laisse un
 * téléphone de 375 px moins ses marges : la page ne défile pas de côté.
 *
 * Les composants des modules affichés dans le portail (formulaires, actions)
 * ne sont pas parcourus ici : ceux de l'espace client suivent la même règle
 * (`min-h-11`), relue à chaque tranche.
 */

const ROOTS = ['src/app/(portail)', 'src/app/(impression)/compte']
/** Composants dont les cibles reçoivent leurs classes de l'appelant. */
const CALLER_STYLED = new Set(['section-nav.tsx'])
const TARGET_TAGS = new Set(['a', 'Link', 'button'])
/** 44 px et plus ; `focus:` pour le lien d'évitement, visible au seul focus. */
const TOUCH_CLASS = /^(?:focus:|focus-visible:)?(?:min-h|h|size)-(?:11|12|14|16)$/
/** Largeur utile d'un écran de 375 px, moins deux marges de 20 px. */
const MOBILE_CONTENT_PX = 335
const DESKTOP_ONLY = /^(?:sm|md|lg|xl):(?:block|flex|grid|inline-flex|inline-block|table)$/
const TEXT_PARENTS = new Set(['p', 'span', 'li', 'dd', 'small', 'label', 'td'])

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return tsxFiles(path)
    return entry.name.endsWith('.tsx') ? [path] : []
  })
}

type Parsed = { path: string; source: ts.SourceFile; topLevel: Map<string, ts.Node> }

function parse(path: string): Parsed {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const topLevel = new Map<string, ts.Node>()
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          topLevel.set(declaration.name.text, declaration.initializer)
        }
      }
    }
  }
  return { path, source, topLevel }
}

/**
 * Les classes écrites en dur dans une expression : chaînes, gabarits, et
 * constantes ou fonctions du même fichier (`filterClass(...)`).
 */
function literalTokens(node: ts.Node | undefined, file: Parsed, depth = 0): string[] {
  if (!node) return []
  const tokens: string[] = []
  const visit = (current: ts.Node) => {
    if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) {
      tokens.push(...current.text.split(/\s+/))
      return
    }
    if (ts.isTemplateHead(current) || ts.isTemplateMiddle(current) || ts.isTemplateTail(current)) {
      tokens.push(...current.text.split(/\s+/))
      return
    }
    if (ts.isIdentifier(current) && depth < 2) {
      const initializer = file.topLevel.get(current.text)
      if (initializer) tokens.push(...literalTokens(initializer, file, depth + 1))
      return
    }
    ts.forEachChild(current, visit)
  }
  visit(node)
  return tokens.filter(Boolean)
}

function attribute(element: ts.JsxOpeningLikeElement, name: string): ts.Node | undefined {
  for (const property of element.attributes.properties) {
    if (ts.isJsxAttribute(property) && property.name.getText() === name) {
      const initializer = property.initializer
      if (!initializer) return undefined
      return ts.isJsxExpression(initializer) ? initializer.expression : initializer
    }
  }
  return undefined
}

/** L'élément JSX qui contient celui-ci, en traversant fragments et expressions. */
function parentElement(node: ts.Node): ts.JsxElement | undefined {
  let current = node.parent
  while (current) {
    if (ts.isJsxElement(current) && current.openingElement !== node) return current
    current = current.parent
  }
  return undefined
}

function isDesktopOnly(node: ts.Node, file: Parsed): boolean {
  for (let current = parentElement(node); current; current = parentElement(current)) {
    const tokens = literalTokens(attribute(current.openingElement, 'className'), file)
    if (tokens.includes('hidden') && tokens.some((token) => DESKTOP_ONLY.test(token))) return true
  }
  return false
}

/** Un lien au fil d'une phrase : son paragraphe porte du texte à côté de lui. */
function isInlineInText(node: ts.Node): boolean {
  const parent = parentElement(node)
  if (!parent || !TEXT_PARENTS.has(parent.openingElement.tagName.getText())) return false
  const hasText = (current: ts.Node): boolean =>
    (ts.isJsxText(current) && current.text.replace(/&nbsp;/g, ' ').trim() !== '') ||
    (!ts.isJsxElement(current) && !ts.isJsxSelfClosingElement(current) && ts.forEachChild(current, hasText) === true)
  return parent.children.some(hasText)
}

const location = (file: Parsed, node: ts.Node) => {
  const { line } = file.source.getLineAndCharacterOfPosition(node.getStart())
  return `${file.path}:${line + 1}`
}

const parsed = ROOTS.flatMap(tsxFiles).map(parse)

describe('portail : cibles tactiles et largeur mobile (R25)', () => {
  it('parcourt bien les pages du portail et de l’espace client', () => {
    const paths = parsed.map((file) => file.path.replace(/\\/g, '/'))
    for (const expected of [
      'src/app/(portail)/layout.tsx',
      'src/app/(portail)/annonces/[slug]/page.tsx',
      'src/app/(portail)/compte/compte-nav.tsx',
      'src/app/(portail)/compte/factures/page.tsx',
      'src/app/(impression)/compte/factures/[id]/page.tsx',
    ]) {
      assert.ok(paths.includes(expected), `${expected} absent du parcours`)
    }
  })

  it('donne 44 px à chaque lien et bouton hors d’une phrase', () => {
    const tooSmall: string[] = []
    for (const file of parsed) {
      if (CALLER_STYLED.has(file.path.replace(/\\/g, '/').split('/').at(-1) ?? '')) continue
      const visit = (node: ts.Node) => {
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          const tag = node.tagName.getText()
          const holder = ts.isJsxOpeningElement(node) ? node.parent : node
          if (TARGET_TAGS.has(tag) && !isDesktopOnly(holder, file) && !isInlineInText(holder)) {
            const tokens = literalTokens(attribute(node, 'className'), file)
            if (!tokens.some((token) => TOUCH_CLASS.test(token))) {
              tooSmall.push(`${location(file, node)} <${tag}> ${tokens.join(' ') || '(sans classe)'}`)
            }
          }
          // Une navigation qui transmet ses classes : la version mobile est vérifiée.
          if (tag === 'SectionNav') {
            const own = literalTokens(attribute(node, 'className'), file)
            const desktopOnly = own.includes('hidden') && own.some((token) => DESKTOP_ONLY.test(token))
            const links = literalTokens(attribute(node, 'linkClassName'), file)
            if (!desktopOnly && !links.some((token) => TOUCH_CLASS.test(token))) {
              tooSmall.push(`${location(file, node)} <SectionNav linkClassName> ${links.join(' ')}`)
            }
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(file.source)
    }
    assert.deepEqual(tooSmall, [], `Cibles sous 44 px :\n${tooSmall.join('\n')}`)
  })

  it('ne fixe aucune largeur plus grande qu’un téléphone de 375 px', () => {
    const tooWide: string[] = []
    for (const file of parsed) {
      const visit = (node: ts.Node) => {
        if (ts.isJsxAttribute(node) && node.name.getText() === 'className') {
          const value = node.initializer && ts.isJsxExpression(node.initializer) ? node.initializer.expression : node.initializer
          for (const token of literalTokens(value, file)) {
            const scale = /^(?:min-)?w-(\d+(?:\.\d+)?)$/.exec(token)
            const pixels = /^(?:min-)?w-\[(\d+)px\]$/.exec(token)
            const width = scale ? Number(scale[1]) * 4 : pixels ? Number(pixels[1]) : 0
            if (width > MOBILE_CONTENT_PX) tooWide.push(`${location(file, node)} ${token} (${width} px)`)
          }
        }
        ts.forEachChild(node, visit)
      }
      visit(file.source)
    }
    assert.deepEqual(tooWide, [], `Largeurs fixes trop grandes :\n${tooWide.join('\n')}`)
  })

  it('réunit les six rubriques de l’espace client, dans l’ordre', () => {
    const nav = parsed.find((file) => file.path.replace(/\\/g, '/').endsWith('compte/compte-nav.tsx'))
    assert.ok(nav, 'compte-nav.tsx introuvable')
    const sections = nav.topLevel.get('sections')
    assert.ok(sections && ts.isArrayLiteralExpression(sections), 'liste `sections` introuvable')
    const hrefs = sections.elements.map((element) => {
      assert.ok(ts.isObjectLiteralExpression(element))
      const href = element.properties.find(
        (property): property is ts.PropertyAssignment =>
          ts.isPropertyAssignment(property) && property.name.getText() === 'href',
      )
      assert.ok(href && ts.isStringLiteral(href.initializer))
      return href.initializer.text
    })
    assert.deepEqual(hrefs, [
      '/compte/reservations',
      '/compte/courrier',
      '/compte/contrats',
      '/compte/factures',
      '/compte/historique',
      '/compte/preferences',
    ])
  })
})
