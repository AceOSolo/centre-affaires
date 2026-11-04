import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { dbErrorCode } from '../../db/errors.ts'
import { ouvrirBasesDeTest, raisonDeSaut, type TestDatabases } from '../../db/test-support.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { runForTenant } from '../../lib/tenant.ts'
import { uuidv7 } from '../../lib/uuid.ts'
import { toutVider } from '../clients/test-support.ts'
import { readCrmContract, type ReceivedContract } from './contrats-crm.ts'
import { listContractsForCrm, receiveCrmContract } from './contrats-crm-queries.ts'

/**
 * Contrats reçus de Dolibarr, en base (ADR 066), sous l'identité
 * applicative : l'occupation suit le contrat (ADR 018), le chevauchement est
 * refusé par la base (décision 3), le prix d'un contrat engagé suit le CRM
 * sans ouvrir le site aux changements hors avenant, et chaque centre est servi
 * pour lui seul.
 */
describe('contrats du CRM, en base', { skip: raisonDeSaut }, () => {
  const AUTRE = '01999f00-0000-7000-8000-0000000000e9'
  const DURAND = '01a00000-0000-7000-8000-00000011c001'
  const PETIT = '01a00000-0000-7000-8000-00000011c002'
  const BUREAU = '01a00000-0000-7000-8000-00000011a001'
  let bases: TestDatabases

  const brut = async <T>(requete: string, params: unknown[] = []) =>
    ((await bases.owner.client.query(requete, params)) as unknown as [T[]])[0]

  const contrat = (overrides: Record<string, unknown> = {}): ReceivedContract => {
    const read = readCrmContract({
      dolibarrId: '57',
      reference: 'CT2611-0003',
      tiersDolibarrId: '412',
      type: 'bureau',
      statut: 'en_cours',
      debut: '2026-11-01',
      fin: null,
      ressource: 'BUR-12',
      prix: { montantHtCentimes: 45000, periodicite: 'mensuel', tauxTva: '20' },
      ...overrides,
    })
    assert.ok(read.ok, read.ok ? undefined : read.message)
    return read.value
  }
  const recoit = (overrides: Record<string, unknown> = {}) => receiveCrmContract('dolibarr', contrat(overrides))

  const occupations = (contractId: string) =>
    brut<{ resource_id: string; status: string; starts_at: Date; ends_at: Date; client_id: string }>(
      `select resource_id, status, starts_at, ends_at, client_id from bookings
        where contract_id = ? and kind = 'contract' order by created_at`,
      [contractId],
    )
  const contrats = () =>
    brut<{ id: string; reference: string; status: string; amount_cents: number; tacit_renewal: number; deleted_at: Date | null; terminated_on: string | null }>(
      `select id, reference, status, amount_cents, tacit_renewal, deleted_at, date_format(terminated_on, '%Y-%m-%d') as terminated_on
         from contracts order by created_at, id`,
    )

  before(async () => {
    bases = await ouvrirBasesDeTest()
    ;(globalThis as { database?: unknown }).database = bases.app
  })

  beforeEach(async () => {
    await toutVider(bases.owner)
    await bases.owner.client.query('delete from tenants where id = ?', [AUTRE])
    await bases.owner.client.query(`insert into tenants (id, name, slug) values (?, 'Centre de Lyon', 'centre-de-lyon-contrats')`, [AUTRE])
    await bases.owner.client.query(
      `insert into clients (id, tenant_id, name, status) values (?, ?, 'Atelier Durand', 'active'), (?, ?, 'Boulangerie Petit', 'active')`,
      [DURAND, DEFAULT_TENANT_ID, PETIT, DEFAULT_TENANT_ID],
    )
    await bases.owner.client.query(
      `insert into crm_links (id, tenant_id, connector, entity, local_id, external_id) values
         (uuid(), ?, 'dolibarr', 'client', ?, '412'), (uuid(), ?, 'dolibarr', 'client', ?, '413')`,
      [DEFAULT_TENANT_ID, DURAND, DEFAULT_TENANT_ID, PETIT],
    )
    await bases.owner.client.query(`insert into resources (id, tenant_id, resource_type, code, name) values (?, ?, 'bureau', 'BUR-12', 'Bureau 12')`, [
      BUREAU,
      DEFAULT_TENANT_ID,
    ])
  })

  after(async () => {
    await toutVider(bases.owner)
    await bases.owner.client.query('delete from tenants where id = ?', [AUTRE])
    delete (globalThis as { database?: unknown }).database
    await bases?.fermer()
  })

  it('un contrat en cours occupe sa ressource, du premier jour, dans le fuseau du centre', async () => {
    const outcome = await recoit()
    assert.equal(outcome.result, 'cree')
    const { contractId } = outcome as { contractId: string }
    const [ligne] = await contrats()
    assert.deepEqual([ligne!.reference, ligne!.status, ligne!.amount_cents, Boolean(ligne!.tacit_renewal)], ['CT2611-0003', 'active', 45000, false])
    const [occupation] = await occupations(contractId)
    assert.equal(occupation!.resource_id, BUREAU)
    assert.equal(occupation!.client_id, DURAND)
    assert.equal(occupation!.status, 'confirmed')
    // Le 1er novembre à minuit à Paris (heure d'hiver).
    assert.equal(occupation!.starts_at.toISOString(), '2026-10-31T23:00:00.000Z')

    assert.equal((await recoit()).result, 'inchange')
  })

  it('une résiliation raccourcit l’occupation ; le prix d’un contrat engagé suit le CRM, et lui seul', async () => {
    const { contractId } = (await recoit()) as { contractId: string }
    const resilie = await recoit({ statut: 'termine', fin: '2027-03-31', motifResiliation: 'Départ', prix: { montantHtCentimes: 47000, periodicite: 'mensuel' } })
    assert.equal(resilie.result, 'modifie')
    const [ligne] = await contrats()
    assert.deepEqual([ligne!.status, ligne!.terminated_on, ligne!.amount_cents], ['terminated', '2027-03-31', 47000])
    const [occupation] = await occupations(contractId)
    // Jusqu'au 31 mars compris : le 1er avril à minuit à Paris (heure d'été).
    assert.equal(occupation!.ends_at.toISOString(), '2027-03-31T22:00:00.000Z')

    // Hors du chemin du CRM, le prix d'un contrat engagé change toujours par avenant.
    await assert.rejects(
      bases.app.client.query('update contracts set amount_cents = 1 where id = ?', [contractId]),
      (error: unknown) => dbErrorCode(error) === 'CA004',
    )
  })

  it('refuse un contrat qui chevaucherait l’occupation d’un autre, sans rien écrire', async () => {
    await recoit()
    const second = await recoit({ dolibarrId: '58', reference: 'CT2611-0004', tiersDolibarrId: '413', debut: '2026-12-01' })
    assert.equal(second.result, 'refuse')
    assert.equal((second as { status: number }).status, 409)
    assert.match((second as { message: string }).message, /déjà occupée/)
    assert.equal((await contrats()).length, 1)
    assert.equal((await brut('select id from crm_links where entity = ?', ['contract'])).length, 1)
  })

  it('refuse un contrat dont le tiers n’est pas encore reçu, ou la ressource inconnue', async () => {
    const sansTiers = await recoit({ tiersDolibarrId: '999' })
    assert.deepEqual([sansTiers.result, (sansTiers as { status: number }).status], ['refuse', 409])
    assert.match((sansTiers as { message: string }).message, /POST \/api\/dolibarr\/tiers/)
    const ressource = await recoit({ ressource: 'BUR-99' })
    assert.deepEqual([ressource.result, (ressource as { status: number }).status], ['refuse', 400])
    assert.deepEqual(await contrats(), [])
  })

  it('une suppression archive le contrat et libère sa ressource', async () => {
    const { contractId } = (await recoit()) as { contractId: string }
    const retire = await receiveCrmContract('dolibarr', { removed: true, crmId: '57' })
    assert.equal(retire.result, 'retire')
    assert.ok((await contrats())[0]!.deleted_at)
    assert.equal((await occupations(contractId))[0]!.status, 'cancelled')
    assert.equal((await receiveCrmContract('dolibarr', { removed: true, crmId: '57' })).result, 'ignore')
  })

  it('reprend un contrat du site de même référence et même client, et arrête sa reconduction tacite', async () => {
    const existant = uuidv7()
    await bases.owner.client.query(
      `insert into contracts (id, tenant_id, client_id, reference, contract_type, status, starts_on, ends_on,
                              amount_cents, tacit_renewal, renewal_months)
       values (?, ?, ?, 'CT-2025-0007', 'domiciliation', 'active', '2025-01-01', '2026-12-31', 3000, true, 12)`,
      [existant, DEFAULT_TENANT_ID, DURAND],
    )
    const repris = await recoit({
      dolibarrId: '60',
      reference: 'CT-2025-0007',
      type: 'domiciliation',
      debut: '2025-01-01',
      fin: '2026-12-31',
      ressource: null,
      prix: { montantHtCentimes: 3000, periodicite: 'mensuel' },
    })
    assert.deepEqual([repris.result, (repris as { contractId: string }).contractId], ['rapproche', existant])
    assert.equal(Boolean((await contrats())[0]!.tacit_renewal), false)

    // Même référence, autre client : refusé.
    const autre = await recoit({ dolibarrId: '61', reference: 'CT-2025-0007', tiersDolibarrId: '413', ressource: null })
    assert.equal(autre.result, 'refuse')
  })

  it('sert chaque centre pour lui seul', async () => {
    await recoit()
    // À Lyon, le tiers 412 est inconnu : le contrat est refusé.
    const lyon = await runForTenant(AUTRE, () => recoit())
    assert.equal(lyon.result, 'refuse')
    assert.deepEqual(await runForTenant(AUTRE, () => listContractsForCrm('dolibarr', { limit: 100 })), [])

    const ici = await listContractsForCrm('dolibarr', { limit: 100 })
    assert.deepEqual(
      ici.map((c) => [c.reference, c.dolibarrId, c.tiers.dolibarrId, c.statut, c.ressource]),
      [['CT2611-0003', '57', '412', 'en_cours', 'BUR-12']],
    )
    assert.deepEqual(await listContractsForCrm('dolibarr', { linked: false, limit: 100 }), [])
  })
})
