import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import { createDatabase, withTenant, type Transaction } from '../../db/index.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { addTeamMember, changeTeamMember, checkTeamChange, listTeam } from './equipe.ts'
import { resolveStaffMember } from './membre.ts'

/**
 * Gestion de l'équipe (R27, ADR 019) : la règle seule, puis contre la base.
 *
 * On ne se retire pas soi-même, on ne change pas son propre rôle, et le centre
 * garde toujours un exploitant. Sans cela, l'équipe pourrait se retrouver sans
 * personne pour la gérer depuis l'application.
 */
describe('règle des changements dans l’équipe', () => {
  const MOI = 'moi'
  const AUTRE = 'autre'

  it('refuse de se retirer soi-même', () => {
    assert.equal(
      checkTeamChange({
        actorId: MOI,
        target: { id: MOI, role: 'admin' },
        change: { kind: 'retrait' },
        activeAdminCount: 3,
      }),
      'soi-meme',
    )
  })

  it('refuse de changer son propre rôle', () => {
    assert.equal(
      checkTeamChange({
        actorId: MOI,
        target: { id: MOI, role: 'admin' },
        change: { kind: 'role', role: 'staff' },
        activeAdminCount: 3,
      }),
      'soi-meme',
    )
  })

  it('refuse de retirer le dernier exploitant', () => {
    assert.equal(
      checkTeamChange({
        actorId: MOI,
        target: { id: AUTRE, role: 'admin' },
        change: { kind: 'retrait' },
        activeAdminCount: 1,
      }),
      'dernier-exploitant',
    )
  })

  it('refuse de passer le dernier exploitant à l’accueil', () => {
    assert.equal(
      checkTeamChange({
        actorId: MOI,
        target: { id: AUTRE, role: 'admin' },
        change: { kind: 'role', role: 'staff' },
        activeAdminCount: 1,
      }),
      'dernier-exploitant',
    )
  })

  it('laisse retirer ou rétrograder un exploitant quand il en reste un autre', () => {
    for (const change of [{ kind: 'retrait' }, { kind: 'role', role: 'staff' }] as const) {
      assert.equal(
        checkTeamChange({
          actorId: MOI,
          target: { id: AUTRE, role: 'admin' },
          change,
          activeAdminCount: 2,
        }),
        null,
      )
    }
  })

  it('laisse retirer un membre de l’accueil, ou le nommer exploitant', () => {
    for (const change of [{ kind: 'retrait' }, { kind: 'role', role: 'admin' }] as const) {
      assert.equal(
        checkTeamChange({
          actorId: MOI,
          target: { id: AUTRE, role: 'staff' },
          change,
          activeAdminCount: 1,
        }),
        null,
      )
    }
  })
})

const ownerUrl = process.env.TEST_OWNER_DATABASE_URL ?? process.env.DATABASE_URL
const appUrl = process.env.TEST_DATABASE_URL

const raison = !appUrl
  ? 'TEST_DATABASE_URL non défini'
  : !ownerUrl
    ? 'TEST_OWNER_DATABASE_URL non défini'
    : false

