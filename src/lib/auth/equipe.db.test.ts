import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'

import { withTenant, type Transaction } from '../../db/index.ts'
import type { StaffRole } from '../../db/staff.ts'
import {
  ouvrirBasesDeTest,
  raisonDeSaut,
  viderTables,
  type TestDatabases,
} from '../../db/test-support.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import {
  addTeamMember,
  assignableRoles,
  changeTeamMember,
  checkTeamChange,
  listTeam,
  type TeamChange,
} from './equipe.ts'
import { resolveStaffMember } from './membre.ts'

/**
 * Gestion de l'équipe (R27, ADR 019, ADR 054) : la règle seule, puis contre la
 * base.
 *
 * On ne se retire pas soi-même, on ne change pas son propre rôle ; la
 * direction seule nomme, rétrograde ou retire un exploitant ; l'exploitant
 * inscrit et retire l'accueil ; le centre garde toujours une direction. Sans
 * cela, un exploitant pourrait en nommer d'autres, ou retirer la direction.
 */
describe('rôles qu’un membre peut donner', () => {
  it('donne tous les rôles à la direction', () => {
    assert.deepEqual(assignableRoles('super_admin'), ['super_admin', 'admin', 'staff'])
  })

  it('ne donne que l’accueil à l’exploitant', () => {
    assert.deepEqual(assignableRoles('admin'), ['staff'])
  })

  it('ne donne rien à l’accueil ni à qui n’est plus de l’équipe', () => {
    assert.deepEqual(assignableRoles('staff'), [])
    assert.deepEqual(assignableRoles(undefined), [])
    assert.deepEqual(assignableRoles(null), [])
  })
})

describe('règle des changements dans l’équipe', () => {
  const MOI = 'moi'
  const AUTRE = 'autre'
  const verdict = (
    actorRole: StaffRole | undefined,
    targetRole: StaffRole,
    change: TeamChange,
    activeDirectionCount = 2,
  ) =>
    checkTeamChange({
      actor: actorRole ? { id: MOI, role: actorRole } : undefined,
      target: { id: AUTRE, role: targetRole },
      change,
      activeDirectionCount,
    })
  const retrait = { kind: 'retrait' } as const
  const role = (value: StaffRole) => ({ kind: 'role', role: value }) as const

  it('refuse de se retirer soi-même ou de changer son propre rôle', () => {
    for (const change of [retrait, role('staff')]) {
      assert.equal(
        checkTeamChange({
          actor: { id: MOI, role: 'super_admin' },
          target: { id: MOI, role: 'super_admin' },
          change,
          activeDirectionCount: 3,
        }),
        'soi-meme',
      )
    }
  })

  it('laisse la direction nommer, rétrograder ou retirer un exploitant', () => {
    assert.equal(verdict('super_admin', 'staff', role('admin')), null)
    assert.equal(verdict('super_admin', 'admin', role('staff')), null)
    assert.equal(verdict('super_admin', 'admin', retrait), null)
  })

  it('laisse la direction nommer une autre direction, ou la rétrograder s’il en reste une', () => {
    assert.equal(verdict('super_admin', 'admin', role('super_admin')), null)
    assert.equal(verdict('super_admin', 'super_admin', role('admin'), 2), null)
    assert.equal(verdict('super_admin', 'super_admin', retrait, 2), null)
  })

  it('refuse de retirer ou de rétrograder la dernière direction', () => {
    // Inatteignable par l'écran — la direction ne touche qu'une autre
    // direction —, mais la règle tient seule.
    for (const change of [retrait, role('admin')]) {
      assert.equal(verdict('super_admin', 'super_admin', change, 1), 'derniere-direction')
    }
  })

  it('laisse l’exploitant retirer un membre de l’accueil', () => {
    assert.equal(verdict('admin', 'staff', retrait), null)
  })

  it('refuse à l’exploitant de nommer un exploitant ou une direction', () => {
    assert.equal(verdict('admin', 'staff', role('admin')), 'reserve-direction')
    assert.equal(verdict('admin', 'staff', role('super_admin')), 'reserve-direction')
  })

  it('refuse à l’exploitant de toucher un autre exploitant ou la direction', () => {
    for (const target of ['admin', 'super_admin'] as const) {
      assert.equal(verdict('admin', target, retrait), 'reserve-direction', target)
      assert.equal(verdict('admin', target, role('staff')), 'reserve-direction', target)
    }
  })

  it('refuse tout à l’accueil et à qui n’est plus de l’équipe', () => {
    for (const actor of ['staff', undefined] as const) {
      assert.equal(verdict(actor, 'staff', retrait), 'reserve-direction', String(actor))
      assert.equal(verdict(actor, 'admin', role('staff')), 'reserve-direction', String(actor))
    }
  })
})

