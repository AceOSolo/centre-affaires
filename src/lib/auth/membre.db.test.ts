import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import { createDatabase, withTenant } from '../../db/index.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { resolveStaffMember, type AuthenticatedUser } from './membre.ts'

/**
 * Qui entre dans le back-office (ADR 008).
 *
 * Neon Auth dit qui est connecté ; cette résolution dit si cette personne fait
 * partie de l'équipe. Une erreur ici ouvre l'administration à quelqu'un qui ne
 * devrait pas y être — ou la ferme à quelqu'un qui devrait. Elle est donc
 * éprouvée contre une vraie base, avec le rôle applicatif soumis aux
 * politiques d'isolation.
 */
const ownerUrl = process.env.TEST_OWNER_DATABASE_URL ?? process.env.DATABASE_URL
const appUrl = process.env.TEST_DATABASE_URL

const raison = !appUrl
  ? 'TEST_DATABASE_URL non défini'
  : !ownerUrl
    ? 'TEST_OWNER_DATABASE_URL non défini'
    : false

describe('résolution du membre de l’équipe', { skip: raison }, () => {
  {
    const owner = createDatabase(ownerUrl ?? '', { onnotice: () => {} })
    const app = createDatabase(appUrl ?? '')

    const AUTRE_CENTRE = '01999f00-0000-7000-8000-0000000000fd'

    const compte = (
      id: string,
      email: string,
      name: string | null = 'Alexis Martin',
    ): AuthenticatedUser => ({ id, email, name })

    /** Inscription d'un membre, comme le fait `infra/ajouter-membre-staff.mjs`. */
    const inscrire = (
      email: string,
      { role = 'staff', authUserId = null as string | null, fullName = null as string | null } = {},
    ) =>
      withTenant(
        DEFAULT_TENANT_ID,
        (tx) =>
          tx.execute(sql`
            insert into staff_members (email, role, auth_user_id, full_name)
            values (${email}, ${role}, ${authUserId}, ${fullName})
          `),
        app.db,
      )

    const resoudre = (user: AuthenticatedUser, options = {}, tenantId = DEFAULT_TENANT_ID) =>
      withTenant(tenantId, (tx) => resolveStaffMember(tx, user, options), app.db)

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

    describe('compte inconnu', () => {
      it('ne rattache personne quand l’adresse n’est pas inscrite', async () => {
        // Le relais `/api/auth` expose l'inscription : avoir un compte ne prouve
        // rien. C'est le cœur de l'ADR 008.
        assert.equal(await resoudre(compte('u1', 'inconnu@exemple.fr')), undefined)
      })

      it('ne rattache personne dans un centre vide', async () => {
        await inscrire('alexis@exemple.fr')
        await owner.client`
          insert into tenants (id, name, slug)
          values (${AUTRE_CENTRE}, 'Autre centre', 'autre-centre')`

        // Le membre existe, mais pas dans ce centre-là.
        assert.equal(
          await resoudre(compte('u1', 'alexis@exemple.fr'), {}, AUTRE_CENTRE),
          undefined,
        )
      })
    })

    describe('premier accès', () => {
      it('rattache le compte au membre inscrit par son adresse', async () => {
        await inscrire('alexis@exemple.fr', { role: 'admin' })

        const membre = await resoudre(compte('u1', 'alexis@exemple.fr'))
        assert.equal(membre?.email, 'alexis@exemple.fr')
        assert.equal(membre?.role, 'admin')
        assert.equal(membre?.authUserId, 'u1')
      })

      it('reprend le nom du compte quand le membre n’en avait pas', async () => {
        await inscrire('alexis@exemple.fr')
        const membre = await resoudre(compte('u1', 'alexis@exemple.fr', 'Alexis Martin'))
        assert.equal(membre?.fullName, 'Alexis Martin')
      })

      it('garde le nom saisi à l’inscription plutôt que celui du compte', async () => {
        // Le nom tenu par le centre fait autorité : il sert à identifier la
        // personne dans l'équipe, pas à refléter son profil.
        await inscrire('alexis@exemple.fr', { fullName: 'Alexis M. (direction)' })
        const membre = await resoudre(compte('u1', 'alexis@exemple.fr', 'alexis'))
        assert.equal(membre?.fullName, 'Alexis M. (direction)')
      })

      it('ne rattache rien si le service dit l’adresse non vérifiée', async () => {
        // Le rattachement se fait sur l'adresse : sans vérification, quiconque
        // la contrôle prendrait la place du membre.
        await inscrire('alexis@exemple.fr')
        assert.equal(
          await resoudre(compte('u1', 'alexis@exemple.fr'), { emailVerified: false }),
          undefined,
        )
        // Et rien n'a été écrit au passage.
        const [ligne] = await withTenant(
          DEFAULT_TENANT_ID,
          (tx) => tx.execute(sql`select auth_user_id from staff_members`),
          app.db,
        )
        assert.equal(ligne.auth_user_id, null)
      })

      it('rattache quand la vérification n’est pas renseignée', async () => {
        // `undefined` n'est pas `false` : un service qui ne dit rien ne bloque
        // pas l'accès, seule une réponse négative explicite le fait.
        await inscrire('alexis@exemple.fr')
        assert.ok(await resoudre(compte('u1', 'alexis@exemple.fr'), {}))
      })
    })

    describe('accès suivants', () => {
      it('retrouve le membre par son compte, sans repasser par l’adresse', async () => {
        await inscrire('alexis@exemple.fr', { authUserId: 'u1' })
        const membre = await resoudre(compte('u1', 'adresse-changee@exemple.fr'))
        assert.equal(membre?.email, 'alexis@exemple.fr')
      })

      it('retrouve le membre même si son adresse n’est plus vérifiée', async () => {
        // La vérification ne garde que le rattachement initial ; une fois le
        // compte lié, la perdre ne doit pas couper l'accès.
        await inscrire('alexis@exemple.fr', { authUserId: 'u1' })
        assert.ok(await resoudre(compte('u1', 'alexis@exemple.fr'), { emailVerified: false }))
      })
    })

    describe('retrait de l’équipe', () => {
      it('ferme l’accès à un membre retiré, compte rattaché compris', async () => {
        await inscrire('alexis@exemple.fr', { authUserId: 'u1' })
        await withTenant(
          DEFAULT_TENANT_ID,
          (tx) => tx.execute(sql`update staff_members set deleted_at = now()`),
          app.db,
        )
        assert.equal(await resoudre(compte('u1', 'alexis@exemple.fr')), undefined)
      })

      it('ne ressuscite pas un membre retiré par son adresse', async () => {
        // Sans le filtre sur `deleted_at`, se reconnecter suffirait à rentrer.
        await inscrire('alexis@exemple.fr')
        await withTenant(
          DEFAULT_TENANT_ID,
          (tx) => tx.execute(sql`update staff_members set deleted_at = now()`),
          app.db,
        )
        assert.equal(await resoudre(compte('u2', 'alexis@exemple.fr')), undefined)
      })

      it('rouvre l’accès après une réinscription', async () => {
        await inscrire('alexis@exemple.fr', { authUserId: 'u1' })
        await withTenant(
          DEFAULT_TENANT_ID,
          (tx) => tx.execute(sql`update staff_members set deleted_at = now()`),
          app.db,
        )
        await inscrire('alexis@exemple.fr')

        const membre = await resoudre(compte('u1', 'alexis@exemple.fr'))
        assert.ok(membre)
        assert.equal(membre?.deletedAt, null)
      })
    })

    describe('deux personnes, une adresse', () => {
      it('ne donne pas le membre d’un autre à un compte différent', async () => {
        await inscrire('alexis@exemple.fr', { authUserId: 'u1' })
        // Camille n'est pas inscrite : son compte ne doit rien récupérer.
        assert.equal(await resoudre(compte('u2', 'camille@exemple.fr')), undefined)
      })

      it('refuse de rattacher un second compte à un membre déjà rattaché', async () => {
        await inscrire('alexis@exemple.fr', { authUserId: 'u1' })
        assert.equal(await resoudre(compte('u2', 'alexis@exemple.fr')), undefined)
      })
    })
  }
})
