import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import { PG_CHECK_VIOLATION, PG_INSUFFICIENT_PRIVILEGE, pgErrorCode } from '../../db/errors.ts'
import { createDatabase, withTenant } from '../../db/index.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'

/**
 * Numérotation des documents (R12, ADR 021) : une série par centre, par type et
 * par année, sans trou ni doublon, même en concurrence.
 *
 * Éprouvée sous `app_centre` : c'est lui qui demande les numéros, et lui qui ne
 * doit pas pouvoir toucher aux compteurs.
 */
const ownerUrl = process.env.TEST_OWNER_DATABASE_URL ?? process.env.DATABASE_URL
const appUrl = process.env.TEST_DATABASE_URL

const raison = !appUrl
  ? 'TEST_DATABASE_URL non défini'
  : !ownerUrl
    ? 'TEST_OWNER_DATABASE_URL non défini'
    : false

/** Année civile du centre (Paris) : celle que porte le numéro. */
const ANNEE = Number(
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric' }).format(new Date()),
)

describe('numérotation des documents', { skip: raison }, () => {
  const owner = createDatabase(ownerUrl ?? '', { onnotice: () => {} })
  // Assez de connexions pour que les transactions concurrentes le soient vraiment.
  const app = createDatabase(appUrl ?? '', { max: 12 })

  const CLIENT = '01a00000-0000-7000-8000-0000000d0c01'
  const AUTRE_CENTRE = '01999f00-0000-7000-8000-0000000000f6'
  const CLIENT_AILLEURS = '01a00000-0000-7000-8000-0000000d0c02'

  const asTenant = <T>(run: Parameters<typeof withTenant<T>>[1], tenant = DEFAULT_TENANT_ID) =>
    withTenant(tenant, run, app.db)

  const errorCode = async (run: () => Promise<unknown>) => {
    try {
      await run()
    } catch (error) {
      return pgErrorCode(error)
    }
    return undefined
  }

  const numero = async (type: string, tenant = DEFAULT_TENANT_ID): Promise<string> => {
    const [row] = await asTenant(
      (tx) => tx.execute(sql`select next_document_number(${type}::document_type) as numero`),
      tenant,
    )
    return row.numero as string
  }

  /** Contrat saisi sans référence : la base la choisit. */
  const contratSansReference = async (clientId = CLIENT, tenant = DEFAULT_TENANT_ID) => {
    const [row] = await asTenant(
      (tx) =>
        tx.execute(sql`
          insert into contracts (client_id, contract_type, starts_on, amount_cents)
          values (${clientId}, 'domiciliation', '2026-10-01', 9000)
          returning reference`),
      tenant,
    )
    return row.reference as string
  }

  const contratAvecReference = (reference: string) =>
    asTenant((tx) =>
      tx.execute(sql`
        insert into contracts (client_id, reference, contract_type, starts_on, amount_cents)
        values (${CLIENT}, ${reference}, 'domiciliation', '2026-10-01', 9000)`),
    )

  before(async () => {
    await migrate(owner.db, { migrationsFolder: './src/db/migrations' })
  })

  beforeEach(async () => {
    await owner.client`truncate table bookings, contracts, rate_plan_items, rate_plans, clients, resources cascade`
    await owner.client`truncate table document_sequences`
    await owner.client`delete from tenants where id <> ${DEFAULT_TENANT_ID}`
    await asTenant((tx) => tx.execute(sql`insert into clients (id, name) values (${CLIENT}, 'Acme SAS')`))
  })

  after(async () => {
    await Promise.all([owner.client.end(), app.client.end()])
  })

  describe('contrats', () => {
    it('numérote les contrats saisis sans référence, dans l’ordre', async () => {
      assert.equal(await contratSansReference(), `CT-${ANNEE}-0001`)
      assert.equal(await contratSansReference(), `CT-${ANNEE}-0002`)
    })

    it('garde une référence saisie à la main, sans consommer de numéro', async () => {
      await contratAvecReference('DOM-2026-014')
      assert.equal(await contratSansReference(), `CT-${ANNEE}-0001`)
      const [row] = await asTenant((tx) =>
        tx.execute(sql`select count(*)::int as n from contracts where reference = 'DOM-2026-014'`),
      )
      assert.equal(row.n, 1)
    })

    it('saute un numéro déjà porté par un contrat saisi à la main', async () => {
      // Sans cela, la référence manuelle bloquerait la numérotation pour toujours :
      // chaque tentative retomberait sur le même numéro et échouerait.
      await contratAvecReference(`CT-${ANNEE}-0001`)
      assert.equal(await contratSansReference(), `CT-${ANNEE}-0002`)
    })

    it('saute aussi le numéro d’un contrat archivé', async () => {
      await contratAvecReference(`CT-${ANNEE}-0001`)
      await asTenant((tx) => tx.execute(sql`update contracts set deleted_at = now()`))
      assert.equal(await contratSansReference(), `CT-${ANNEE}-0002`)
    })

    it('refuse une référence vide : il faut l’omettre pour obtenir un numéro', async () => {
      assert.equal(await errorCode(() => contratAvecReference('  ')), PG_CHECK_VIOLATION)
    })
  })

  describe('séries', () => {
    it('tient une série par type de document', async () => {
      assert.equal(await numero('invoice'), `FA-${ANNEE}-0001`)
      assert.equal(await numero('invoice'), `FA-${ANNEE}-0002`)
      assert.equal(await numero('credit_note'), `AV-${ANNEE}-0001`)
      assert.equal(await numero('contract'), `CT-${ANNEE}-0001`)
    })

    it('tient une série par centre', async () => {
      await owner.client`
        insert into tenants (id, name, slug) values (${AUTRE_CENTRE}, 'Autre centre', 'autre-centre-num')`
      await asTenant(
        (tx) => tx.execute(sql`insert into clients (id, name) values (${CLIENT_AILLEURS}, 'Beta')`),
        AUTRE_CENTRE,
      )
      assert.equal(await numero('invoice'), `FA-${ANNEE}-0001`)
      assert.equal(await numero('invoice', AUTRE_CENTRE), `FA-${ANNEE}-0001`)
      assert.equal(await contratSansReference(CLIENT_AILLEURS, AUTRE_CENTRE), `CT-${ANNEE}-0001`)
      assert.equal(await numero('invoice'), `FA-${ANNEE}-0002`)
    })

    it('ouvre une nouvelle série chaque année, l’année dans le numéro', async () => {
      await owner.client`
        insert into document_sequences (tenant_id, document_type, year, last_value)
        values (${DEFAULT_TENANT_ID}, 'invoice', ${ANNEE - 1}, 57)`
      assert.equal(await numero('invoice'), `FA-${ANNEE}-0001`)
      const [precedente] = await owner.client`
        select last_value from document_sequences where year = ${ANNEE - 1}`
      assert.equal(precedente.last_value, 57)
    })

    it('ne tronque jamais au-delà de 9999', async () => {
      await owner.client`
        insert into document_sequences (tenant_id, document_type, year, last_value)
        values (${DEFAULT_TENANT_ID}, 'invoice', ${ANNEE}, 9999)`
      assert.equal(await numero('invoice'), `FA-${ANNEE}-10000`)
    })
  })

  describe('sans trou ni doublon', () => {
    it('numérote vingt factures concurrentes de 1 à 20, sans doublon', async () => {
      const numeros = await Promise.all(Array.from({ length: 20 }, () => numero('invoice')))
      const rangs = numeros.map((n) => Number(n.split('-')[2])).sort((a, b) => a - b)
      assert.deepEqual(
        rangs,
        Array.from({ length: 20 }, (_, index) => index + 1),
      )
    })

    it('rend le numéro d’une transaction annulée', async () => {
      await assert.rejects(
        asTenant(async (tx) => {
          await tx.execute(sql`select next_document_number('invoice')`)
          throw new Error('facture abandonnée')
        }),
      )
      assert.equal(await numero('invoice'), `FA-${ANNEE}-0001`)
    })

    it('fait attendre la seconde transaction jusqu’à la fin de la première', async () => {
      // La première garde son numéro sans valider ; la seconde ne peut ni le
      // reprendre ni en sauter un : elle attend, puis prend le suivant.
      let liberer: () => void = () => {}
      const verrou = new Promise<void>((resolve) => (liberer = resolve))
      let premierPris: () => void = () => {}
      const premier = new Promise<void>((resolve) => (premierPris = resolve))

      const lente = asTenant(async (tx) => {
        const [row] = await tx.execute(sql`select next_document_number('invoice') as numero`)
        premierPris()
        await verrou
        return row.numero as string
      })
      await premier
      const rapide = numero('invoice')
      // Laisse à la seconde le temps de se heurter au verrou.
      await new Promise((resolve) => setTimeout(resolve, 150))
      liberer()

      assert.deepEqual(await Promise.all([lente, rapide]), [`FA-${ANNEE}-0001`, `FA-${ANNEE}-0002`])
    })
  })

  describe('compteurs protégés', () => {
    it('interdit au rôle applicatif d’écrire un compteur', async () => {
      await numero('invoice')
      for (const ecriture of [
        sql`update document_sequences set last_value = 0`,
        sql`delete from document_sequences`,
        sql`insert into document_sequences (document_type, year) values ('invoice', 2099)`,
      ]) {
        assert.equal(
          await errorCode(() => asTenant((tx) => tx.execute(ecriture))),
          PG_INSUFFICIENT_PRIVILEGE,
        )
      }
    })

    it('laisse lire les compteurs de son seul centre', async () => {
      await owner.client`
        insert into tenants (id, name, slug) values (${AUTRE_CENTRE}, 'Autre centre', 'autre-centre-num')`
      await numero('invoice')
      await numero('invoice', AUTRE_CENTRE)
      const rows = await asTenant((tx) => tx.execute(sql`select tenant_id, last_value from document_sequences`))
      assert.deepEqual(
        rows.map((row) => row.tenant_id),
        [DEFAULT_TENANT_ID],
      )
    })

    it('refuse de numéroter hors du contexte d’un centre', async () => {
      await assert.rejects(app.db.execute(sql`select next_document_number('invoice')`))
      const [row] = await owner.client`select count(*)::int as n from document_sequences`
      assert.equal(row.n, 0)
    })
  })
})
