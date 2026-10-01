import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import { createDatabase, withTenant } from '../../db/index.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { addDaysToIsoDate, todayIsoDate } from '../../lib/dates.ts'
import {
  ContractAlreadyStartedError,
  ContractOccupationConflictError,
  DuplicateReferenceError,
  activateContract,
  archiveContract,
  changeContractResource,
  createContract,
  findContract,
  findContractOccupation,
  listContracts,
  restoreContract,
  terminateContract,
  updateDraftContract,
  type ContractInput,
} from './queries.ts'

/**
 * Cycle de vie d'un contrat par les requêtes du module (R12, ADR 018 et 021) :
 * numérotation automatique, modification d'un brouillon, activation et
 * changement de ressource qui nomment le conflit d'occupation, archivage et
 * désarchivage.
 *
 * Éprouvé sous `app_centre`, par le code qu'utilisent les écrans.
 */
const ownerUrl = process.env.TEST_OWNER_DATABASE_URL ?? process.env.DATABASE_URL
const appUrl = process.env.TEST_DATABASE_URL

const raison = !appUrl
  ? 'TEST_DATABASE_URL non défini'
  : !ownerUrl
    ? 'TEST_OWNER_DATABASE_URL non défini'
    : false

/** Jour du centre (Paris), décalé de `days` : les règles datées s'y mesurent. */
const jour = (days: number) => addDaysToIsoDate(todayIsoDate('Europe/Paris'), days)

/** Année civile du centre (Paris) : celle que porte le numéro. */
const ANNEE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric' }).format(
  new Date(),
)

