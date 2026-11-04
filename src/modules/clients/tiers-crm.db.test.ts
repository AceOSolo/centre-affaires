import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { ouvrirBasesDeTest, raisonDeSaut, type TestDatabases } from '../../db/test-support.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { runForTenant } from '../../lib/tenant.ts'
import { uuidv7 } from '../../lib/uuid.ts'
import { toutVider } from './test-support.ts'
import { readThirdParty, type ReceivedThirdParty } from './tiers-crm.ts'
import { listThirdPartiesForCrm, receiveThirdParty, type ThirdPartyOutcome } from './tiers-crm-queries.ts'

/**
 * Tiers reçus de Dolibarr, en base (ADR 066), sous l'identité applicative :
 * création, rapprochement (lien, fiche désignée, SIRET, SIREN), aucun
 * doublon, contacts, suppression, fiche anonymisée, et chaque centre pour
 * lui seul.
 */
describe('tiers du CRM, en base', { skip: raisonDeSaut }, () => {
  const AUTRE = '01999f00-0000-7000-8000-0000000000e8'
  let bases: TestDatabases

  const brut = async <T>(requete: string, params: unknown[] = []) =>
    ((await bases.owner.client.query(requete, params)) as unknown as [T[]])[0]

  const tiers = (overrides: Record<string, unknown> = {}): ReceivedThirdParty => {
    const read = readThirdParty({
      dolibarrId: '412',
      statut: 'client',
      nom: 'Atelier Martin',
      siret: '12345678900012',
      email: 'contact@atelier-martin.exemple.fr',
      adresse: { ligne1: '3 rue des Lilas', codePostal: '69002', ville: 'Lyon', pays: 'FR' },
      ...overrides,
    })
    assert.ok(read.ok, read.ok ? undefined : read.message)
    return read.value
  }
  const recoit = (overrides: Record<string, unknown> = {}) => receiveThirdParty('dolibarr', tiers(overrides))
  const resultat = (outcome: ThirdPartyOutcome) => outcome.result

  const fiche = async (values: { name: string; siret?: string | null; tenant?: string }) => {
    const id = uuidv7()
    await bases.owner.client.query('insert into clients (id, tenant_id, name, siret, status) values (?, ?, ?, ?, ?)', [
      id,
      values.tenant ?? DEFAULT_TENANT_ID,
      values.name,
      values.siret ?? null,
      'active',
    ])
    return id
  }

  const clientsDuCentre = (tenant = DEFAULT_TENANT_ID) =>
    brut<{ id: string; name: string; siret: string | null; city: string | null; status: string }>(
      'select id, name, siret, city, status from clients where tenant_id = ? order by created_at, id',
      [tenant],
    )
  const liens = (entity = 'client') =>
    brut<{ tenant_id: string; local_id: string; external_id: string; removed_at: Date | null }>(
      'select tenant_id, local_id, external_id, removed_at from crm_links where entity = ? order by created_at, id',
      [entity],
    )

  before(async () => {
    bases = await ouvrirBasesDeTest()
    ;(globalThis as { database?: unknown }).database = bases.app
  })

  beforeEach(async () => {
    await toutVider(bases.owner)
    await bases.owner.client.query('delete from tenants where id = ?', [AUTRE])
    await bases.owner.client.query(`insert into tenants (id, name, slug) values (?, 'Centre de Lyon', 'centre-de-lyon-tiers')`, [AUTRE])
  })

  after(async () => {
    await toutVider(bases.owner)
    await bases.owner.client.query('delete from tenants where id = ?', [AUTRE])
    delete (globalThis as { database?: unknown }).database
    await bases?.fermer()
  })

  it('crée la fiche d’un client inconnu, puis la tient à jour sous son identifiant, sans doublon', async () => {
    const cree = await recoit({ reference: 'CU2611-0042' })
    assert.equal(cree.result, 'cree')
    const [client] = await clientsDuCentre()
    assert.equal(client!.name, 'Atelier Martin')
    assert.equal(client!.status, 'active')
    assert.deepEqual((await liens()).map((l) => [l.local_id, l.external_id]), [[client!.id, '412']])

    assert.equal(resultat(await recoit({ reference: 'CU2611-0042' })), 'inchange')
    const modifie = await recoit({ adresse: { ville: 'Villeurbanne' }, statut: 'ferme' })
    assert.equal(modifie.result, 'modifie')
    const [apres] = await clientsDuCentre()
    assert.equal(apres!.city, 'Villeurbanne')
    assert.equal(apres!.status, 'inactive')
    assert.equal((await clientsDuCentre()).length, 1)
  })

  it('rapproche une fiche du site au même SIRET, puis au même SIREN, et reprend ce que le CRM en tient', async () => {
    const existante = await fiche({ name: 'ATELIER MARTIN SARL', siret: '12345678900012' })
    const rapproche = await recoit()
    assert.deepEqual([rapproche.result, (rapproche as { clientId: string }).clientId], ['rapproche', existante])
    assert.equal((await clientsDuCentre())[0]!.name, 'Atelier Martin')

    const autreEtablissement = await fiche({ name: 'Boulangerie Petit', siret: '98765432100011' })
    const parSiren = await recoit({ dolibarrId: '413', nom: 'Boulangerie Petit SAS', siret: '98765432100029' })
    assert.deepEqual([parSiren.result, (parSiren as { clientId: string }).clientId], ['rapproche', autreEtablissement])
  })

  it('suit la fiche que le CRM désigne, et ne relie jamais une fiche à deux tiers', async () => {
    const existante = await fiche({ name: 'Studio Nord' })
    const designe = await recoit({ dolibarrId: '500', nom: 'Studio Nord', siret: null, clientId: existante })
    assert.equal(designe.result, 'rapproche')
    const doublon = await recoit({ dolibarrId: '501', nom: 'Studio Nord bis', siret: null, clientId: existante })
    assert.equal(doublon.result, 'refuse')
    assert.equal((doublon as { status: number }).status, 409)
    const inconnue = await recoit({ dolibarrId: '502', siret: null, clientId: uuidv7() })
    assert.equal((inconnue as { status: number }).status, 404)
  })

  it('ne devine pas : deux fiches au même SIREN, ou un SIRET déjà porté par une autre fiche', async () => {
    await fiche({ name: 'Groupe Alpha Lyon', siret: '11122233300011' })
    await fiche({ name: 'Groupe Alpha Paris', siret: '11122233300029' })
    const ambigu = await recoit({ dolibarrId: '600', nom: 'Groupe Alpha', siret: '11122233300037' })
    assert.equal(ambigu.result, 'refuse')
    assert.match((ambigu as { message: string }).message, /clientId/)

    const autre = await fiche({ name: 'Cabinet Beta', siret: '44455566600011' })
    await recoit({ dolibarrId: '700', nom: 'Cabinet Beta', siret: '44455566600011' })
    // Un second tiers du CRM pour la même entreprise : refusé, pas fusionné.
    const second = await recoit({ dolibarrId: '701', nom: 'Cabinet Beta (doublon)', siret: '44455566600011' })
    assert.equal(second.result, 'refuse')
    assert.match((second as { message: string }).message, new RegExp(autre))
    assert.equal((await clientsDuCentre()).length, 3)
  })

  it('ne crée pas de fiche pour un prospect, mais met à jour celle qui existe', async () => {
    const prospect = await recoit({ dolibarrId: '800', nom: 'Prospect Gamma', siret: null, statut: 'prospect' })
    assert.equal(prospect.result, 'ignore')
    assert.deepEqual(await clientsDuCentre(), [])
  })

  it('remplace les contacts reçus du CRM, sans toucher à ceux saisis sur le site', async () => {
    const { clientId } = (await recoit({
      contacts: [
        { dolibarrId: '88', nom: 'Camille Dupont', fonction: 'Gérante', facturation: true },
        { dolibarrId: '89', nom: 'Sam Leroy' },
      ],
    })) as { clientId: string }
    await bases.owner.client.query('insert into client_contacts (id, tenant_id, client_id, full_name) values (?, ?, ?, ?)', [
      uuidv7(),
      DEFAULT_TENANT_ID,
      clientId,
      'Contact saisi à l’accueil',
    ])

    const apres = await recoit({ contacts: [{ dolibarrId: '88', nom: 'Camille Dupont-Martin', fonction: 'Gérante' }, { dolibarrId: '90', nom: 'Lou Bernard' }] })
    assert.equal(apres.result, 'modifie')
    const contacts = await brut<{ full_name: string; is_billing: number; deleted_at: Date | null }>(
      'select full_name, is_billing, deleted_at from client_contacts where client_id = ? order by full_name',
      [clientId],
    )
    assert.deepEqual(
      contacts.map((c) => [c.full_name, Boolean(c.is_billing), c.deleted_at !== null]),
      [
        ['Camille Dupont-Martin', false, false],
        ['Contact saisi à l’accueil', false, false],
        ['Lou Bernard', false, false],
        ['Sam Leroy', false, true],
      ],
    )
    // Sans liste, les contacts ne bougent pas.
    assert.equal(resultat(await recoit({ nom: 'Atelier Martin' })), 'inchange')
  })

  it('une suppression dans le CRM retire le lien, jamais la fiche ; le tiers qui revient la retrouve', async () => {
    const { clientId } = (await recoit()) as { clientId: string }
    const retire = await receiveThirdParty('dolibarr', { removed: true, crmId: '412', crmRef: null })
    assert.equal(retire.result, 'retire')
    assert.equal((await clientsDuCentre()).length, 1)
    assert.ok((await liens())[0]!.removed_at)

    const revient = await recoit()
    assert.deepEqual([revient.result, (revient as { clientId: string }).clientId], ['rapproche', clientId])
    assert.equal((await liens()).length, 1)
    assert.equal((await liens())[0]!.removed_at, null)
  })

  it('ne met plus à jour une fiche anonymisée', async () => {
    const { clientId } = (await recoit()) as { clientId: string }
    // Comme le fait `anonymize_client()` : sous `@app_anonymization` (ADR 040).
    const connection = await bases.owner.client.getConnection()
    try {
      await connection.query("set @app_anonymization = 'on'")
      await connection.query(
        `update clients set deleted_at = current_timestamp(3), anonymized_at = current_timestamp(3),
                anonymization_basis = 'retention', name = 'Client anonymisé', siret = null, email = null where id = ?`,
        [clientId],
      )
    } finally {
      await connection.query('set @app_anonymization = null').catch(() => {})
      connection.release()
    }
    const outcome = await recoit({ adresse: { ville: 'Paris' } })
    assert.equal(outcome.result, 'ignore')
    assert.match((outcome as { message: string }).message, /anonymisée/)
  })

  it('sert chaque centre pour lui seul : le même identifiant fait deux fiches dans deux centres', async () => {
    await recoit()
    const lyon = await runForTenant(AUTRE, () => recoit())
    assert.equal(lyon.result, 'cree')
    assert.equal((await clientsDuCentre()).length, 1)
    assert.equal((await clientsDuCentre(AUTRE)).length, 1)
    assert.deepEqual((await liens()).map((l) => l.tenant_id).sort(), [AUTRE, DEFAULT_TENANT_ID].sort())

    const ici = await listThirdPartiesForCrm('dolibarr', { limit: 100 })
    assert.deepEqual(ici.map((t) => [t.nom, t.dolibarrId, t.statut]), [['Atelier Martin', '412', 'client']])
  })

  it('liste les fiches à rapprocher, et celles qui le sont', async () => {
    await recoit()
    const seule = await fiche({ name: 'Fiche sans tiers' })
    assert.deepEqual((await listThirdPartiesForCrm('dolibarr', { linked: false, limit: 100 })).map((t) => t.clientId), [seule])
    assert.deepEqual((await listThirdPartiesForCrm('dolibarr', { linked: true, limit: 100 })).map((t) => t.dolibarrId), ['412'])
  })
})