describe('gestion de l’équipe en base', { skip: raison }, () => {
  const owner = createDatabase(ownerUrl ?? '', { onnotice: () => {} })
  const app = createDatabase(appUrl ?? '')

  const asTenant = <T>(run: (tx: Transaction) => Promise<T>) =>
    withTenant(DEFAULT_TENANT_ID, run, app.db)

  const inscrire = async (email: string, role: 'admin' | 'staff') => {
    const member = await asTenant((tx) => addTeamMember(tx, { email, fullName: null, role }))
    assert.ok(member, email)
    return member
  }

  before(async () => {
    await migrate(owner.db, { migrationsFolder: './src/db/migrations' })
  })

  beforeEach(async () => {
    await owner.client`truncate table staff_members cascade`
  })

  after(async () => {
    await Promise.all([owner.client.end(), app.client.end()])
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

  it('refuse d’inscrire deux fois la même adresse', async () => {
    await inscrire('camille@exemple.fr', 'staff')
    const doublon = await asTenant((tx) =>
      addTeamMember(tx, { email: 'camille@exemple.fr', fullName: null, role: 'admin' }),
    )
    assert.equal(doublon, undefined)
    assert.equal((await asTenant(listTeam)).length, 1)
  })

  it('change un rôle', async () => {
    const moi = await inscrire('moi@exemple.fr', 'admin')
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
    const [ligne] = await asTenant((tx) =>
      tx.execute(sql`select deleted_at from staff_members where id = ${camille.id}`),
    )
    assert.ok(ligne.deleted_at)
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
    const moi = await inscrire('moi@exemple.fr', 'admin')
    await inscrire('autre@exemple.fr', 'admin')
    for (const change of [{ kind: 'retrait' }, { kind: 'role', role: 'staff' }] as const) {
      const result = await asTenant((tx) => changeTeamMember(tx, moi.id, moi.id, change))
      assert.deepEqual(result, { ok: false, refusal: 'soi-meme' })
    }
    const [ligne] = await asTenant((tx) =>
      tx.execute(sql`select role, deleted_at from staff_members where id = ${moi.id}`),
    )
    assert.equal(ligne.role, 'admin')
    assert.equal(ligne.deleted_at, null)
  })

  it('refuse de retirer ou de rétrograder le dernier exploitant', async () => {
    // L'accueil n'a pas le droit de gérer l'équipe, mais la règle tient même
    // si l'appelant n'est pas exploitant : elle vit dans la donnée.
    const accueil = await inscrire('accueil@exemple.fr', 'staff')
    const seul = await inscrire('seul@exemple.fr', 'admin')
    for (const change of [{ kind: 'retrait' }, { kind: 'role', role: 'staff' }] as const) {
      const result = await asTenant((tx) => changeTeamMember(tx, accueil.id, seul.id, change))
      assert.deepEqual(result, { ok: false, refusal: 'dernier-exploitant' })
    }
  })

  it('laisse rétrograder un exploitant quand il en reste un autre', async () => {
    const moi = await inscrire('moi@exemple.fr', 'admin')
    const autre = await inscrire('autre@exemple.fr', 'admin')
    const result = await asTenant((tx) =>
      changeTeamMember(tx, moi.id, autre.id, { kind: 'role', role: 'staff' }),
    )
    assert.equal(result.ok, true)
  })

  it('ne compte pas un exploitant retiré', async () => {
    const accueil = await inscrire('accueil@exemple.fr', 'staff')
    const ancien = await inscrire('ancien@exemple.fr', 'admin')
    const actuel = await inscrire('actuel@exemple.fr', 'admin')
    await asTenant((tx) => tx.execute(sql`update staff_members set deleted_at = now() where id = ${ancien.id}`))
    const result = await asTenant((tx) => changeTeamMember(tx, accueil.id, actuel.id, { kind: 'retrait' }))
    assert.deepEqual(result, { ok: false, refusal: 'dernier-exploitant' })
  })

  it('dit introuvable un membre déjà retiré', async () => {
    const moi = await inscrire('moi@exemple.fr', 'admin')
    const camille = await inscrire('camille@exemple.fr', 'staff')
    await asTenant((tx) => changeTeamMember(tx, moi.id, camille.id, { kind: 'retrait' }))
    const result = await asTenant((tx) => changeTeamMember(tx, moi.id, camille.id, { kind: 'retrait' }))
    assert.deepEqual(result, { ok: false, refusal: 'introuvable' })
  })

  it('garde un exploitant quand deux exploitants se rétrogradent l’un l’autre en même temps', async () => {
    const a = await inscrire('a@exemple.fr', 'admin')
    const b = await inscrire('b@exemple.fr', 'admin')

    // Deux transactions concurrentes : chacune, seule, serait légitime. La
    // première a lu et écrit, mais n'a pas encore validé quand la seconde lit.
    let valider = () => {}
    const tenue = new Promise<void>((resolve) => (valider = resolve))
    let ecrite = () => {}
    const premiereEcrite = new Promise<void>((resolve) => (ecrite = resolve))

    const premiere = asTenant(async (tx) => {
      const result = await changeTeamMember(tx, a.id, b.id, { kind: 'role', role: 'staff' })
      ecrite()
      await tenue
      return result
    })
    await premiereEcrite
    const seconde = asTenant((tx) =>
      changeTeamMember(tx, b.id, a.id, { kind: 'role', role: 'staff' }),
    )
    // Le temps que la seconde atteigne le verrou, puis la première valide.
    await new Promise((resolve) => setTimeout(resolve, 200))
    valider()

    const results = await Promise.all([premiere, seconde])
    assert.equal(results.filter((result) => result.ok).length, 1)
    assert.deepEqual(
      results.filter((result) => !result.ok),
      [{ ok: false, refusal: 'dernier-exploitant' }],
    )
    const admins = (await asTenant(listTeam)).filter((member) => member.role === 'admin')
    assert.equal(admins.length, 1)
  })
})
