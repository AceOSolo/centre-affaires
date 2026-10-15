import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'

import { withTenant } from '../../../../db/index.ts'
import {
  ouvrirBasesDeTest,
  raisonDeSaut,
  viderTables,
  type TestDatabases,
} from '../../../../db/test-support.ts'
import { DEFAULT_TENANT_ID } from '../../../../db/tenants.ts'
import { todayIsoDate } from '../../../../lib/dates.ts'
import { listInvoiceRuns } from '../../../../modules/facturation/lot-queries.ts'
import { POST } from './route.ts'

/**
 * Lot de facturation planifié (R13, ADR 033) : la route que le serveur
 * appelle le 1er du mois prépare les brouillons du mois du centre, sans
 * membre de l'équipe, et ne refacture rien quand on la rejoue.
 */
describe('lot de facturation planifié', { skip: raisonDeSaut }, () => {
  const TOKEN = 'jeton-de-maintenance-de-test'
  const CLIENT = '01a00000-0000-7000-8000-0000000f3c01'
  const CONTRAT = '01a00000-0000-7000-8000-0000000f3c02'

  let bases: TestDatabases
  const asTenant = <T>(run: Parameters<typeof withTenant<T>>[1]) =>
    withTenant(DEFAULT_TENANT_ID, run, bases.app.db)

  const lire = async (requete: string, params: unknown[] = []) => {
    const [rows] = await bases.owner.client.query(requete, params)
    return rows as Record<string, unknown>[]
  }

  const appeler = (authorization?: string, mois?: string) =>
    POST(
      new Request(`http://127.0.0.1:3000/api/maintenance/facturation${mois ? `?mois=${mois}` : ''}`, {
        method: 'POST',
        headers: authorization ? { authorization } : {},
      }),
    )

  /** Toutes les tables métier : les clés étrangères entre elles rendent un vidage partiel inutilisable. */
  const toutVider = async () => {
    const tables = await lire(
      `select table_name as name from information_schema.tables
        where table_schema = database() and table_type = 'BASE TABLE'
          and table_name not in ('tenants', '__migrations') and table_name not like 'auth\\_%'`,
    )
    await viderTables(
      bases.owner,
      ...tables.map((table) => String(table.name)),
    )
  }

  const saved = process.env.MAINTENANCE_TOKEN
  let ceMois = ''

  before(async () => {
    bases = await ouvrirBasesDeTest()
    // La route ouvre sa propre connexion, par `DB_*` : on la pointe sur la
    // base de test, sous l'identité applicative.
    const e = process.env
    e.DB_HOST = e.TEST_DB_HOST ?? e.DB_HOST ?? '127.0.0.1'
    e.DB_PORT = e.TEST_DB_PORT ?? e.DB_PORT ?? '3306'
    e.DB_NAME = e.TEST_DB_NAME
    e.DB_USER = e.TEST_DB_USER ?? e.TEST_DB_ADMIN_USER ?? e.DB_ADMIN_USER ?? 'root'
    e.DB_PASSWORD = e.TEST_DB_USER
      ? (e.TEST_DB_PASSWORD ?? '')
      : (e.TEST_DB_ADMIN_PASSWORD ?? e.DB_ADMIN_PASSWORD ?? '')
  })

  beforeEach(async () => {
    process.env.MAINTENANCE_TOKEN = TOKEN
    await toutVider()
    await bases.owner.client.query(
      `update tenants set recurring_billing_timing = 'in_advance' where id = ?`,
      [DEFAULT_TENANT_ID],
    )
    const [tenant] = await lire('select timezone from tenants where id = ?', [DEFAULT_TENANT_ID])
    // Le mois du centre, dans son fuseau (décision 4).
    ceMois = todayIsoDate(tenant.timezone as string).slice(0, 7)
    await asTenant(async (tx) => {
      await tx.execute(sql`
        insert into clients (id, name, status, address_line1, postal_code, city)
        values (${CLIENT}, 'Atelier Durand', 'active', '2 place du Marché', '38000', 'Grenoble')`)
      // Domiciliation à 30 € HT par mois, depuis le début de l'an dernier.
      await tx.execute(sql`
        insert into contracts (id, client_id, reference, contract_type, status, starts_on, amount_cents)
        values (${CONTRAT}, ${CLIENT}, 'DOM-PLANIFIE', 'domiciliation', 'active',
                makedate(year(current_date()) - 1, 1), 3000)`)
    })
  })

  after(async () => {
    if (saved === undefined) delete process.env.MAINTENANCE_TOKEN
    else process.env.MAINTENANCE_TOKEN = saved
    await toutVider()
    const global = globalThis as { database?: { client: { end: () => Promise<void> } } }
    await Promise.all([bases.fermer(), global.database?.client.end()])
  })

  it('prépare les brouillons du mois du centre, sans membre de l’équipe', async () => {
    const response = await appeler(`Bearer ${TOKEN}`)
    assert.equal(response.status, 200)
    const bilan = await response.json()
    assert.equal(bilan.month, ceMois)
    assert.equal(bilan.invoicesCreated, 1)

    const [run] = await lire(
      'select created_by, status, cast(period_start as char) as period_start from invoice_runs',
    )
    assert.equal(run.created_by, null)
    assert.equal(run.status, 'completed')
    assert.equal(run.period_start, `${ceMois}-01`)
    const [facture] = await lire(
      `select status, number from invoices where client_id = ? and kind = 'invoice'`,
      [CLIENT],
    )
    // Le lot n'émet rien : l'équipe relit, puis émet.
    assert.equal(facture.status, 'draft')
    assert.equal(facture.number, null)

    const [journal] = await listInvoiceRuns()
    assert.equal(journal.createdByName, 'Tâche planifiée')
  })

  it('rejoué, ne refacture rien ; un autre mois se demande explicitement', async () => {
    await appeler(`Bearer ${TOKEN}`)
    const rejoue = await (await appeler(`Bearer ${TOKEN}`)).json()
    assert.equal(rejoue.invoicesCreated, 0)
    assert.equal(rejoue.linesCreated, 0)

    const autre = await appeler(`Bearer ${TOKEN}`, '2025-01')
    assert.equal(autre.status, 200)
    assert.equal((await autre.json()).month, '2025-01')
    assert.equal((await appeler(`Bearer ${TOKEN}`, '2025-13')).status, 400)
  })

  it('attend le lot en cours plutôt que de le doubler', async () => {
    await bases.owner.client.query(
      `insert into invoice_runs (id, tenant_id, period_start, period_end)
       values ('01a00000-0000-7000-8000-0000000f3c03', ?, '2026-01-01', '2026-01-31')`,
      [DEFAULT_TENANT_ID],
    )
    const response = await appeler(`Bearer ${TOKEN}`)
    assert.equal(response.status, 409)
    assert.match((await response.json()).error, /déjà en cours/)
  })

  it('n’existe pas sans le bon jeton', async () => {
    for (const authorization of [undefined, 'Bearer mauvais', `Bearer ${TOKEN}x`]) {
      assert.equal((await appeler(authorization)).status, 404, String(authorization))
    }
    const [{ n }] = await lire('select count(*) as n from invoice_runs')
    assert.equal(Number(n), 0)
  })
})
