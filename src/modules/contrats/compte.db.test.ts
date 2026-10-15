import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'

import { DB_CLIENT_SCOPE_REFUSED, dbErrorCode } from '../../db/errors.ts'
import { withClientScope, withTenant, type Transaction } from '../../db/index.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { ouvrirBasesDeTest, raisonDeSaut, viderTables, type TestDatabases } from '../../db/test-support.ts'
import { uuidv7 } from '../../lib/uuid.ts'
import type { ClientAccount } from '../clients/comptes.ts'
import { findContractDocumentForAccounts, listContractsForAccounts } from './compte-queries.ts'
import { archiveContractDocument } from './documents.ts'

/**
 * « Mes contrats » (R17), contre la base et sous l'identité applicative : les
 * contrats engagés des entreprises du compte, leurs avenants signés et leurs
 * documents archivés — jamais un brouillon, un contrat archivé ou le contrat
 * d'une autre entreprise.
 *
 * Pas de RLS en MySQL : la base ne filtre plus les lectures, c'est chaque
 * requête de `compte-queries.ts` qui filtre sur les entreprises du compte
 * (conventions §6). Les écritures sous portée client sont gardées par les
 * triggers de `40-contrats.sql` (`CA015`).
 */
describe('contrats de l’espace client', { skip: raisonDeSaut }, () => {
  let bases: TestDatabases

  const DURAND = '01a00000-0000-7000-8000-0000000f1c01'
  const PETIT = '01a00000-0000-7000-8000-0000000f1c02'
  const JEANNE = '01a00000-0000-7000-8000-0000000f1d01'
  const BUREAU = '01a00000-0000-7000-8000-0000000f1e01'
  const TODAY = '2026-10-15'

  const durand: ClientAccount[] = [{ memberId: JEANNE, clientId: DURAND, clientName: 'Atelier Durand' }]
  const petit: ClientAccount[] = [{ memberId: JEANNE, clientId: PETIT, clientName: 'Boulangerie Petit' }]

  const asTenant = <T>(run: (tx: Transaction) => Promise<T>) =>
    withTenant(DEFAULT_TENANT_ID, run, bases.app.db)

  /** Un contrat, activé sauf demande contraire, avec son document initial. */
  const contracter = async (
    clientId: string,
    reference: string,
    { activer = true, resourceId = null as string | null } = {},
  ): Promise<string> =>
    asTenant(async (tx) => {
      const id = uuidv7()
      await tx.execute(sql`
        insert into contracts (id, client_id, reference, contract_type, starts_on, amount_cents, resource_id,
                               commitment_months)
        values (${id}, ${clientId}, ${reference}, 'bureau', '2026-01-01', 30000, ${resourceId}, 12)`)
      if (activer) {
        await tx.execute(sql`update contracts set status = 'active' where id = ${id}`)
        await archiveContractDocument(tx, { contractId: id, amendmentId: null, generatedBy: null })
      }
      return id
    })

  before(async () => {
    bases = await ouvrirBasesDeTest()
    // Les requêtes du module passent par la base du processus : on lui donne
    // celle des tests.
    ;(globalThis as { database?: unknown }).database = bases.app
  })

  beforeEach(async () => {
    await viderTables(
      bases.owner,
      'bookings',
      'contract_documents',
      'contract_amendments',
      'contract_lines',
      'contracts',
      'client_members',
      'clients',
      'resources',
    )
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
    delete (globalThis as { database?: unknown }).database
    await bases.fermer()
  })

  it('ne montre que les contrats engagés des entreprises du compte', async () => {
    const enCours = await contracter(DURAND, 'CT-F-1', { resourceId: BUREAU })
    const resilie = await contracter(DURAND, 'CT-F-2')
    await asTenant((tx) =>
      tx.execute(sql`update contracts set status = 'terminated', terminated_on = '2026-06-30' where id = ${resilie}`),
    )
    await contracter(DURAND, 'CT-F-3', { activer: false })
    const archive = await contracter(DURAND, 'CT-F-4')
    await asTenant((tx) => tx.execute(sql`update contracts set deleted_at = current_timestamp(3) where id = ${archive}`))
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
    await asTenant((tx) => tx.execute(sql`update contracts set deleted_at = current_timestamp(3) where id = ${archive}`))
    assert.equal(await findContractDocumentForAccounts(autre, 1, durand), undefined)
    assert.equal(await findContractDocumentForAccounts(archive, 1, durand), undefined)
    assert.equal(await findContractDocumentForAccounts('pas-un-uuid', 1, durand), undefined)
    assert.equal(await findContractDocumentForAccounts(archive, 0, durand), undefined)
  })

  it('ne montre ni contrats, ni avenants, ni documents d’une autre entreprise', async () => {
    // La base ne filtre plus les lectures : c'est ce que les requêtes du module
    // font, et ce que ce test garde. Les deux entreprises ont un contrat engagé,
    // son document, et Petit un avenant signé.
    const sien = await contracter(DURAND, 'CT-F-10')
    const autre = await contracter(PETIT, 'CT-F-11')
    await asTenant((tx) =>
      tx.execute(sql`
        insert into contract_amendments (contract_id, effective_on, amount_cents, status, reason)
        values (${autre}, '2026-07-01', 35000, 'signed', 'Avenant de Petit')`),
    )

    const rows = await listContractsForAccounts(durand, TODAY)
    assert.deepEqual(
      rows.map((row) => row.id),
      [sien],
    )
    assert.deepEqual(rows[0].amendments, [])
    assert.deepEqual(
      rows[0].documents.map((document) => document.version),
      [1],
    )
    assert.equal(await findContractDocumentForAccounts(autre, 1, durand), undefined)

    // Et réciproquement : Petit voit le sien, avec son avenant, et rien de Durand.
    const rowsPetit = await listContractsForAccounts(petit, TODAY)
    assert.deepEqual(
      rowsPetit.map((row) => row.id),
      [autre],
    )
    assert.deepEqual(
      rowsPetit[0].amendments.map((amendment) => amendment.reason),
      ['Avenant de Petit'],
    )
  })

  describe('portée client : écritures gardées par la base', () => {
    const sousPortee = <T>(run: (tx: Transaction) => Promise<T>) =>
      withClientScope(DEFAULT_TENANT_ID, [DURAND], run, bases.app.db)

    const code = async (run: () => Promise<unknown>) => {
      try {
        await run()
      } catch (error) {
        return dbErrorCode(error)
      }
      return undefined
    }

    it('refuse d’écrire un contrat, ses avenants et ses documents pour une autre entreprise', async () => {
      const autre = await contracter(PETIT, 'CT-F-12')
      assert.equal(
        await code(() =>
          sousPortee((tx) =>
            tx.execute(sql`
              insert into contracts (client_id, reference, contract_type, starts_on, amount_cents)
              values (${PETIT}, 'CT-F-13', 'bureau', '2026-01-01', 100)`),
          ),
        ),
        DB_CLIENT_SCOPE_REFUSED,
      )
      assert.equal(
        await code(() =>
          sousPortee((tx) => tx.execute(sql`update contracts set notes = 'x' where id = ${autre}`)),
        ),
        DB_CLIENT_SCOPE_REFUSED,
      )
      assert.equal(
        await code(() =>
          sousPortee((tx) =>
            tx.execute(sql`
              insert into contract_amendments (contract_id, effective_on, amount_cents)
              values (${autre}, '2026-07-01', 100)`),
          ),
        ),
        DB_CLIENT_SCOPE_REFUSED,
      )
      assert.equal(
        await code(() =>
          sousPortee((tx) =>
            tx.execute(sql`
              insert into contract_documents (contract_id, snapshot) values (${autre}, '{}')`),
          ),
        ),
        DB_CLIENT_SCOPE_REFUSED,
      )
    })

    it('laisse écrire pour une entreprise de la portée', async () => {
      await sousPortee((tx) =>
        tx.execute(sql`
          insert into contracts (client_id, reference, contract_type, starts_on, amount_cents)
          values (${DURAND}, 'CT-F-14', 'bureau', '2026-01-01', 100)`),
      )
      const [rows] = (await asTenant((tx) =>
        tx.execute(sql`select count(*) as n from contracts where reference = 'CT-F-14'`),
      )) as unknown as [{ n: number | string }[]]
      assert.equal(Number(rows[0].n), 1)
    })
  })
})
