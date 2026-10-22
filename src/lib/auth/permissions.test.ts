import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { staffRoles } from '../../db/staff.ts'
import {
  can,
  dolibarrPermissions,
  isPermission,
  permissionLabels,
  permissions,
  permissionsOf,
  rolePermissions,
  rolesAllowed,
  type Permission,
} from './permissions.ts'

/**
 * Matrice des droits de l'équipe (R27, ADR 019, ADR 054). Une erreur ici ouvre
 * à l'accueil ce qui revient à l'exploitant — les tarifs, les contrats,
 * l'équipe —, à l'exploitant la nomination des exploitants, réservée à la
 * direction, ou ferme à l'accueil son travail du quotidien.
 */
describe('matrice des droits', () => {
  /** L'opérationnel du quotidien : l'accueil. */
  const quotidien: Permission[] = [
    'reservations.gerer',
    'demandes.traiter',
    'clients.gerer',
    'courrier.gerer',
    'contrats.consulter',
    'notifications.consulter',
    'etats-des-lieux.gerer',
    'comptes.rattacher',
    'espace-client.personnel',
  ]
  /** Ce qui engage le centre : l'exploitant et la direction. */
  const reserve: Permission[] = [
    'equipe.gerer',
    'tarifs.gerer',
    'ressources.gerer',
    'horaires.gerer',
    'contrats.creer',
    'contrats.activer',
    'contrats.resilier',
    'contrats.archiver',
    'contrats.avenants',
    'services.gerer',
    'souscriptions.gerer',
    'indicateurs.consulter',
    'clients.archiver',
    'courrier.releve',
    'centre.configurer',
    'agenda-google.gerer',
    'notifications.gerer',
    'etats-des-lieux.modeles',
    'rgpd.anonymiser',
    // Bannir ferme l'accès d'une personne au centre (ADR 045).
    'comptes.gerer',
  ]
  /** La tenue des exploitants : la direction seule (ADR 054). */
  const direction: Permission[] = ['equipe.exploitants']

  it('couvre chaque rôle de l’équipe', () => {
    assert.deepEqual(Object.keys(rolePermissions).sort(), [...staffRoles].sort())
  })

  /** Tenu dans Dolibarr (ADR 046) : personne, sur le site. */
  const dolibarr: Permission[] = [
    'facturation.consulter',
    'facturation.gerer',
    'paiements.gerer',
    'comptabilite.exporter',
  ]

  it('donne tout à la direction, sauf ce qui est dans Dolibarr', () => {
    for (const permission of permissions) {
      assert.equal(can('super_admin', permission), !dolibarr.includes(permission), permission)
    }
  })

  it('donne tout à l’exploitant, sauf Dolibarr et la nomination des exploitants', () => {
    for (const permission of permissions) {
      const expected = !dolibarr.includes(permission) && !direction.includes(permission)
      assert.equal(can('admin', permission), expected, permission)
    }
  })

  it('réserve à la direction la nomination et le retrait des exploitants', () => {
    for (const permission of direction) {
      assert.deepEqual(rolesAllowed(permission), ['Direction'], permission)
    }
  })

  it('ne donne la facturation à aucun rôle : elle est dans Dolibarr', () => {
    assert.deepEqual([...dolibarrPermissions].sort(), [...dolibarr].sort())
    for (const permission of dolibarr) assert.deepEqual(rolesAllowed(permission), [], permission)
  })

  it('donne à l’accueil l’opérationnel du quotidien', () => {
    for (const permission of quotidien) assert.equal(can('staff', permission), true, permission)
  })

  it('réserve à l’exploitant et à la direction l’équipe, les tarifs, les contrats et la configuration', () => {
    for (const permission of reserve) {
      assert.equal(can('staff', permission), false, permission)
      assert.deepEqual(rolesAllowed(permission), ['Direction', 'Exploitant'], permission)
    }
  })

  it('classe chaque droit : aucun n’échappe à la répartition', () => {
    // Un droit ajouté sans décision explicite sur l'accueil fait échouer ce
    // test : la répartition se tranche, elle ne s'hérite pas par défaut.
    assert.deepEqual(
      [...quotidien, ...reserve, ...direction, ...dolibarr].sort(),
      [...permissions].sort(),
    )
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
    assert.deepEqual(
      permissionsOf('super_admin'),
      permissions.filter((permission) => !dolibarr.includes(permission)),
    )
    assert.deepEqual(
      permissionsOf('admin'),
      permissions.filter(
        (permission) => !dolibarr.includes(permission) && !direction.includes(permission),
      ),
    )
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
