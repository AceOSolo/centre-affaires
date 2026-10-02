import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import { createDatabase, withTenant } from '../../../../db/index.ts'
import { DEFAULT_TENANT_ID } from '../../../../db/tenants.ts'
import { todayIsoDate } from '../../../../lib/dates.ts'
import { listInvoiceRuns } from '../../../../modules/facturation/lot-queries.ts'
import { POST } from './route.ts'

/**
 * Lot de facturation planifié (R13, ADR 033) : la route que le serveur
 * appelle le 1er du mois prépare les brouillons du mois du centre, sans
 * membre de l'équipe, et ne refacture rien quand on la rejoue.
 */
const ownerUrl = process.env.TEST_OWNER_DATABASE_URL ?? process.env.DATABASE_URL
const appUrl = process.env.TEST_DATABASE_URL

const raison = !appUrl
  ? 'TEST_DATABASE_URL non défini'
  : !ownerUrl
    ? 'TEST_OWNER_DATABASE_URL non défini'
    : false

describe('lot de facturation planifié', { skip: raison }, () => {
  // La route ouvre sa propre connexion, par APP_DATABASE_URL.
  if (appUrl) process.env.APP_DATABASE_URL = appUrl
  const TOKEN = 'jeton-de-maintenance-de-test'

  const owner = createDatabase(ownerUrl ?? '', { onnotice: () => {} })
  const app = createDatabase(appUrl ?? '')
  const CLIENT = '01a00000-0000-7000-8000-0000000f3c01'

  const asTenant = <T>(run: Parameters<typeof withTenant<T>>[1]) => withTenant(DEFAULT_TENANT_ID, run, app.db)

  const appeler = (authorization?: string, mois?: string) =>
    POST(
      new Request(`http://127.0.0.1:3000/api/maintenance/facturation${mois ? `?mois=${mois}` : ''}`, {
        method: 'POST',
        headers: authorization ? { authorization } : {},
      }),
    )

  const saved = process.env.MAINTENANCE_TOKEN
  let ceMois = ''

  before(async () => {
    await migrate(owner.db, { migrationsFolder: './src/db/migrations' })
  })

  beforeEach(async () => {
    process.env.MAINTENANCE_TOKEN = TOKEN
    await owner.client`truncate table bookings, contracts, rate_plan_items, rate_plans, clients, resources, services, offers cascade`
    await owner.client`truncate table invoice_runs cascade`
    await owner.client`update tenants set recurring_billing_timing = 'in_advance' where id = ${DEFAULT_TENANT_ID}`
    const [tenant] = await owner.client`select timezone from tenants where id = ${DEFAULT_TENANT_ID}`
    // Le mois du centre, dans son fuseau (décision 4).
    ceMois = todayIsoDate(tenant.timezone as string).slice(0, 7)
    await asTenant(async (tx) => {
      await tx.execute(sql`
        insert into clients (id, name, status, address_line1, postal_code, city)
        values (${CLIENT}, 'Atelier Durand', 'active', '2 place du Marché', '38000', 'Grenoble')`)
      // Domiciliation à 30 € HT par mois, depuis le début de l'an dernier.
      await tx.execute(sql`
        insert into contracts (client_id, reference, contract_type, status, starts_on, amount_cents)
        values (${CLIENT}, 'DOM-PLANIFIE', 'domiciliation', 'active',
                (date_trunc('year', now()) - interval '1 year')::date, 3000)`)
    })
  })

  after(async () => {
    if (saved === undefined) delete process.env.MAINTENANCE_TOKEN
    else process.env.MAINTENANCE_TOKEN = saved
    await owner.client`truncate table bookings, contracts, rate_plan_items, rate_plans, clients, resources, services, offers cascade`
    await owner.client`truncate table invoice_runs cascade`
    const global = globalThis as { database?: { client: { end: () => Promise<void> } } }
    await Promise.all([owner.client.end(), app.client.end(), global.database?.client.end()])
  })

  it('prépare les brouillons du mois du centre, sans membre de l’équipe', async () => {
    const response = await appeler(`Bearer ${TOKEN}`)
    assert.equal(response.status, 200)
    const bilan = await response.json()
    assert.equal(bilan.month, ceMois)
    assert.equal(bilan.invoicesCreated, 1)

    const [run] = await owner.client`select created_by, status, period_start::text from invoice_runs`
    assert.equal(run.created_by, null)
    assert.equal(run.status, 'completed')
    assert.equal(run.period_start, `${ceMois}-01`)
    const [facture] = await owner.client`
      select status, number from invoices where client_id = ${CLIENT} and kind = 'invoice'`
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
    await owner.client`insert into invoice_runs (period_start, period_end) values ('2026-01-01', '2026-01-31')`
    const response = await appeler(`Bearer ${TOKEN}`)
    assert.equal(response.status, 409)
    assert.match((await response.json()).error, /déjà en cours/)
  })

  it('n’existe pas sans le bon jeton', async () => {
    for (const authorization of [undefined, 'Bearer mauvais', `Bearer ${TOKEN}x`]) {
      assert.equal((await appeler(authorization)).status, 404, String(authorization))
    }
    const [{ n }] = await owner.client`select count(*)::int as n from invoice_runs`
    assert.equal(n, 0)
  })
})
