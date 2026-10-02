import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { and, eq, sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import { POST } from '../../app/api/maintenance/contrats/route.ts'
import { PG_INSUFFICIENT_PRIVILEGE, pgErrorCode } from '../../db/errors.ts'
import { createDatabase, withTenant, type Transaction } from '../../db/index.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { bookings } from '../reservations/schema.ts'
import { renewTacitContracts } from './reconduction-queries.ts'
import { contractRenewals, contracts } from './schema.ts'

/**
 * Reconduction tacite (R10, ADR 023, ADR 033) : la tâche nocturne prolonge un
 * contrat dès que la reconduction est acquise, l'occupation suit, et le
 * journal garde l'ancien et le nouveau terme. Éprouvée sous `app_centre`.
 */
const ownerUrl = process.env.TEST_OWNER_DATABASE_URL ?? process.env.DATABASE_URL
const appUrl = process.env.TEST_DATABASE_URL

const raison = !appUrl
  ? 'TEST_DATABASE_URL non défini'
  : !ownerUrl
    ? 'TEST_OWNER_DATABASE_URL non défini'
    : false

describe('reconduction tacite', { skip: raison }, () => {
  // La route ouvre sa propre connexion, par APP_DATABASE_URL.
  if (appUrl) process.env.APP_DATABASE_URL = appUrl
  const TOKEN = 'jeton-de-maintenance-de-test'

  const owner = createDatabase(ownerUrl ?? '', { onnotice: () => {} })
  const app = createDatabase(appUrl ?? '')

  const CLIENT = '01a00000-0000-7000-8000-0000000e4c01'
  const BUREAU = '01a00000-0000-7000-8000-0000000e4b01'
  const AUTRE_BUREAU = '01a00000-0000-7000-8000-0000000e4b02'

  const asTenant = <T>(run: (tx: Transaction) => Promise<T>) => withTenant(DEFAULT_TENANT_ID, run, app.db)

  /** Bureau annuel en cours jusqu'au 31 décembre 2026, reconduction de douze mois, préavis de 90 jours. */
  const contrat = async (values: Partial<typeof contracts.$inferInsert> = {}): Promise<string> => {
    const [row] = await asTenant((tx) =>
      tx
        .insert(contracts)
        .values({
          clientId: CLIENT,
          reference: 'BUR-RECONDUIT',
          contractType: 'bureau',
          status: 'active',
          startsOn: '2026-01-01',
          endsOn: '2026-12-31',
          amountCents: 90_000,
          resourceId: BUREAU,
          tacitRenewal: true,
          renewalMonths: 12,
          noticeDays: 90,
          ...values,
        })
        .returning({ id: contracts.id }),
    )
    return row.id
  }

  const lire = async (id: string) => {
    const [row] = await asTenant((tx) => tx.select().from(contracts).where(eq(contracts.id, id)))
    return row
  }

  const journal = (id: string) =>
    asTenant((tx) => tx.select().from(contractRenewals).where(eq(contractRenewals.contractId, id)))

  const reconduire = (today: string) => asTenant((tx) => renewTacitContracts(tx, today))

  const saved = process.env.MAINTENANCE_TOKEN

  before(async () => {
    await migrate(owner.db, { migrationsFolder: './src/db/migrations' })
  })

  beforeEach(async () => {
    process.env.MAINTENANCE_TOKEN = TOKEN
    await owner.client`truncate table bookings, contracts, rate_plan_items, rate_plans, clients, resources, services, offers cascade`
    await asTenant(async (tx) => {
      await tx.execute(sql`insert into clients (id, name) values (${CLIENT}, 'Acme SAS')`)
      await tx.execute(sql`
        insert into resources (id, resource_type, code, name) values
          (${BUREAU}, 'bureau', 'BUR-R1', 'Bureau 1'),
          (${AUTRE_BUREAU}, 'bureau', 'BUR-R2', 'Bureau 2')`)
    })
  })

  after(async () => {
    if (saved === undefined) delete process.env.MAINTENANCE_TOKEN
    else process.env.MAINTENANCE_TOKEN = saved
    await owner.client`truncate table bookings, contracts, rate_plan_items, rate_plans, clients, resources, services, offers cascade`
    const global = globalThis as { database?: { client: { end: () => Promise<void> } } }
    await Promise.all([owner.client.end(), app.client.end(), global.database?.client.end()])
  })

  it('attend le dernier jour de préavis, puis prolonge d’une période et l’inscrit au journal', async () => {
    const id = await contrat()
    assert.deepEqual((await reconduire('2026-10-03')).renewed, [])
    assert.equal((await lire(id)).endsOn, '2026-12-31')

    const bilan = await reconduire('2026-10-04')
    assert.deepEqual(bilan.renewed, [
      { contractId: id, reference: 'BUR-RECONDUIT', previousEndsOn: '2026-12-31', newEndsOn: '2027-12-31' },
    ])
    assert.equal((await lire(id)).endsOn, '2027-12-31')
    const [ligne] = await journal(id)
    assert.deepEqual(
      [ligne.previousEndsOn, ligne.newEndsOn, ligne.renewedOn],
      ['2026-12-31', '2027-12-31', '2026-10-04'],
    )

    // L'occupation du bureau suit le nouveau terme (ADR 018).
    const [occupation] = await asTenant((tx) =>
      tx
        .select({ endsAt: bookings.endsAt })
        .from(bookings)
        .where(and(eq(bookings.contractId, id), eq(bookings.kind, 'contract'))),
    )
    assert.ok(occupation.endsAt > new Date('2027-12-31T00:00:00Z'))

    // Rejouée, la tâche ne prolonge pas deux fois.
    assert.deepEqual((await reconduire('2026-10-05')).renewed, [])
    assert.equal((await journal(id)).length, 1)
  })

  it('ne reconduit ni un contrat résilié, ni un contrat sans reconduction, ni un brouillon', async () => {
    const resilie = await contrat({ reference: 'RESILIE' })
    await asTenant((tx) =>
      tx
        .update(contracts)
        .set({ status: 'terminated', terminatedOn: '2026-12-31', terminationReason: 'Préavis reçu' })
        .where(eq(contracts.id, resilie)),
    )
    await contrat({ reference: 'SANS-RECONDUCTION', tacitRenewal: false, renewalMonths: null, resourceId: AUTRE_BUREAU })
    await contrat({ reference: 'BROUILLON', status: 'draft', resourceId: null })
    assert.deepEqual((await reconduire('2026-11-15')).renewed, [])
  })

  it('garde le terme et le dit quand la ressource est déjà prise après lui', async () => {
    const id = await contrat()
    await asTenant((tx) =>
      tx.execute(sql`
        insert into bookings (resource_id, channel, starts_at, ends_at, title)
        values (${BUREAU}, 'staff', '2027-01-15T08:00:00Z', '2027-01-15T10:00:00Z', 'Visite')`),
    )
    const autre = await contrat({ reference: 'BUR-LIBRE', resourceId: AUTRE_BUREAU })

    const bilan = await reconduire('2026-10-04')
    assert.deepEqual(
      bilan.renewed.map((renewed) => renewed.reference),
      ['BUR-LIBRE'],
    )
    assert.equal(bilan.failures.length, 1)
    assert.equal(bilan.failures[0].contractId, id)
    assert.match(bilan.failures[0].message, /déjà occupée après le 31\/12\/2026/)
    assert.equal((await lire(id)).endsOn, '2026-12-31')
    assert.deepEqual(await journal(id), [])
    assert.equal((await lire(autre)).endsOn, '2027-12-31')
  })

  it('tient un journal que l’application ne réécrit pas', async () => {
    const id = await contrat()
    await reconduire('2026-10-04')
    for (const tentative of [
      () => asTenant((tx) => tx.update(contractRenewals).set({ newEndsOn: '2030-12-31' })),
      () => asTenant((tx) => tx.delete(contractRenewals).where(eq(contractRenewals.contractId, id))),
    ]) {
      try {
        await tentative()
        assert.fail('le journal ne devrait pas changer')
      } catch (error) {
        assert.equal(pgErrorCode(error), PG_INSUFFICIENT_PRIVILEGE)
      }
    }
  })

  it('se lance par la route de maintenance, au jour du centre', async () => {
    // Terme passé depuis longtemps : la reconduction rattrape les périodes manquées.
    const id = await contrat({ startsOn: '2020-01-01', endsOn: '2020-12-31', noticeDays: 0 })
    const refus = await POST(new Request('http://127.0.0.1:3000/api/maintenance/contrats', { method: 'POST' }))
    assert.equal(refus.status, 404)

    const response = await POST(
      new Request('http://127.0.0.1:3000/api/maintenance/contrats', {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}` },
      }),
    )
    assert.equal(response.status, 200)
    const bilan = await response.json()
    assert.equal(bilan.renewed.length, 1)
    const terme = (await lire(id)).endsOn as string
    assert.match(terme, /-12-31$/)
    assert.ok(terme >= new Date().toISOString().slice(0, 10))
  })
})
