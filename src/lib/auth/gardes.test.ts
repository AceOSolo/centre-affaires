import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, it } from 'node:test'

import { isPermission } from './permissions.ts'

/**
 * Chaque porte du back-office porte sa garde (R27, ADR 019).
 *
 * La matrice des droits ne protège rien si une page ou une action l'oublie :
 * une action serveur s'invoque par son identifiant depuis n'importe quel
 * chemin, et la coque du back-office ne vérifie que l'appartenance à
 * l'équipe. Ce test relit les sources et refuse une page, une route ou une
 * action sans `requirePermission()`.
 */
const SRC = join(import.meta.dirname, '..', '..')
const ADMIN = join(SRC, 'app', '(admin)')

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

/**
 * Page du back-office volontairement ouverte à tout membre : celle qui
 * explique un refus.
 */
const OUVERTES_A_TOUTE_L_EQUIPE = ['app/(admin)/acces-reserve/page.tsx']

/** Actions ouvertes à tous, sans compte : la demande de réservation publique (ADR 005). */
const ACTIONS_PUBLIQUES = ['modules/reservations/public-actions.ts']

describe('gardes du back-office', () => {
  const portes = walk(ADMIN).filter((file) => /[/\\](page\.tsx|route\.ts)$/.test(file))

  it('trouve les pages et les routes à vérifier', () => {
    assert.ok(portes.length > 20, `${portes.length} portes seulement`)
  })

  it('garde chaque page et chaque route par un droit', () => {
    const sansGarde = portes
      .filter((file) => !OUVERTES_A_TOUTE_L_EQUIPE.includes(rel(file)))
      .filter((file) => !/\brequirePermission\(\s*'[^']+'\s*\)/.test(code(file)))
      .map(rel)
    assert.deepEqual(sansGarde, [])
  })

  it('n’appelle plus requireStaff ni requireAdmin hors de la coque', () => {
    const anciennes = walk(SRC)
      .filter((file) => /\.(ts|tsx)$/.test(file) && !/\.test\.ts$/.test(file))
      .filter((file) => !['lib/auth/staff.ts', 'app/(admin)/layout.tsx', ...OUVERTES_A_TOUTE_L_EQUIPE].includes(rel(file)))
      .filter((file) => /\brequire(Staff|Admin)\(\)/.test(code(file)))
      .map(rel)
    assert.deepEqual(anciennes, [])
  })

  it('garde chaque action serveur, une par une', () => {
    const fautives: string[] = []
    for (const file of walk(SRC).filter((f) => /\.(ts|tsx)$/.test(f))) {
      const source = code(file)
      if (!/^\s*['"]use server['"]/.test(source)) continue
      if (ACTIONS_PUBLIQUES.includes(rel(file))) continue
      // Chaque fonction exportée, jusqu'à la suivante : la garde doit être
      // dans son corps, pas dans celui de sa voisine.
      const corps = source.split(/^export async function /m).slice(1)
      for (const fonction of corps) {
        const nom = fonction.slice(0, fonction.indexOf('('))
        if (!/\b(requirePermission\(\s*'[^']+'\s*\)|requireClientAccount\(\))/.test(fonction)) {
          fautives.push(`${rel(file)} → ${nom}`)
        }
      }
    }
    assert.deepEqual(fautives, [])
  })

  it('ne cite que des droits de la matrice', () => {
    const inconnus = walk(SRC)
      .filter((file) => /\.(ts|tsx)$/.test(file))
      .flatMap((file) =>
        [...code(file).matchAll(/\brequirePermission\(\s*'([^']+)'\s*\)/g)].map(
          (match) => match[1],
        ),
      )
      .filter((permission) => !isPermission(permission))
    assert.deepEqual(inconnus, [])
  })
})
