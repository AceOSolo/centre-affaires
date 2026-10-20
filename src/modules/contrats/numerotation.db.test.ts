import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'

import {
  DB_CHECK_VIOLATION,
  DB_INSUFFICIENT_PRIVILEGE,
  dbErrorCode,
} from '../../db/errors.ts'
import { withTenant } from '../../db/index.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { ouvrirBasesDeTest, raisonDeSaut, viderTables, type TestDatabases } from '../../db/test-support.ts'
import { uuidv7 } from '../../lib/uuid.ts'

/**
 * Numérotation des documents (R12, ADR 021) : une série par centre, par type et
 * par année, sans trou ni doublon, même en concurrence.
 *
 * Éprouvée sous l'identité applicative : c'est elle qui demande les numéros, et
 * elle qui ne doit pas pouvoir toucher aux compteurs (droits retirés par
 * `infra/migrer.ts`, éprouvés seulement quand `TEST_DB_USER` distingue les
 * deux identités).
 */

/** Année civile du centre (Paris) : celle que porte le numéro. */
const ANNEE = Number(
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric' }).format(new Date()),
)

describe('numérotation des documents', { skip: raisonDeSaut }, () => {
  let bases: TestDatabases

  const CLIENT = '01a00000-0000-7000-8000-0000000d0c01'
  const AUTRE_CENTRE = '01999f00-0000-7000-8000-0000000000f6'
  const CLIENT_AILLEURS = '01a00000-0000-7000-8000-0000000d0c02'

  const asTenant = <T>(run: Parameters<typeof withTenant<T>>[1], tenant = DEFAULT_TENANT_ID) =>
    withTenant(tenant, run, bases.app.db)

  const errorCode = async (run: () => Promise<unknown>) => {
    try {
      await run()
    } catch (error) {
      return dbErrorCode(error)
    }
    return undefined
  }

  const numero = async (type: string, tenant = DEFAULT_TENANT_ID): Promise<string> => {
    const [rows] = (await asTenant(
      (tx) => tx.execute(sql`select next_document_number(${type}) as numero`),
      tenant,
    )) as unknown as [{ numero: string }[]]
    return rows[0].numero
  }

  /** Contrat saisi sans référence : la base la choisit. */
  const contratSansReference = async (clientId = CLIENT, tenant = DEFAULT_TENANT_ID) => {
    const id = uuidv7()
    return asTenant(async (tx) => {
      await tx.execute(sql`
        insert into contracts (id, tenant_id, client_id, contract_type, starts_on, amount_cents)
        values (${id}, ${tenant}, ${clientId}, 'domiciliation', '2026-10-01', 9000)`)
      const [rows] = (await tx.execute(sql`select reference from contracts where id = ${id}`)) as unknown as [
        { reference: string }[],
      ]
      return rows[0].reference
    }, tenant)
  }

  const contratAvecReference = (reference: string) =>
    asTenant((tx) =>
      tx.execute(sql`
        insert into contracts (client_id, reference, contract_type, starts_on, amount_cents)
        values (${CLIENT}, ${reference}, 'domiciliation', '2026-10-01', 9000)`),
    )

  before(async () => {
    bases = await ouvrirBasesDeTest()
  })

  beforeEach(async () => {
    await viderTables(
      bases.owner,
      'bookings',
      'contract_documents',
      'contract_amendments',
      'contract_lines',
      'contracts',
      'rate_plan_items',
      'rate_plans',
      'clients',
      'resources',
      'document_sequences',
    )
    await bases.owner.client.query('delete from tenants where id <> ?', [DEFAULT_TENANT_ID])
    await asTenant((tx) => tx.execute(sql`insert into clients (id, name) values (${CLIENT}, 'Acme SAS')`))
  })

  after(async () => {
    await bases.fermer()
  })

  describe('contrats', () => {
    it('numérote les contrats saisis sans référence, dans l’ordre', async () => {
      assert.equal(await contratSansReference(), `CT-${ANNEE}-0001`)
      assert.equal(await contratSansReference(), `CT-${ANNEE}-0002`)
    })

    it('garde une référence saisie à la main, sans consommer de numéro', async () => {
      await contratAvecReference('DOM-2026-014')
      assert.equal(await contratSansReference(), `CT-${ANNEE}-0001`)
      const [rows] = (await asTenant((tx) =>
        tx.execute(sql`select count(*) as n from contracts where reference = 'DOM-2026-014'`),
      )) as unknown as [{ n: number | string }[]]
      assert.equal(Number(rows[0].n), 1)
    })

    it('saute un numéro déjà porté par un contrat saisi à la main', async () => {
      // Sans cela, la référence manuelle bloquerait la numérotation pour toujours :
      // chaque tentative retomberait sur le même numéro et échouerait.
      await contratAvecReference(`CT-${ANNEE}-0001`)
      assert.equal(await contratSansReference(), `CT-${ANNEE}-0002`)
    })

    it('saute aussi le numéro d’un contrat archivé', async () => {
      await contratAvecReference(`CT-${ANNEE}-0001`)
      await asTenant((tx) => tx.execute(sql`update contracts set deleted_at = current_timestamp(3)`))
      assert.equal(await contratSansReference(), `CT-${ANNEE}-0002`)
    })

    it('refuse une référence vide : il faut l’omettre pour obtenir un numéro', async () => {
      assert.equal(await errorCode(() => contratAvecReference('  ')), DB_CHECK_VIOLATION)
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
      await bases.owner.client.query('insert into tenants (id, name, slug) values (?, ?, ?)', [
        AUTRE_CENTRE,
        'Autre centre',
        'autre-centre-num',
      ])
      // Hors du centre par défaut, `tenant_id` se donne : la valeur par défaut
      // posée en base est celle du centre unique.
      await asTenant(
        (tx) =>
          tx.execute(sql`
            insert into clients (id, tenant_id, name) values (${CLIENT_AILLEURS}, ${AUTRE_CENTRE}, 'Beta')`),
        AUTRE_CENTRE,
      )
      assert.equal(await numero('invoice'), `FA-${ANNEE}-0001`)
      assert.equal(await numero('invoice', AUTRE_CENTRE), `FA-${ANNEE}-0001`)
      assert.equal(await contratSansReference(CLIENT_AILLEURS, AUTRE_CENTRE), `CT-${ANNEE}-0001`)
      assert.equal(await numero('invoice'), `FA-${ANNEE}-0002`)
    })

    it('ouvre une nouvelle série chaque année, l’année dans le numéro', async () => {
      await bases.owner.client.query(
        // `last_value` est un mot réservé de MySQL (fonction de fenêtre) : entre accents graves.
        'insert into document_sequences (id, tenant_id, document_type, year, `last_value`) ' +
          "values (?, ?, 'invoice', ?, 57)",
        [uuidv7(), DEFAULT_TENANT_ID, ANNEE - 1],
      )
      assert.equal(await numero('invoice'), `FA-${ANNEE}-0001`)
      const [precedente] = (await bases.owner.client.query(
        'select `last_value` from document_sequences where year = ?',
        [ANNEE - 1],
      )) as unknown as [{ last_value: number }[]]
      assert.equal(precedente[0].last_value, 57)
    })

    it('ne tronque jamais au-delà de 9999', async () => {
      await bases.owner.client.query(
        'insert into document_sequences (id, tenant_id, document_type, year, `last_value`) ' +
          "values (?, ?, 'invoice', ?, 9999)",
        [uuidv7(), DEFAULT_TENANT_ID, ANNEE],
      )
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
        const [rows] = (await tx.execute(sql`select next_document_number('invoice') as numero`)) as unknown as [
          { numero: string }[],
        ]
        premierPris()
        await verrou
        return rows[0].numero
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
    it('interdit à l’utilisateur applicatif d’écrire un compteur', async (t) => {
      // Même utilisateur MySQL pour les deux identités (TEST_DB_USER absent, ou
      // DB_USER = propriétaire) : aucun droit n'est retiré, rien à éprouver.
      const utilisateur = async (client: typeof bases.app.client) => {
        const [rows] = (await client.query('select current_user() as u')) as unknown as [{ u: string }[]]
        return rows[0].u
      }
      if ((await utilisateur(bases.app.client)) === (await utilisateur(bases.owner.client))) {
        t.skip('identité applicative = propriétaire : droits non éprouvés')
        return
      }
      await numero('invoice')
      for (const ecriture of [
        // `last_value` est un mot réservé de MySQL 8 : sans guillemets, la requête
        // échoue à l'analyse, avant tout contrôle de droit.
        sql`update document_sequences set \`last_value\` = 0`,
        sql`delete from document_sequences`,
        sql`insert into document_sequences (id, document_type, year) values (uuid(), 'invoice', 2099)`,
      ]) {
        assert.equal(
          await errorCode(() => asTenant((tx) => tx.execute(ecriture))),
          DB_INSUFFICIENT_PRIVILEGE,
        )
      }
    })

    it('refuse de numéroter hors du contexte d’un centre', async () => {
      await assert.rejects(bases.app.db.execute(sql`select next_document_number('invoice')`))
      const [rows] = (await bases.owner.client.query(
        'select count(*) as n from document_sequences',
      )) as unknown as [{ n: number | string }[]]
      assert.equal(Number(rows[0].n), 0)
    })
  })
})