describe('gestion de l’équipe en base', { skip: raisonDeSaut }, () => {
  let bases: TestDatabases

  const asTenant = <T>(run: (tx: Transaction) => Promise<T>) =>
    withTenant(DEFAULT_TENANT_ID, run, bases.app.db)

  const inscrire = async (email: string, role: StaffRole) => {
    const member = await asTenant((tx) => addTeamMember(tx, { email, fullName: null, role }))
    assert.ok(member, email)
    return member
  }

  const roleEnBase = async (id: string) => {
    const [lignes] = (await asTenant((tx) =>
      tx.execute(sql`select role, deleted_at from staff_members where id = ${id}`),
    )) as unknown as [{ role: string; deleted_at: Date | null }[]]
    return lignes[0]
  }

  before(async () => {
    bases = await ouvrirBasesDeTest()
  })

  beforeEach(async () => {
    await viderTables(bases.owner, 'staff_members')
  })

  after(async () => {
    await bases.fermer()
  })

  it('inscrit un membre par son adresse, en minuscules', async () => {
    const member = await inscrire(' Camille@Exemple.FR ', 'staff')
    assert.equal(member.email, 'camille@exemple.fr')
    assert.equal(member.role, 'staff')
    assert.equal(member.authUserId, null)
    // Le compte lui est rattaché à la première connexion, comme par le script.
    const resolved = await asTenant((tx) =>
      resolveStaffMember(tx, { id: 'compte-c', email: 'camille@exemple.fr', name: 'Camille' }),
    )
    assert.equal(resolved?.id, member.id)
  })

  it('inscrit un membre de la direction', async () => {
    const member = await inscrire('alexis@exemple.fr', 'super_admin')
    assert.equal(member.role, 'super_admin')
  })

  it('range la direction, puis les exploitants, puis l’accueil', async () => {
    await inscrire('a@exemple.fr', 'staff')
    await inscrire('b@exemple.fr', 'admin')
    await inscrire('c@exemple.fr', 'super_admin')
    assert.deepEqual(
      (await asTenant(listTeam)).map((member) => member.role),
      ['super_admin', 'admin', 'staff'],
    )
  })

  it('refuse d’inscrire deux fois la même adresse', async () => {
    await inscrire('camille@exemple.fr', 'staff')
    const doublon = await asTenant((tx) =>
      addTeamMember(tx, { email: 'camille@exemple.fr', fullName: null, role: 'admin' }),
    )
    assert.equal(doublon, undefined)
    assert.equal((await asTenant(listTeam)).length, 1)
  })

  it('laisse la direction nommer un exploitant', async () => {
    const moi = await inscrire('moi@exemple.fr', 'super_admin')
    const camille = await inscrire('camille@exemple.fr', 'staff')
    const result = await asTenant((tx) =>
      changeTeamMember(tx, moi.id, camille.id, { kind: 'role', role: 'admin' }),
    )
    assert.equal(result.ok, true)
    assert.equal(result.ok && result.member.role, 'admin')
  })

  it('retire un membre sans effacer sa ligne, et lui ferme l’accès', async () => {
    const moi = await inscrire('moi@exemple.fr', 'admin')
    const camille = await inscrire('camille@exemple.fr', 'staff')
    await asTenant((tx) =>
      tx.execute(sql`update staff_members set auth_user_id = 'compte-c' where id = ${camille.id}`),
    )

    const result = await asTenant((tx) => changeTeamMember(tx, moi.id, camille.id, { kind: 'retrait' }))
    assert.equal(result.ok, true)

    // Décision 6 : la ligne reste, datée.
    assert.ok((await roleEnBase(camille.id)).deleted_at)
    assert.deepEqual(
      (await asTenant(listTeam)).map((member) => member.email),
      ['moi@exemple.fr'],
    )
    const resolved = await asTenant((tx) =>
      resolveStaffMember(tx, { id: 'compte-c', email: 'camille@exemple.fr', name: null }),
    )
    assert.equal(resolved, undefined)
  })

  it('refuse de se retirer soi-même ou de changer son propre rôle', async () => {
    const moi = await inscrire('moi@exemple.fr', 'super_admin')
    await inscrire('autre@exemple.fr', 'super_admin')
    for (const change of [{ kind: 'retrait' }, { kind: 'role', role: 'staff' }] as const) {
      const result = await asTenant((tx) => changeTeamMember(tx, moi.id, moi.id, change))
      assert.deepEqual(result, { ok: false, refusal: 'soi-meme' })
    }
    assert.deepEqual(await roleEnBase(moi.id), { role: 'super_admin', deleted_at: null })
  })

  it('refuse à un exploitant de rétrograder ou de retirer un autre exploitant', async () => {
    const moi = await inscrire('moi@exemple.fr', 'admin')
    const autre = await inscrire('autre@exemple.fr', 'admin')
    for (const change of [{ kind: 'retrait' }, { kind: 'role', role: 'staff' }] as const) {
      const result = await asTenant((tx) => changeTeamMember(tx, moi.id, autre.id, change))
      assert.deepEqual(result, { ok: false, refusal: 'reserve-direction' })
    }
    assert.deepEqual(await roleEnBase(autre.id), { role: 'admin', deleted_at: null })
  })

  it('refuse à un exploitant de toucher la direction', async () => {
    const moi = await inscrire('moi@exemple.fr', 'admin')
    const direction = await inscrire('direction@exemple.fr', 'super_admin')
    for (const change of [{ kind: 'retrait' }, { kind: 'role', role: 'staff' }] as const) {
      const result = await asTenant((tx) => changeTeamMember(tx, moi.id, direction.id, change))
      assert.deepEqual(result, { ok: false, refusal: 'reserve-direction' })
    }
    assert.deepEqual(await roleEnBase(direction.id), { role: 'super_admin', deleted_at: null })
  })

  it('refuse à un exploitant de nommer un exploitant', async () => {
    const moi = await inscrire('moi@exemple.fr', 'admin')
    const camille = await inscrire('camille@exemple.fr', 'staff')
    const result = await asTenant((tx) =>
      changeTeamMember(tx, moi.id, camille.id, { kind: 'role', role: 'admin' }),
    )
    assert.deepEqual(result, { ok: false, refusal: 'reserve-direction' })
    assert.equal((await roleEnBase(camille.id)).role, 'staff')
  })

  it('relit le rôle de l’auteur en base : une direction rétrogradée n’a plus la main', async () => {
    const moi = await inscrire('moi@exemple.fr', 'super_admin')
    await inscrire('autre@exemple.fr', 'super_admin')
    const camille = await inscrire('camille@exemple.fr', 'staff')
    // La session dirait encore « direction » ; la base dit exploitant.
    await asTenant((tx) => tx.execute(sql`update staff_members set role = 'admin' where id = ${moi.id}`))
    const result = await asTenant((tx) =>
      changeTeamMember(tx, moi.id, camille.id, { kind: 'role', role: 'admin' }),
    )
    assert.deepEqual(result, { ok: false, refusal: 'reserve-direction' })
  })

  it('ne laisse plus la main à une direction retirée', async () => {
    const ancienne = await inscrire('ancienne@exemple.fr', 'super_admin')
    await inscrire('actuelle@exemple.fr', 'super_admin')
    const camille = await inscrire('camille@exemple.fr', 'staff')
    await asTenant((tx) =>
      tx.execute(sql`update staff_members set deleted_at = CURRENT_TIMESTAMP(3) where id = ${ancienne.id}`),
    )
    const result = await asTenant((tx) => changeTeamMember(tx, ancienne.id, camille.id, { kind: 'retrait' }))
    assert.deepEqual(result, { ok: false, refusal: 'reserve-direction' })
  })

  it('dit introuvable un membre déjà retiré', async () => {
    const moi = await inscrire('moi@exemple.fr', 'admin')
    const camille = await inscrire('camille@exemple.fr', 'staff')
    await asTenant((tx) => changeTeamMember(tx, moi.id, camille.id, { kind: 'retrait' }))
    const result = await asTenant((tx) => changeTeamMember(tx, moi.id, camille.id, { kind: 'retrait' }))
    assert.deepEqual(result, { ok: false, refusal: 'introuvable' })
  })

  it('garde une direction quand deux directions se rétrogradent l’une l’autre en même temps', async () => {
    const a = await inscrire('a@exemple.fr', 'super_admin')
    const b = await inscrire('b@exemple.fr', 'super_admin')

    // Deux transactions concurrentes : chacune, seule, serait légitime. La
    // première a lu et écrit, mais n'a pas encore validé quand la seconde lit.
    let valider = () => {}
    const tenue = new Promise<void>((resolve) => (valider = resolve))
    let ecrite = () => {}
    const premiereEcrite = new Promise<void>((resolve) => (ecrite = resolve))

    const premiere = asTenant(async (tx) => {
      const result = await changeTeamMember(tx, a.id, b.id, { kind: 'role', role: 'admin' })
      ecrite()
      await tenue
      return result
    })
    await premiereEcrite
    const seconde = asTenant((tx) =>
      changeTeamMember(tx, b.id, a.id, { kind: 'role', role: 'admin' }),
    )
    // Le temps que la seconde atteigne le verrou, puis la première valide.
    await new Promise((resolve) => setTimeout(resolve, 200))
    valider()

    const results = await Promise.all([premiere, seconde])
    // MySQL : la seconde transaction attend le verrou, relit après la
    // validation de la première : son auteur n'est plus de la direction.
    assert.equal(results.filter((result) => result.ok).length, 1)
    assert.deepEqual(
      results.filter((result) => !result.ok),
      [{ ok: false, refusal: 'reserve-direction' }],
    )
    const direction = (await asTenant(listTeam)).filter((member) => member.role === 'super_admin')
    assert.equal(direction.length, 1)
  })
})
