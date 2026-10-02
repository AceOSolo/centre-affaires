import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import { createDatabase, withTenant } from '../../db/index.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import type { AuthenticatedUser } from '../../lib/auth/membre.ts'
import { resolveClientAccounts } from './comptes.ts'

/**
 * Qui lit le courrier de quelle entreprise (ADR 015).
 *
 * Une erreur ici ne mal affiche rien : elle ouvre le courrier d'une entreprise
 * à quelqu'un d'autre. Éprouvé contre une vraie base, sous le rôle applicatif
 * soumis aux politiques d'isolation, comme la résolution des membres de
 * l'équipe (`membre.db.test.ts`).
 */
const ownerUrl = process.env.TEST_OWNER_DATABASE_URL ?? process.env.DATABASE_URL
const appUrl = process.env.TEST_DATABASE_URL

const raison = !appUrl
  ? 'TEST_DATABASE_URL non défini'
  : !ownerUrl
    ? 'TEST_OWNER_DATABASE_URL non défini'
    : false

describe('accès à l’espace client', { skip: raison }, () => {
  const owner = createDatabase(ownerUrl ?? '', { onnotice: () => {} })
  const app = createDatabase(appUrl ?? '')

  const HOLDING = '01a00000-0000-7000-8000-00000000c0a1'
  const SCI = '01a00000-0000-7000-8000-00000000c0a2'
  const AUTRE_CENTRE = '01999f00-0000-7000-8000-0000000000fc'

  const compte = (id: string, email: string, name: string | null = 'Jeanne Durand'): AuthenticatedUser => ({
    id,
    email,
    name,
  })

  const asTenant = <T>(run: Parameters<typeof withTenant<T>>[1], tenant = DEFAULT_TENANT_ID) =>
    withTenant(tenant, run, app.db)

  /** Inscription depuis la fiche client, comme `addClientMember`. */
  const inscrire = (
    clientId: string,
    email: string,
    { authUserId = null as string | null, fullName = null as string | null } = {},
  ) =>
    asTenant((tx) =>
      tx.execute(sql`
        insert into client_members (client_id, email, auth_user_id, full_name)
        values (${clientId}, ${email}, ${authUserId}, ${fullName})
      `),
    )

  const resoudre = (user: AuthenticatedUser, options = {}, tenant = DEFAULT_TENANT_ID) =>
    asTenant((tx) => resolveClientAccounts(tx, user, options), tenant)

  before(async () => {
    await migrate(owner.db, { migrationsFolder: './src/db/migrations' })
  })

  beforeEach(async () => {
    await owner.client`truncate table clients cascade`
    await owner.client`delete from tenants where id <> ${DEFAULT_TENANT_ID}`
    await asTenant((tx) =>
      tx.execute(sql`
        insert into clients (id, name, status) values
          (${HOLDING}, 'Durand Holding', 'active'),
          (${SCI}, 'SCI Les Tilleuls', 'active')
      `),
    )
  })

  after(async () => {
    await Promise.all([owner.client.end(), app.client.end()])
  })

  it('ne donne rien à un compte dont l’adresse n’est pas inscrite', async () => {
    // L'inscription est ouverte à tous : avoir un compte ne prouve rien.
    assert.deepEqual(await resoudre(compte('u1', 'inconnu@exemple.fr')), [])
  })

  it('rattache le compte à l’inscription faite à son adresse', async () => {
    await inscrire(HOLDING, 'jeanne@durand.fr')

    const comptes = await resoudre(compte('u1', 'jeanne@durand.fr'))
    assert.deepEqual(
      comptes.map((c) => [c.clientId, c.clientName]),
      [[HOLDING, 'Durand Holding']],
    )
    const [ligne] = await asTenant((tx) =>
      tx.execute(sql`select auth_user_id, full_name from client_members`),
    )
    assert.equal(ligne.auth_user_id, 'u1')
    assert.equal(ligne.full_name, 'Jeanne Durand')
  })

  it('ouvre les deux entreprises d’une personne inscrite sur les deux', async () => {
    // Le gérant d'une holding et de sa SCI relève les deux boîtes d'un seul compte.
    await inscrire(SCI, 'jeanne@durand.fr')
    await inscrire(HOLDING, 'jeanne@durand.fr')

    const comptes = await resoudre(compte('u1', 'jeanne@durand.fr'))
    assert.deepEqual(
      comptes.map((c) => c.clientName),
      ['Durand Holding', 'SCI Les Tilleuls'],
    )
  })

  it('ajoute une entreprise inscrite après la première connexion', async () => {
    await inscrire(HOLDING, 'jeanne@durand.fr')
    await resoudre(compte('u1', 'jeanne@durand.fr'))
    await inscrire(SCI, 'jeanne@durand.fr')

    assert.equal((await resoudre(compte('u1', 'jeanne@durand.fr'))).length, 2)
  })

  it('ne rattache rien quand le service dit l’adresse non vérifiée', async () => {
    // Sans vérification, quiconque contrôle l'adresse lirait le courrier.
    await inscrire(HOLDING, 'jeanne@durand.fr')
    assert.deepEqual(await resoudre(compte('u1', 'jeanne@durand.fr'), { emailVerified: false }), [])
    const [ligne] = await asTenant((tx) => tx.execute(sql`select auth_user_id from client_members`))
    assert.equal(ligne.auth_user_id, null)
  })

  it('garde l’accès d’un compte rattaché dont l’adresse a changé', async () => {
    await inscrire(HOLDING, 'jeanne@durand.fr', { authUserId: 'u1' })
    assert.equal((await resoudre(compte('u1', 'jeanne.nouvelle@durand.fr'))).length, 1)
  })

  it('ne donne pas à un second compte une inscription déjà rattachée', async () => {
    await inscrire(HOLDING, 'jeanne@durand.fr', { authUserId: 'u1' })
    assert.deepEqual(await resoudre(compte('u2', 'jeanne@durand.fr')), [])
  })

  it('ne rattache pas deux fois le même compte à la même entreprise', async () => {
    // Rattachée par son ancienne adresse, la personne est réinscrite avec la
    // nouvelle : l'index unique refuserait un second lien, la résolution ne
    // doit pas le tenter.
    await inscrire(HOLDING, 'ancienne@durand.fr', { authUserId: 'u1' })
    await inscrire(HOLDING, 'jeanne@durand.fr')

    const comptes = await resoudre(compte('u1', 'jeanne@durand.fr'))
    assert.equal(comptes.length, 1)
  })

  it('ferme l’accès à une personne retirée de la fiche', async () => {
    await inscrire(HOLDING, 'jeanne@durand.fr', { authUserId: 'u1' })
    await asTenant((tx) => tx.execute(sql`update client_members set deleted_at = now()`))
    assert.deepEqual(await resoudre(compte('u1', 'jeanne@durand.fr')), [])
  })

  it('ne ressuscite pas une inscription retirée par l’adresse', async () => {
    await inscrire(HOLDING, 'jeanne@durand.fr')
    await asTenant((tx) => tx.execute(sql`update client_members set deleted_at = now()`))
    assert.deepEqual(await resoudre(compte('u2', 'jeanne@durand.fr')), [])
  })

  it('ferme l’accès quand la fiche client est archivée', async () => {
    await inscrire(HOLDING, 'jeanne@durand.fr', { authUserId: 'u1' })
    await asTenant((tx) => tx.execute(sql`update clients set deleted_at = now() where id = ${HOLDING}`))
    assert.deepEqual(await resoudre(compte('u1', 'jeanne@durand.fr')), [])
  })

  it('ne voit pas une inscription faite dans un autre centre', async () => {
    await inscrire(HOLDING, 'jeanne@durand.fr')
    await owner.client`
      insert into tenants (id, name, slug) values (${AUTRE_CENTRE}, 'Autre centre', 'autre-centre-comptes')`
    assert.deepEqual(await resoudre(compte('u1', 'jeanne@durand.fr'), {}, AUTRE_CENTRE), [])
  })

  it('refuse une inscription qui viserait le client d’un autre centre', async () => {
    await owner.client`
      insert into tenants (id, name, slug) values (${AUTRE_CENTRE}, 'Autre centre', 'autre-centre-comptes')`
    await assert.rejects(
      asTenant(
        (tx) =>
          tx.execute(sql`insert into client_members (client_id, email) values (${HOLDING}, 'x@y.fr')`),
        AUTRE_CENTRE,
      ),
    )
  })
})
