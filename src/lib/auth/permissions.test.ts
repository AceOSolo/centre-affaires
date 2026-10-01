import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { staffRoles } from '../../db/staff.ts'
import {
  can,
  isPermission,
  permissionLabels,
  permissions,
  permissionsOf,
  rolePermissions,
  rolesAllowed,
  type Permission,
} from './permissions.ts'

/**
 * Matrice des droits de l'équipe (R27, ADR 019). Une erreur ici ouvre à
 * l'accueil ce qui revient à l'exploitant — les tarifs, les contrats,
 * l'équipe — ou ferme à l'accueil son travail du quotidien.
 */
describe('matrice des droits', () => {
  /** L'opérationnel du quotidien : l'accueil. */
  const quotidien: Permission[] = [
    'reservations.gerer',
    'demandes.traiter',
    'clients.gerer',
    'courrier.gerer',
    'contrats.consulter',
  ]
  /** Ce qui engage le centre : l'exploitant seul. */
  const reserve: Permission[] = [
    'equipe.gerer',
    'tarifs.gerer',
    'ressources.gerer',
    'horaires.gerer',
    'contrats.creer',
    'contrats.activer',
    'contrats.resilier',
    'contrats.archiver',
    'clients.archiver',
    'courrier.releve',
    'centre.configurer',
    'agenda-google.gerer',
  ]

  it('couvre chaque rôle de l’équipe', () => {
    assert.deepEqual(Object.keys(rolePermissions).sort(), [...staffRoles].sort())
  })

  it('donne tout à l’exploitant', () => {
    for (const permission of permissions) assert.equal(can('admin', permission), true, permission)
  })

  it('donne à l’accueil l’opérationnel du quotidien', () => {
    for (const permission of quotidien) assert.equal(can('staff', permission), true, permission)
  })

  it('réserve à l’exploitant l’équipe, les tarifs, les contrats et la configuration', () => {
    for (const permission of reserve) {
      assert.equal(can('staff', permission), false, permission)
      assert.deepEqual(rolesAllowed(permission), ['Exploitant'], permission)
    }
  })

  it('classe chaque droit : aucun n’échappe à la répartition', () => {
    // Un droit ajouté sans décision explicite sur l'accueil fait échouer ce
    // test : la répartition se tranche, elle ne s'hérite pas par défaut.
    assert.deepEqual([...quotidien, ...reserve].sort(), [...permissions].sort())
  })

  it('ne permet rien sans rôle', () => {
    for (const permission of permissions) {
      assert.equal(can(undefined, permission), false)
      assert.equal(can(null, permission), false)
    }
    assert.deepEqual(permissionsOf(undefined), [])
  })

  it('ne permet rien à un rôle inconnu', () => {
    // Une valeur ajoutée à l'énumération en base avant le code : fermé par défaut.
    assert.equal(can('stagiaire' as never, 'reservations.gerer'), false)
  })

  it('rend les droits d’un rôle dans l’ordre de la liste', () => {
    assert.deepEqual(permissionsOf('admin'), [...permissions])
    assert.deepEqual(permissionsOf('staff'), quotidien)
  })

  it('reconnaît un droit et refuse le reste', () => {
    assert.equal(isPermission('tarifs.gerer'), true)
    assert.equal(isPermission('tarifs'), false)
    assert.equal(isPermission(undefined), false)
    assert.equal(isPermission(42), false)
  })

  it('libelle chaque droit', () => {
    for (const permission of permissions) assert.ok(permissionLabels[permission].length > 0)
  })
})
