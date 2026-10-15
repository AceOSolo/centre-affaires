import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'

import { uuidv7 } from '../lib/uuid.ts'
import { DB_TENANT_MISMATCH, DB_UNIQUE_VIOLATION, dbErrorCode } from './errors.ts'
import { withTenant } from './index.ts'
import { ouvrirBasesDeTest, raisonDeSaut, viderTables, type TestDatabases } from './test-support.ts'
import { DEFAULT_TENANT_ID } from './tenants.ts'

/**
 * Table des membres de l'équipe, éprouvée contre la base (ADR 008).
 *
 * C'est elle qui décide qui entre dans le back-office. Une erreur ici ne se
 * traduit pas par un écran mal affiché mais par un accès accordé à quelqu'un
 * qui ne devrait pas l'avoir, ou refusé à quelqu'un qui devrait.
 */
describe('accès au back-office', { skip: raisonDeSaut }, () => {
  {
    let bases: TestDatabases

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
            insert into staff_members (id, tenant_id, email, role, auth_user_id)
            values (${uuidv7()}, ${tenantId}, ${email}, ${role}, ${authUserId})
          `),
        bases.app.db,
      )

    type Membre = { email: string; role: string; tenant_id: string; deleted_at: Date | null }

    /** Les membres vus du centre donné : le filtre est explicite, la base ne filtre plus les lectures. */
    const membres = async (tenantId = DEFAULT_TENANT_ID) => {
      const [rows] = (await withTenant(
        tenantId,
        (tx) =>
          tx.execute(sql`select * from staff_members where tenant_id = ${tenantId} order by email`),
        bases.app.db,
      )) as unknown as [Membre[]]
      return rows
    }

    const retirer = () =>
      withTenant(
        DEFAULT_TENANT_ID,
        (tx) => tx.execute(sql`update staff_members set deleted_at = CURRENT_TIMESTAMP(3)`),
        bases.app.db,
      )

    const codeErreur = async (run: () => Promise<unknown>) => {
      try {
        await run()
      } catch (error) {
        return dbErrorCode(error)
      }
      return undefined
    }

    before(async () => {
      bases = await ouvrirBasesDeTest()
    })

    beforeEach(async () => {
      // `viderTables` suspend les clés étrangères : le courrier référence les
      // membres de l'équipe, et MySQL refuse de vider une table référencée.
      await viderTables(bases.owner, 'staff_members')
      await bases.owner.client.query('delete from tenants where id <> ?', [DEFAULT_TENANT_ID])
    })

    after(async () => {
      await bases.fermer()
    })

    describe('unicité de l’adresse', () => {
      it('refuse deux membres actifs avec la même adresse', async () => {
        await inscrire('alexis@exemple.fr')
        assert.equal(
          await codeErreur(() => inscrire('alexis@exemple.fr')),
          DB_UNIQUE_VIOLATION,
        )
      })

      it('laisse réinscrire quelqu’un qui revient dans l’équipe', async () => {
        // L'index est partiel : un retrait libère l'adresse, sans effacer la
        // ligne d'origine (décision 6).
        await inscrire('alexis@exemple.fr')
        await retirer()
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
          DB_UNIQUE_VIOLATION,
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
        await retirer()
        await inscrire('alexis@exemple.fr', 'admin', 'compte-1')
        assert.equal((await membres()).length, 2)
      })
    })

    describe('isolation par centre', () => {
      it('refuse d’inscrire quelqu’un dans un autre centre que celui du contexte', async () => {
        // Remplace la RLS : la garde d'écriture (CA014) est ce qui reste.
        await bases.owner.client.query(
          `insert into tenants (id, name, slug) values (?, 'Autre centre', 'autre-centre')`,
          [AUTRE_CENTRE],
        )
        assert.equal(
          await codeErreur(() =>
            withTenant(
              DEFAULT_TENANT_ID,
              (tx) =>
                tx.execute(sql`
                  insert into staff_members (id, tenant_id, email)
                  values (${uuidv7()}, ${AUTRE_CENTRE}, 'intrus@exemple.fr')`),
              bases.app.db,
            ),
          ),
          DB_TENANT_MISMATCH,
        )
      })

      it('ne montre pas l’équipe d’un centre à un autre', async () => {
        await inscrire('alexis@exemple.fr')
        await bases.owner.client.query(
          `insert into tenants (id, name, slug) values (?, 'Autre centre', 'autre-centre')`,
          [AUTRE_CENTRE],
        )

        assert.equal((await membres(AUTRE_CENTRE)).length, 0)
      })

      it('laisse la même adresse appartenir à deux centres', async () => {
        // L'unicité porte sur (centre, adresse) : quelqu'un peut travailler
        // dans deux centres le jour du multi-centres.
        await bases.owner.client.query(
          `insert into tenants (id, name, slug) values (?, 'Autre centre', 'autre-centre')`,
          [AUTRE_CENTRE],
        )
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
          (tx) =>
            tx.execute(
              sql`insert into staff_members (id, email) values (${uuidv7()}, 'neuf@exemple.fr')`,
            ),
          bases.app.db,
        )
        const [ligne] = await membres()
        assert.equal(ligne.role, 'staff')
        assert.equal(ligne.tenant_id, DEFAULT_TENANT_ID)
      })

      it('met à jour updated_at sans que le code y pense', async () => {
        await inscrire('alexis@exemple.fr')
        const lire = async () =>
          (
            (await bases.owner.client.query(
              'select created_at, updated_at from staff_members',
            )) as unknown as [{ created_at: Date; updated_at: Date }[]]
          )[0][0]
        const avant = await lire()
        // Au moins une milliseconde d'écart : `updated_at` a cette précision.
        await new Promise((resolve) => setTimeout(resolve, 5))
        await bases.owner.client.query(`update staff_members set role = 'admin'`)
        const apres = await lire()

        assert.deepEqual(apres.created_at, avant.created_at)
        assert.ok(apres.updated_at.getTime() > avant.updated_at.getTime())
      })
    })
  }
})
