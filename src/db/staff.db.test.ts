import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import { PG_UNIQUE_VIOLATION, pgErrorCode } from './errors.ts'
import { createDatabase, withTenant } from './index.ts'
import { DEFAULT_TENANT_ID } from './tenants.ts'

/**
 * Table des membres de l'équipe, éprouvée contre la base (ADR 008).
 *
 * C'est elle qui décide qui entre dans le back-office. Une erreur ici ne se
 * traduit pas par un écran mal affiché mais par un accès accordé à quelqu'un
 * qui ne devrait pas l'avoir, ou refusé à quelqu'un qui devrait.
 */
const ownerUrl = process.env.TEST_OWNER_DATABASE_URL ?? process.env.DATABASE_URL
const appUrl = process.env.TEST_DATABASE_URL

const raison = !appUrl
  ? 'TEST_DATABASE_URL non défini'
  : !ownerUrl
    ? 'TEST_OWNER_DATABASE_URL non défini'
    : false

describe('accès au back-office', { skip: raison }, () => {
  {
    const owner = createDatabase(ownerUrl ?? '', { onnotice: () => {} })
    const app = createDatabase(appUrl ?? '')

    const AUTRE_CENTRE = '01999f00-0000-7000-8000-0000000000fe'

    const inscrire = (
      email: string,
      role = 'staff',
      authUserId: string | null = null,
      tenantId = DEFAULT_TENANT_ID,
    ) =>
      withTenant(
        tenantId,
        (tx) =>
          tx.execute(sql`
            insert into staff_members (email, role, auth_user_id)
            values (${email}, ${role}, ${authUserId})
          `),
        app.db,
      )

    const membres = (tenantId = DEFAULT_TENANT_ID) =>
      withTenant(
        tenantId,
        (tx) => tx.execute(sql`select * from staff_members order by email`),
        app.db,
      )

    const codeErreur = async (run: () => Promise<unknown>) => {
      try {
        await run()
      } catch (error) {
        return pgErrorCode(error)
      }
      return undefined
    }

    before(async () => {
      await migrate(owner.db, { migrationsFolder: './src/db/migrations' })
    })

    beforeEach(async () => {
      // `cascade` : le courrier référence les membres de l'équipe (qui l'a
      // enregistré, ouvert, consulté), et Postgres refuse de vider une table
      // référencée, même quand les tables qui la visent sont vides.
      await owner.client`truncate table staff_members cascade`
      await owner.client`delete from tenants where id <> ${DEFAULT_TENANT_ID}`
    })

    after(async () => {
      await Promise.all([owner.client.end(), app.client.end()])
    })

    describe('unicité de l’adresse', () => {
      it('refuse deux membres actifs avec la même adresse', async () => {
        await inscrire('alexis@exemple.fr')
        assert.equal(
          await codeErreur(() => inscrire('alexis@exemple.fr')),
          PG_UNIQUE_VIOLATION,
        )
      })

      it('laisse réinscrire quelqu’un qui revient dans l’équipe', async () => {
        // L'index est partiel : un retrait libère l'adresse, sans effacer la
        // ligne d'origine (décision 6).
        await inscrire('alexis@exemple.fr')
        await withTenant(
          DEFAULT_TENANT_ID,
          (tx) => tx.execute(sql`update staff_members set deleted_at = now()`),
          app.db,
        )
        await inscrire('alexis@exemple.fr')

        const lignes = await membres()
        assert.equal(lignes.length, 2)
        assert.equal(lignes.filter((l) => l.deleted_at === null).length, 1)
      })
    })

    describe('rattachement du compte', () => {
      it('refuse de rattacher un compte à deux membres actifs', async () => {
        // Sinon un même identifiant donnerait deux jeux de droits, et la
        // résolution dépendrait de l'ordre de lecture.
        await inscrire('alexis@exemple.fr', 'admin', 'compte-1')
        assert.equal(
          await codeErreur(() => inscrire('camille@exemple.fr', 'staff', 'compte-1')),
          PG_UNIQUE_VIOLATION,
        )
      })

      it('laisse plusieurs membres sans compte rattaché', async () => {
        // `auth_user_id` est nul tant que la personne ne s'est pas connectée :
        // l'index partiel ne doit pas confondre ces nuls entre eux.
        await inscrire('alexis@exemple.fr')
        await inscrire('camille@exemple.fr')
        await inscrire('dominique@exemple.fr')
        assert.equal((await membres()).length, 3)
      })

      it('libère le compte quand le membre est retiré', async () => {
        await inscrire('alexis@exemple.fr', 'admin', 'compte-1')
        await withTenant(
          DEFAULT_TENANT_ID,
          (tx) => tx.execute(sql`update staff_members set deleted_at = now()`),
          app.db,
        )
        await inscrire('alexis@exemple.fr', 'admin', 'compte-1')
        assert.equal((await membres()).length, 2)
      })
    })

    describe('isolation par centre', () => {
      it('ne renvoie rien hors contexte de centre', async () => {
        await inscrire('alexis@exemple.fr')
        const horsContexte = await app.db.execute(
          sql`select count(*)::int as n from staff_members`,
        )
        assert.equal(horsContexte[0].n, 0)
        assert.equal((await membres()).length, 1)
      })

      it('ne montre pas l’équipe d’un centre à un autre', async () => {
        await inscrire('alexis@exemple.fr')
        await owner.client`
          insert into tenants (id, name, slug)
          values (${AUTRE_CENTRE}, 'Autre centre', 'autre-centre')`

        assert.equal((await membres(AUTRE_CENTRE)).length, 0)
      })

      it('laisse la même adresse appartenir à deux centres', async () => {
        // L'unicité porte sur (centre, adresse) : quelqu'un peut travailler
        // dans deux centres le jour du multi-centres.
        await owner.client`
          insert into tenants (id, name, slug)
          values (${AUTRE_CENTRE}, 'Autre centre', 'autre-centre')`
        await inscrire('alexis@exemple.fr')
        await inscrire('alexis@exemple.fr', 'staff', null, AUTRE_CENTRE)

        assert.equal((await membres()).length, 1)
        assert.equal((await membres(AUTRE_CENTRE)).length, 1)
      })
    })

    describe('valeurs par défaut', () => {
      it('attribue le rôle le moins puissant par défaut', async () => {
        await withTenant(
          DEFAULT_TENANT_ID,
          (tx) => tx.execute(sql`insert into staff_members (email) values ('neuf@exemple.fr')`),
          app.db,
        )
        const [ligne] = await membres()
        assert.equal(ligne.role, 'staff')
        assert.equal(ligne.tenant_id, DEFAULT_TENANT_ID)
      })

      it('met à jour updated_at sans que le code y pense', async () => {
        await inscrire('alexis@exemple.fr')
        const [avant] = await owner.client`select created_at, updated_at from staff_members`
        await owner.client`update staff_members set role = 'admin'`
        const [apres] = await owner.client`select created_at, updated_at from staff_members`

        assert.deepEqual(apres.created_at, avant.created_at)
        assert.ok(apres.updated_at > avant.updated_at)
      })
    })
  }
})
