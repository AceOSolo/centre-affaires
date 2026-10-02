import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import { createDatabase, withClientScope, withTenant, type Transaction } from '../../db/index.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import type { ClientAccount } from '../clients/comptes.ts'
import { findContractDocumentForAccounts, listContractsForAccounts } from './compte-queries.ts'
import { archiveContractDocument } from './documents.ts'

/**
 * « Mes contrats » (R17), contre la base et sous le rôle applicatif : les
 * contrats engagés des entreprises du compte, leurs avenants signés et leurs
 * documents archivés — jamais un brouillon, un contrat archivé ou le contrat
 * d'une autre entreprise.
 */
const ownerUrl = process.env.TEST_OWNER_DATABASE_URL ?? process.env.DATABASE_URL
const appUrl = process.env.TEST_DATABASE_URL

const raison = !appUrl
  ? 'TEST_DATABASE_URL non défini'
  : !ownerUrl
    ? 'TEST_OWNER_DATABASE_URL non défini'
    : false

describe('contrats de l’espace client', { skip: raison }, () => {
  // Les requêtes du module ouvrent leur propre connexion, par APP_DATABASE_URL.
  if (appUrl) process.env.APP_DATABASE_URL = appUrl

  const owner = createDatabase(ownerUrl ?? '', { onnotice: () => {} })
  const app = createDatabase(appUrl ?? '')

  const DURAND = '01a00000-0000-7000-8000-0000000f1c01'
  const PETIT = '01a00000-0000-7000-8000-0000000f1c02'
  const JEANNE = '01a00000-0000-7000-8000-0000000f1d01'
  const BUREAU = '01a00000-0000-7000-8000-0000000f1e01'
  const TODAY = '2026-10-15'

  const durand: ClientAccount[] = [{ memberId: JEANNE, clientId: DURAND, clientName: 'Atelier Durand' }]

  const asTenant = <T>(run: (tx: Transaction) => Promise<T>) =>
    withTenant(DEFAULT_TENANT_ID, run, app.db)

  /** Un contrat, activé sauf demande contraire, avec son document initial. */
  const contracter = async (
    clientId: string,
    reference: string,
    { activer = true, resourceId = null as string | null } = {},
  ): Promise<string> =>
    asTenant(async (tx) => {
      const [contrat] = await tx.execute(sql`
        insert into contracts (client_id, reference, contract_type, starts_on, amount_cents, resource_id,
                               commitment_months)
        values (${clientId}, ${reference}, 'bureau', '2026-01-01', 30000, ${resourceId}, 12)
        returning id`)
      const id = contrat.id as string
      if (activer) {
        await tx.execute(sql`update contracts set status = 'active' where id = ${id}`)
        await archiveContractDocument(tx, { contractId: id, amendmentId: null, generatedBy: null })
      }
      return id
    })

  before(async () => {
    await migrate(owner.db, { migrationsFolder: './src/db/migrations' })
  })

  beforeEach(async () => {
    await owner.client`truncate table bookings, contracts, clients, resources, services, offers cascade`
    await asTenant(async (tx) => {
      await tx.execute(sql`
        insert into resources (id, resource_type, code, name) values (${BUREAU}, 'bureau', 'BUR-F1', 'Bureau 12')`)
      await tx.execute(sql`
        insert into clients (id, name, status) values
          (${DURAND}, 'Atelier Durand', 'active'), (${PETIT}, 'Boulangerie Petit', 'active')`)
      await tx.execute(sql`
        insert into client_members (id, client_id, email, auth_user_id)
        values (${JEANNE}, ${DURAND}, 'jeanne@durand.fr', 'u-jeanne')`)
    })
  })

  after(async () => {
    const global = globalThis as { database?: { client: { end: () => Promise<void> } } }
    await Promise.all([owner.client.end(), app.client.end(), global.database?.client.end()])
  })

  it('ne montre que les contrats engagés des entreprises du compte', async () => {
    const enCours = await contracter(DURAND, 'CT-F-1', { resourceId: BUREAU })
    const resilie = await contracter(DURAND, 'CT-F-2')
    await asTenant((tx) =>
      tx.execute(sql`update contracts set status = 'terminated', terminated_on = '2026-06-30' where id = ${resilie}`),
    )
    await contracter(DURAND, 'CT-F-3', { activer: false })
    const archive = await contracter(DURAND, 'CT-F-4')
    await asTenant((tx) => tx.execute(sql`update contracts set deleted_at = now() where id = ${archive}`))
    await contracter(PETIT, 'CT-F-5')

    const rows = await listContractsForAccounts(durand, TODAY)
    // En cours d'abord, puis les autres.
    assert.deepEqual(
      rows.map((row) => row.reference),
      ['CT-F-1', 'CT-F-2'],
    )
    const [premier, second] = rows
    assert.equal(premier.id, enCours)
    assert.equal(premier.status, 'active')
    assert.deepEqual(premier.currentResource, { name: 'Bureau 12', resourceType: 'bureau' })
    assert.equal(premier.commitmentEndsOn, '2026-12-31')
    assert.equal(second.status, 'terminated')
    assert.equal(second.terminatedOn, '2026-06-30')
    assert.equal(second.currentResource, null)
  })

  it('donne le prix en vigueur et les seuls avenants signés', async () => {
    const id = await contracter(DURAND, 'CT-F-6')
    await asTenant(async (tx) => {
      await tx.execute(sql`
        insert into contract_amendments (contract_id, effective_on, amount_cents, status, reason)
        values (${id}, '2026-07-01', 35000, 'signed', 'Révision annuelle')`)
      await tx.execute(sql`
        insert into contract_amendments (contract_id, effective_on, amount_cents)
        values (${id}, '2026-11-01', 40000)`)
    })
    const [row] = await listContractsForAccounts(durand, TODAY)
    assert.equal(row.currentAmountCents, 35000)
    assert.deepEqual(
      row.amendments.map((amendment) => [amendment.number, amendment.effectiveOn, amendment.reason]),
      [[1, '2026-07-01', 'Révision annuelle']],
    )
    // Avant l'avenant, la version initiale.
    const [avant] = await listContractsForAccounts(durand, '2026-03-01')
    assert.equal(avant.currentAmountCents, 30000)
  })

  it('ouvre un document archivé de l’entreprise, avec son empreinte vérifiée', async () => {
    const id = await contracter(DURAND, 'CT-F-7')
    const [row] = await listContractsForAccounts(durand, TODAY)
    assert.deepEqual(
      row.documents.map((document) => [document.version, document.amendmentNumber]),
      [[1, null]],
    )
    const document = await findContractDocumentForAccounts(id, 1, durand)
    assert.equal(document?.reference, 'CT-F-7')
    assert.equal(document?.intact, true)
    assert.equal(document?.snapshot?.contract.reference, 'CT-F-7')
    assert.equal(await findContractDocumentForAccounts(id, 2, durand), undefined)
  })

  it('n’ouvre pas le document d’une autre entreprise ni d’un contrat archivé', async () => {
    const autre = await contracter(PETIT, 'CT-F-8')
    const archive = await contracter(DURAND, 'CT-F-9')
    await asTenant((tx) => tx.execute(sql`update contracts set deleted_at = now() where id = ${archive}`))
    assert.equal(await findContractDocumentForAccounts(autre, 1, durand), undefined)
    assert.equal(await findContractDocumentForAccounts(archive, 1, durand), undefined)
    assert.equal(await findContractDocumentForAccounts('pas-un-uuid', 1, durand), undefined)
    assert.equal(await findContractDocumentForAccounts(archive, 0, durand), undefined)
  })

  it('tient par la portée client seule, sans aucun filtre', async () => {
    await contracter(DURAND, 'CT-F-10')
    await contracter(PETIT, 'CT-F-11')
    const references = await withClientScope(
      DEFAULT_TENANT_ID,
      [DURAND],
      (tx) =>
        tx.execute(sql`
          select k.reference from contract_documents as d join contracts as k on k.id = d.contract_id`),
      app.db,
    )
    assert.deepEqual(
      references.map((row) => row.reference),
      ['CT-F-10'],
    )
  })
})