describe('cycle de vie d’un contrat', { skip: raison }, () => {
  // Les requêtes du module ouvrent leur propre connexion, par APP_DATABASE_URL.
  if (appUrl) process.env.APP_DATABASE_URL = appUrl

  const owner = createDatabase(ownerUrl ?? '', { onnotice: () => {} })
  const app = createDatabase(appUrl ?? '')

  const ACME = '01a00000-0000-7000-8000-0000000f0c01'
  const BETA = '01a00000-0000-7000-8000-0000000f0c02'
  const BUREAU = '01a00000-0000-7000-8000-0000000f0b01'
  const AUTRE_BUREAU = '01a00000-0000-7000-8000-0000000f0b02'

  const asTenant = <T>(run: Parameters<typeof withTenant<T>>[1]) =>
    withTenant(DEFAULT_TENANT_ID, run, app.db)

  const saisie = (overrides: Partial<ContractInput> = {}): ContractInput => ({
    clientId: ACME,
    contractType: 'bureau',
    billingPeriod: 'monthly',
    startsOn: '2026-03-01',
    endsOn: '2026-06-30',
    amountCents: 90_000,
    resourceId: BUREAU,
    ...overrides,
  })

  /** Contrat actif posé directement en base, comme une reprise. */
  const contratActif = async (
    reference: string,
    resourceId = BUREAU,
    overrides: Partial<ContractInput> = {},
  ) => {
    const created = await createContract(saisie({ reference, resourceId, ...overrides }))
    assert.ok(await activateContract(created.id))
    return created.id
  }

  /** Contrat actif qui commence dans un mois : sa ressource peut encore changer. */
  const contratAVenir = (reference: string, resourceId = BUREAU) =>
    contratActif(reference, resourceId, { startsOn: jour(30), endsOn: jour(120) })

  /** Occupations de contrat en base, toutes, annulées comprises. */
  const occupationsDeContrat = async (contractId: string): Promise<number> => {
    const [row] = await owner.client`
      select count(*)::int as n from bookings
       where contract_id = ${contractId} and kind = 'contract'`
    return row.n
  }

  const rejects = async <E>(run: () => Promise<unknown>, type: new (...args: never[]) => E) => {
    try {
      await run()
    } catch (error) {
      assert.ok(error instanceof type, `erreur inattendue : ${String(error)}`)
      return error as E
    }
    assert.fail('l’opération aurait dû échouer')
  }

  before(async () => {
    await migrate(owner.db, { migrationsFolder: './src/db/migrations' })
  })

  beforeEach(async () => {
    await owner.client`truncate table bookings, contracts, rate_plan_items, rate_plans, clients, resources cascade`
    await owner.client`truncate table document_sequences`
    await owner.client`delete from tenants where id <> ${DEFAULT_TENANT_ID}`
    await asTenant(async (tx) => {
      await tx.execute(sql`
        insert into clients (id, name) values (${ACME}, 'Acme SAS'), (${BETA}, 'Beta SARL')`)
      await tx.execute(sql`
        insert into resources (id, resource_type, code, name) values
          (${BUREAU}, 'bureau', 'BUR-01', 'Bureau 1'),
          (${AUTRE_BUREAU}, 'bureau', 'BUR-02', 'Bureau 2')`)
    })
  })

  after(async () => {
    const global = globalThis as { database?: { client: { end: () => Promise<void> } } }
    await Promise.all([owner.client.end(), app.client.end(), global.database?.client.end()])
  })

  describe('numérotation automatique', () => {
    it('numérote un contrat créé sans référence', async () => {
      const premier = await createContract(saisie())
      const second = await createContract(saisie({ resourceId: AUTRE_BUREAU }))
      assert.equal(premier.reference, `CT-${ANNEE}-0001`)
      assert.equal(second.reference, `CT-${ANNEE}-0002`)
    })

    it('garde une référence saisie à la main', async () => {
      const contrat = await createContract(saisie({ reference: 'DOM-2024-12' }))
      assert.equal(contrat.reference, 'DOM-2024-12')
    })

    it('refuse une référence manuelle déjà portée, en la nommant', async () => {
      await createContract(saisie({ reference: 'DOM-2024-12' }))
      const error = await rejects(
        () => createContract(saisie({ reference: 'DOM-2024-12' })),
        DuplicateReferenceError,
      )
      assert.equal(error.reference, 'DOM-2024-12')
    })

    it('saute un numéro déjà pris à la main', async () => {
      await createContract(saisie({ reference: `CT-${ANNEE}-0001` }))
      const contrat = await createContract(saisie())
      assert.equal(contrat.reference, `CT-${ANNEE}-0002`)
    })
  })

  describe('modification d’un brouillon', () => {
    it('modifie tous les champs d’un brouillon', async () => {
      const { id, reference } = await createContract(saisie())
      const updated = await updateDraftContract(id, {
        ...saisie({ clientId: BETA, resourceId: AUTRE_BUREAU, endsOn: null, amountCents: 120_000 }),
        reference,
        notes: 'Second étage',
      })
      assert.equal(updated, true)
      const contrat = await findContract(id)
      assert.equal(contrat?.clientId, BETA)
      assert.equal(contrat?.resourceId, AUTRE_BUREAU)
      assert.equal(contrat?.endsOn, null)
      assert.equal(contrat?.amountCents, 120_000)
      assert.equal(contrat?.notes, 'Second étage')
      assert.equal(contrat?.status, 'draft')
    })

    it('ne touche pas à un contrat actif', async () => {
      const id = await contratActif('BUR-A')
      const updated = await updateDraftContract(id, {
        ...saisie({ amountCents: 1 }),
        reference: 'BUR-A',
      })
      assert.equal(updated, false)
      assert.equal((await findContract(id))?.amountCents, 90_000)
    })

    it('ne touche pas à un brouillon archivé', async () => {
      const { id, reference } = await createContract(saisie())
      await archiveContract(id)
      assert.equal(await updateDraftContract(id, { ...saisie({ amountCents: 1 }), reference }), false)
    })

    it('refuse une référence déjà portée par un autre contrat', async () => {
      await createContract(saisie({ reference: 'DOM-1' }))
      const { id } = await createContract(saisie({ reference: 'DOM-2' }))
      await rejects(
        () => updateDraftContract(id, { ...saisie(), reference: 'DOM-1' }),
        DuplicateReferenceError,
      )
    })
  })

  describe('activation', () => {
    it('occupe la ressource sur la période du contrat', async () => {
      const id = await contratActif('BUR-A')
      const occupation = await findContractOccupation(id)
      assert.equal(occupation?.status, 'confirmed')
      assert.equal(occupation?.resourceId, BUREAU)
      assert.equal(occupation?.startsAt.toISOString(), '2026-02-28T23:00:00.000Z')
    })

    it('nomme le contrat qui occupe déjà la ressource, et laisse le brouillon', async () => {
      await contratActif('BUR-A')
      const { id } = await createContract(saisie({ reference: 'BUR-B', startsOn: '2026-05-01' }))

      const error = await rejects(() => activateContract(id), ContractOccupationConflictError)
      assert.equal(error.resourceId, BUREAU)
      assert.deepEqual(
        error.conflicts.map((conflict) => [conflict.kind, conflict.title]),
        [['contract', 'Contrat BUR-A']],
      )
      assert.equal((await findContract(id))?.status, 'draft')
      assert.equal(await findContractOccupation(id), undefined)
    })

    it('nomme la réservation horaire qui occupe la période', async () => {
      await asTenant((tx) =>
        tx.execute(sql`
          insert into bookings (resource_id, channel, starts_at, ends_at, title)
          values (${BUREAU}, 'staff', '2026-04-10T07:00:00Z', '2026-04-10T08:00:00Z', 'Rendez-vous')`),
      )
      const { id } = await createContract(saisie())
      const error = await rejects(() => activateContract(id), ContractOccupationConflictError)
      assert.deepEqual(
        error.conflicts.map((conflict) => conflict.title),
        ['Rendez-vous'],
      )
    })

    it('ne réactive pas un contrat qui n’est plus un brouillon', async () => {
      const id = await contratActif('BUR-A')
      assert.equal(await activateContract(id), false)
    })
  })

  describe('changement de ressource', () => {
    it('déplace l’occupation d’un contrat qui n’a pas commencé', async () => {
      const id = await contratAVenir('BUR-A')
      assert.equal(await changeContractResource(id, AUTRE_BUREAU), true)
      assert.equal((await findContractOccupation(id))?.resourceId, AUTRE_BUREAU)
    })

    it('nomme ce qui occupe la ressource demandée, et ne change rien', async () => {
      const id = await contratAVenir('BUR-A')
      await contratAVenir('BUR-B', AUTRE_BUREAU)

      const error = await rejects(
        () => changeContractResource(id, AUTRE_BUREAU),
        ContractOccupationConflictError,
      )
      assert.equal(error.resourceId, AUTRE_BUREAU)
      assert.deepEqual(
        error.conflicts.map((conflict) => conflict.title),
        ['Contrat BUR-B'],
      )
      assert.equal((await findContract(id))?.resourceId, BUREAU)
      assert.equal((await findContractOccupation(id))?.resourceId, BUREAU)
    })

    it('libère la ressource quand on la retire', async () => {
      const id = await contratAVenir('BUR-A')
      assert.equal(await changeContractResource(id, null), true)
      const occupation = await findContractOccupation(id)
      assert.equal(occupation?.status, 'cancelled')
      assert.equal(occupation?.cancellationReason, 'Ressource retirée du contrat')
    })

    it('refuse un contrat commencé, même vers une ressource occupée seulement dans le passé', async () => {
      // Le bureau 2 a servi il y a cent jours : réécrire l'occupation depuis le
      // début du contrat heurterait ce rendez-vous. Le refus le dit avant la
      // base, sans citer une réservation ancienne.
      const passe = jour(-100)
      await asTenant((tx) =>
        tx.execute(sql`
          insert into bookings (resource_id, channel, starts_at, ends_at, title)
          values (${AUTRE_BUREAU}, 'staff', ${`${passe}T07:00:00Z`}::timestamptz,
                  ${`${passe}T08:00:00Z`}::timestamptz, 'Rendez-vous passé')`),
      )
      const id = await contratActif('BUR-A', BUREAU, { startsOn: jour(-200), endsOn: null })
      const avant = await findContractOccupation(id)

      const error = await rejects(
        () => changeContractResource(id, AUTRE_BUREAU),
        ContractAlreadyStartedError,
      )
      assert.equal(error.startsOn, jour(-200))
      assert.match(
        error.message,
        /^Ce contrat a commencé le \d{2}\/\d{2}\/\d{4} : sa ressource ne change plus ici\./,
      )
      // Après le début, le changement passe par un avenant (ADR 025).
      assert.match(error.message, /établissez un avenant de changement de ressource/)
      assert.doesNotMatch(error.message, /Rendez-vous passé/)

      // Rien n'a bougé : ni le contrat, ni son occupation depuis le premier jour.
      assert.equal((await findContract(id))?.resourceId, BUREAU)
      const apres = await findContractOccupation(id)
      assert.equal(apres?.resourceId, BUREAU)
      assert.equal(apres?.status, 'confirmed')
      assert.equal(apres?.startsAt.getTime(), avant?.startsAt.getTime())
    })

    it('refuse aussi de retirer la ressource d’un contrat commencé', async () => {
      const id = await contratActif('BUR-A', BUREAU, { startsOn: jour(-10), endsOn: jour(50) })
      await rejects(() => changeContractResource(id, null), ContractAlreadyStartedError)
      assert.equal((await findContractOccupation(id))?.status, 'confirmed')
    })

    it('refuse le jour même du début, jour du centre', async () => {
      const id = await contratActif('BUR-A', BUREAU, { startsOn: jour(0), endsOn: jour(60) })
      await rejects(() => changeContractResource(id, AUTRE_BUREAU), ContractAlreadyStartedError)
    })

    it('ne change pas la ressource d’un brouillon par ce chemin', async () => {
      const { id } = await createContract(saisie({ startsOn: jour(30), endsOn: jour(120) }))
      assert.equal(await changeContractResource(id, AUTRE_BUREAU), false)
      assert.equal((await findContract(id))?.resourceId, BUREAU)
    })

    it('ne change pas la ressource d’un contrat résilié', async () => {
      const id = await contratAVenir('BUR-A')
      assert.equal(await terminateContract(id, jour(60)), true)
      assert.equal(await changeContractResource(id, AUTRE_BUREAU), false)
      assert.equal((await findContractOccupation(id))?.resourceId, BUREAU)
    })
  })

  describe('archivage', () => {
    it('archive sans supprimer, et libère la ressource', async () => {
      const id = await contratActif('BUR-A')
      assert.equal(await archiveContract(id), true)

      const contrat = await findContract(id)
      assert.ok(contrat?.deletedAt instanceof Date)
      const occupation = await findContractOccupation(id)
      assert.equal(occupation?.status, 'cancelled')
      assert.equal(occupation?.cancellationReason, 'Contrat archivé')

      // La ressource est libre : un autre contrat peut s'y activer.
      await contratActif('BUR-B')
    })

    it('ne réarchive pas un contrat archivé', async () => {
      const { id } = await createContract(saisie())
      assert.equal(await archiveContract(id), true)
      assert.equal(await archiveContract(id), false)
    })

    it('sort le contrat de la liste, sauf filtre des archivés', async () => {
      const gardé = await createContract(saisie({ reference: 'GARDE' }))
      const archivé = await createContract(saisie({ reference: 'ARCHIVE', resourceId: null }))
      await archiveContract(archivé.id)

      assert.deepEqual(
        (await listContracts()).map((contract) => contract.id),
        [gardé.id],
      )
      assert.deepEqual(
        (await listContracts({ archived: true })).map((contract) => contract.id),
        [archivé.id],
      )
      assert.deepEqual(
        (await listContracts({ clientId: ACME, status: 'draft', archived: true })).map(
          (contract) => contract.id,
        ),
        [archivé.id],
      )
    })

    it('garde le numéro d’un brouillon archivé', async () => {
      const { id, reference } = await createContract(saisie())
      await archiveContract(id)
      const suivant = await createContract(saisie())
      assert.notEqual(suivant.reference, reference)
    })
  })

  describe('désarchivage', () => {
    it('rétablit le contrat et son occupation', async () => {
      const id = await contratActif('BUR-A')
      await archiveContract(id)
      assert.equal(await restoreContract(id), true)
      assert.equal((await findContract(id))?.deletedAt, null)
      assert.equal((await findContractOccupation(id))?.status, 'confirmed')
    })

    it('nomme ce qui a pris la ressource entre-temps', async () => {
      const id = await contratActif('BUR-A')
      await archiveContract(id)
      await contratActif('BUR-B')

      const error = await rejects(() => restoreContract(id), ContractOccupationConflictError)
      assert.deepEqual(
        error.conflicts.map((conflict) => conflict.title),
        ['Contrat BUR-B'],
      )
      assert.ok((await findContract(id))?.deletedAt instanceof Date)
    })

    it('refuse si la référence a été reprise par un autre contrat', async () => {
      const { id } = await createContract(saisie({ reference: 'DOM-1', resourceId: null }))
      await archiveContract(id)
      await createContract(saisie({ reference: 'DOM-1', resourceId: null }))
      await rejects(() => restoreContract(id), DuplicateReferenceError)
    })
  })

  describe('résiliation', () => {
    it('tronque l’occupation au soir du dernier jour', async () => {
      const id = await contratActif('BUR-A')
      assert.equal(await terminateContract(id, '2026-04-15', 'Départ'), true)
      const occupation = await findContractOccupation(id)
      assert.equal(occupation?.endsAt.toISOString(), '2026-04-15T22:00:00.000Z')
    })

    it('refuse un brouillon, qui n’occupe alors rien', async () => {
      // Un brouillon résilié remplirait le prédicat d'occupation (`terminated`)
      // et bloquerait le bureau jusqu'à la date de résiliation (ADR 018).
      const { id } = await createContract(saisie({ startsOn: jour(-30), endsOn: null }))
      assert.equal(await terminateContract(id, jour(90), 'Abandon'), false)

      const contrat = await findContract(id)
      assert.equal(contrat?.status, 'draft')
      assert.equal(contrat?.terminatedOn, null)
      assert.equal(await occupationsDeContrat(id), 0)

      // Le bureau reste libre : un autre contrat s'y active sur la même période.
      await contratActif('BUR-B', BUREAU, { startsOn: jour(-30), endsOn: null })
    })

    it('refuse un contrat archivé, sans rétablir son occupation', async () => {
      const id = await contratActif('BUR-A')
      await archiveContract(id)
      assert.equal(await terminateContract(id, '2026-04-15'), false)

      const contrat = await findContract(id)
      assert.equal(contrat?.status, 'active')
      assert.equal(contrat?.terminatedOn, null)
      assert.equal((await findContractOccupation(id))?.status, 'cancelled')
    })

    it('ne résilie pas deux fois', async () => {
      const id = await contratActif('BUR-A')
      assert.equal(await terminateContract(id, '2026-04-15'), true)
      assert.equal(await terminateContract(id, '2026-05-15'), false)
      assert.equal((await findContract(id))?.terminatedOn, '2026-04-15')
    })
  })
})
