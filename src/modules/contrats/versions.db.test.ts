import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'

import { withTenant } from '../../db/index.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { ouvrirBasesDeTest, raisonDeSaut, viderTables, type TestDatabases } from '../../db/test-support.ts'
import {
  AmendmentRefusedError,
  abandonAmendment,
  createAmendment,
  findAmendment,
  listAmendments,
  signAmendment,
  updateDraftAmendment,
  type AmendmentInput,
} from './avenants.ts'
import {
  establishContractDocument,
  findContractDocument,
  listContractDocuments,
  previewContractSnapshot,
} from './documents.ts'
import { contractSchedule } from './echeancier.ts'
import type { LineDraft } from './lignes.ts'
import { ContractLinesRefusedError, saveDraftContractLines } from './lignes-queries.ts'
import { proposeContractFromOffer } from './offres.ts'
import {
  createContractFromOffer,
  findOfferForContract,
  listCatalogRates,
  listOffersForContract,
} from './offres-queries.ts'
import {
  ContractClientLockedError,
  ContractOccupationConflictError,
  activateContract,
  archiveContract,
  createContract,
  findContract,
  restoreContract,
  terminateContract,
  updateDraftContract,
  type ContractInput,
} from './queries.ts'
import { findContractTerms, listCurrentTerms, scheduleVersions, segmentOn } from './versions.ts'

/**
 * Contrats versionnés par les requêtes des écrans (R09, R12, ADR 024 et 025) :
 * contrat tiré d'une offre, lignes d'un brouillon, avenants de prix et de
 * ressource, échéancier versionné au jour d'effet, documents archivés à
 * l'activation et à la signature, avec leur empreinte.
 *
 * Les règles tenues par la base sont éprouvées par `avenants.db.test.ts` ;
 * celui-ci éprouve le code qu'utilisent les écrans, sous l'identité applicative.
 */
const TABLES = [
  'bookings',
  'contract_documents',
  'contract_amendments',
  'contract_lines',
  'contract_renewals',
  'contracts',
  'subscribed_services',
  'offer_items',
  'offer_requests',
  'rate_plan_items',
  'rate_plans',
  'clients',
  'resources',
  'services',
  'offers',
  'staff_members',
  'document_sequences',
]

describe('contrats versionnés, par les écrans', { skip: raisonDeSaut }, () => {
  let bases: TestDatabases

  const ACME = '01a00000-0000-7000-8000-0000000e0c01'
  const BETA = '01a00000-0000-7000-8000-0000000e0c02'
  const BUREAU = '01a00000-0000-7000-8000-0000000e0b01'
  const AUTRE_BUREAU = '01a00000-0000-7000-8000-0000000e0b02'
  const BAL = '01a00000-0000-7000-8000-0000000e0b03'
  const STANDARD = '01a00000-0000-7000-8000-0000000e0e01'
  const NUMERISATION = '01a00000-0000-7000-8000-0000000e0e02'
  const OFFRE = '01a00000-0000-7000-8000-0000000e0f01'
  const EXPLOITANT = '01a00000-0000-7000-8000-0000000e0d01'

  const asTenant = <T>(run: Parameters<typeof withTenant<T>>[1]) =>
    withTenant(DEFAULT_TENANT_ID, run, bases.app.db)

  const saisie = (overrides: Partial<ContractInput> = {}): ContractInput => ({
    clientId: ACME,
    contractType: 'bureau',
    billingPeriod: 'monthly',
    startsOn: '2026-03-01',
    amountCents: 90_000,
    resourceId: BUREAU,
    ...overrides,
  })

  const ligne = (overrides: Partial<LineDraft> = {}): LineDraft => ({
    offerItemId: null,
    target: { kind: 'resource', resourceId: BUREAU },
    description: 'Bureau 1',
    quantity: 1,
    unit: 'month',
    unitPriceCents: 90_000,
    discountBp: null,
    discountAmountCents: null,
    vatRateBp: 2000,
    isRecurring: true,
    ...overrides,
  })

  const avenant = (overrides: Partial<AmendmentInput> = {}): AmendmentInput => ({
    effectiveOn: '2026-06-15',
    reason: 'Indexation',
    priceMode: 'unchanged',
    amountCents: null,
    lines: [],
    changesResource: false,
    resourceId: null,
    ...overrides,
  })

  /** Contrat actif du 1er mars, sans terme, avec une ligne de bureau à 900 €. */
  const contratActif = async (overrides: Partial<ContractInput> = {}) => {
    const created = await createContract(saisie(overrides))
    assert.ok(await saveDraftContractLines(created.id, [ligne()]))
    assert.ok(await activateContract(created.id, EXPLOITANT))
    return created.id
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

  const souscriptions = async (contractId: string) => {
    const [rows] = (await bases.owner.client.query(
      `select service_id, included_quantity, unit_price_cents, discount_bp,
              cast(starts_on as char) as starts_on, cast(ends_on as char) as ends_on,
              deleted_at is not null as archived
         from subscribed_services where contract_id = ? order by created_at, id`,
      [contractId],
    )) as unknown as [
      {
        service_id: string
        included_quantity: number | null
        unit_price_cents: number
        discount_bp: number | null
        starts_on: string
        ends_on: string | null
        archived: number
      }[],
    ]
    return rows.map((row) => ({
      service_id: row.service_id,
      included_quantity: row.included_quantity,
      unit_price_cents: row.unit_price_cents,
      discount_bp: row.discount_bp,
      starts_on: row.starts_on,
      ends_on: row.ends_on,
      archived: Boolean(row.archived),
    }))
  }

  before(async () => {
    bases = await ouvrirBasesDeTest()
    // Les requêtes du module passent par la base du processus : on lui donne
    // celle des tests.
    ;(globalThis as { database?: unknown }).database = bases.app
  })

  beforeEach(async () => {
    await viderTables(bases.owner, ...TABLES)
    await bases.owner.client.query('delete from tenants where id <> ?', [DEFAULT_TENANT_ID])
    await asTenant(async (tx) => {
      await tx.execute(sql`insert into staff_members (id, email, full_name, role)
        values (${EXPLOITANT}, 'exploitant@centre.fr', 'Camille Exploitante', 'admin')`)
      await tx.execute(sql`
        insert into clients (id, name, siret, address_line1, postal_code, city)
        values (${ACME}, 'Acme SAS', '98765432100011', '2 avenue du Client', '69001', 'Lyon'),
               (${BETA}, 'Beta SARL', null, null, null, null)`)
      await tx.execute(sql`
        insert into resources (id, resource_type, code, name) values
          (${BUREAU}, 'bureau', 'BUR-E1', 'Bureau 1'),
          (${AUTRE_BUREAU}, 'bureau', 'BUR-E2', 'Bureau 2'),
          (${BAL}, 'boite_aux_lettres', 'BAL-E1', 'Boîte 1')`)
    })
  })

  after(async () => {
    await viderTables(bases.owner, ...TABLES)
    delete (globalThis as { database?: unknown }).database
    await bases.fermer()
  })

  describe('contrat tiré d’une offre (R09)', () => {
    /** Offre : un bureau précis, deux postes de coworking remisés, le standard, dix numérisations. */
    const poserOffre = () =>
      asTenant(async (tx) => {
        await tx.execute(sql`
          insert into services (id, code, name, nature, unit, unit_price_cents) values
            (${STANDARD}, null, 'Standard téléphonique', 'package', 'month', 5000),
            (${NUMERISATION}, 'courrier.ouverture', 'Numérisation', 'act', 'unit', 150)`)
        await tx.execute(sql`
          insert into rate_plans (id, name, is_default) values
            ('01a00000-0000-7000-8000-0000000e0a01', 'Grille 2026', true)`)
        await tx.execute(sql`
          insert into rate_plan_items (rate_plan_id, resource_type, resource_id, unit, amount_cents) values
            ('01a00000-0000-7000-8000-0000000e0a01', 'bureau', null, 'month', 15000),
            ('01a00000-0000-7000-8000-0000000e0a01', 'bureau', ${BUREAU}, 'month', 90000)`)
        await tx.execute(sql`
          insert into offers (id, name, billing_period, commitment_months)
          values (${OFFRE}, 'Bureau Premium', 'monthly', 12)`)
        await tx.execute(sql`
          insert into offer_items (offer_id, resource_id, resource_type, service_id, quantity, unit,
                                   price_cents, discount_bp, position) values
            (${OFFRE}, ${BUREAU}, null, null, 1, 'month', null, null, 0),
            (${OFFRE}, null, 'bureau', null, 2, 'month', null, 1000, 1),
            (${OFFRE}, null, null, ${STANDARD}, 1, 'month', null, null, 2),
            (${OFFRE}, null, null, ${NUMERISATION}, 10, 'month', null, null, 3)`)
      })

    const tirer = async () => {
      const offer = await findOfferForContract(OFFRE)
      assert.ok(offer)
      const proposal = proposeContractFromOffer(offer, {
        rates: await listCatalogRates('2026-03-01'),
        defaultVatRateBp: 2000,
      })
      return {
        proposal,
        contract: await createContractFromOffer({
          contract: {
            ...saisie({ contractType: proposal.contractType, resourceId: proposal.resourceId }),
            amountCents: 0,
            billingPeriod: proposal.billingPeriod,
            commitmentMonths: proposal.commitmentMonths,
            offerId: OFFRE,
          },
          lines: proposal.lines,
          subscriptions: proposal.subscriptions,
        }),
      }
    }

    it('crée le brouillon, ses lignes tracées, son montant et l’acte inclus souscrit', async () => {
      await poserOffre()
      assert.deepEqual(
        (await listOffersForContract()).map((offer) => [offer.name, offer.itemCount]),
        [['Bureau Premium', 4]],
      )
      const { contract } = await tirer()
      assert.equal(contract.status, 'draft')
      assert.equal(contract.offerId, OFFRE)
      assert.equal(contract.commitmentMonths, 12)
      assert.equal(contract.commitmentEndsOn, '2027-02-28')
      // 900 + 2 × 150 − 10 % + 50 : la base tient le montant égal aux lignes.
      assert.equal(contract.amountCents, 90_000 + 27_000 + 5_000)

      const { versions } = await findContractTerms(contract.id)
      assert.equal(versions.length, 1)
      assert.deepEqual(
        versions[0].lines.map((line) => [line.targetLabel, line.netAmountCents, line.offerItemId !== null]),
        [
          ['Bureau 1 (BUR-E1)', 90_000, true],
          ['Bureau', 27_000, true],
          ['Standard téléphonique', 5_000, true],
        ],
      )
      assert.deepEqual(await souscriptions(contract.id), [
        {
          service_id: NUMERISATION,
          included_quantity: 10,
          unit_price_cents: 150,
          discount_bp: null,
          starts_on: '2026-03-01',
          ends_on: null,
          archived: false,
        },
      ])
    })

    it('fait suivre aux actes inclus les dates du brouillon, et garde son client', async () => {
      await poserOffre()
      const { contract } = await tirer()
      const modifie = { ...saisie({ startsOn: '2026-04-01', endsOn: '2027-03-31' }), reference: contract.reference }
      assert.ok(await updateDraftContract(contract.id, modifie))
      const [ancienne, nouvelle] = await souscriptions(contract.id)
      assert.equal(ancienne.archived, true)
      assert.deepEqual([nouvelle.starts_on, nouvelle.ends_on, nouvelle.archived, nouvelle.included_quantity], [
        '2026-04-01',
        '2027-03-31',
        false,
        10,
      ])
      // La fin seule se corrige en place.
      assert.ok(await updateDraftContract(contract.id, { ...modifie, endsOn: '2027-06-30' }))
      assert.equal((await souscriptions(contract.id)).length, 2)
      assert.equal((await souscriptions(contract.id))[1].ends_on, '2027-06-30')

      await rejects(
        () => updateDraftContract(contract.id, { ...modifie, clientId: BETA }),
        ContractClientLockedError,
      )
    })

    it('termine, archive et rétablit les actes inclus avec le contrat', async () => {
      await poserOffre()
      const { contract } = await tirer()
      assert.ok(await activateContract(contract.id, EXPLOITANT))
      assert.ok(await archiveContract(contract.id))
      assert.equal((await souscriptions(contract.id))[0].archived, true)
      assert.ok(await restoreContract(contract.id))
      assert.equal((await souscriptions(contract.id))[0].archived, false)
      assert.ok(await terminateContract(contract.id, '2026-09-30'))
      assert.equal((await souscriptions(contract.id))[0].ends_on, '2026-09-30')
    })
  })

  describe('lignes d’un brouillon', () => {
    it('font le montant du contrat, se modifient et se retirent tant qu’il est brouillon', async () => {
      const created = await createContract(saisie({ amountCents: 0 }))
      assert.ok(
        await saveDraftContractLines(created.id, [
          ligne({ unitPriceCents: 80_000 }),
          ligne({ target: { kind: 'type', resourceType: 'bureau' }, description: 'Postes', quantity: 2, unitPriceCents: 15_000 }),
          ligne({ target: { kind: 'none' }, description: 'Frais de dossier', unit: 'unit', unitPriceCents: 5_000, isRecurring: false }),
        ]),
      )
      assert.equal((await findContract(created.id))?.amountCents, 110_000)

      const { versions } = await findContractTerms(created.id)
      const [bureau, , frais] = versions[0].lines
      // Le bureau change de prix, les postes sont retirés, les frais restent.
      assert.ok(
        await saveDraftContractLines(created.id, [
          { ...ligne({ unitPriceCents: 85_000 }), id: bureau.id },
          { ...ligne({ target: { kind: 'none' }, description: 'Frais de dossier', unit: 'unit', unitPriceCents: 5_000, isRecurring: false }), id: frais.id },
        ]),
      )
      assert.equal((await findContract(created.id))?.amountCents, 85_000)
      const [rows] = (await bases.owner.client.query(
        'select count(*) as n from contract_lines where contract_id = ? and deleted_at is not null',
        [created.id],
      )) as unknown as [{ n: number | string }[]]
      assert.equal(Number(rows[0].n), 1)

      assert.ok(await activateContract(created.id, EXPLOITANT))
      assert.equal(await saveDraftContractLines(created.id, [ligne()]), false)
    })

    it('refuse une ligne qui vise une ressource inconnue', async () => {
      const created = await createContract(saisie())
      await rejects(
        () =>
          saveDraftContractLines(created.id, [
            ligne({ target: { kind: 'resource', resourceId: '01a00000-0000-7000-8000-0000000e0bff' } }),
          ]),
        ContractLinesRefusedError,
      )
    })
  })

  describe('documents archivés (ADR 025)', () => {
    it('archive le document à l’activation, avec son empreinte vérifiable', async () => {
      const id = await contratActif()
      const [document] = await listContractDocuments(id)
      assert.equal(document.version, 1)
      assert.equal(document.amendmentId, null)
      assert.equal(document.generatedBy, 'Camille Exploitante')

      // Forme canonique du `json` de MySQL, sur laquelle la base calcule l'empreinte.
      const [rows] = (await bases.owner.client.query(
        `select cast(snapshot as char character set utf8mb4) as texte, sha256 as empreinte
           from contract_documents where contract_id = ?`,
        [id],
      )) as unknown as [{ texte: string; empreinte: string }[]]
      const { texte, empreinte } = rows[0]
      assert.equal(empreinte, createHash('sha256').update(texte, 'utf8').digest('hex'))

      const archived = await findContractDocument(id, 1)
      assert.ok(archived?.intact)
      assert.equal(archived?.snapshot?.kind, 'contract')
      assert.equal(archived?.snapshot?.buyer.name, 'Acme SAS')
      assert.equal(archived?.snapshot?.price.amountCents, 90_000)
      assert.equal(archived?.snapshot?.resource?.code, 'BUR-E1')
    })

    it('rend le document tel qu’il était, même après un avenant et un changement de client', async () => {
      const id = await contratActif()
      await asTenant((tx) => tx.execute(sql`update clients set name = 'Acme Groupe' where id = ${ACME}`))
      const amendment = await createAmendment(id, avenant({ priceMode: 'amount', amountCents: 95_000 }))
      assert.ok(await signAmendment(id, amendment.id, EXPLOITANT))

      const initial = await findContractDocument(id, 1)
      assert.equal(initial?.snapshot?.buyer.name, 'Acme SAS')
      assert.equal(initial?.snapshot?.price.amountCents, 90_000)
      const second = await findContractDocument(id, 2)
      assert.equal(second?.snapshot?.kind, 'amendment')
      assert.equal(second?.snapshot?.buyer.name, 'Acme Groupe')
      assert.equal(second?.snapshot?.amendment?.number, 1)
      assert.equal(second?.snapshot?.price.amountCents, 95_000)
    })

    it('établit le document d’un contrat activé sans lui, une seule fois', async () => {
      const created = await createContract(saisie())
      // Activé hors de l'application, comme une reprise : sans document.
      await asTenant((tx) => tx.execute(sql`update contracts set status = 'active' where id = ${created.id}`))
      assert.deepEqual(await listContractDocuments(created.id), [])
      const document = await establishContractDocument(created.id, EXPLOITANT)
      assert.ok(document)
      assert.equal(document.version, 1)
      assert.equal(await establishContractDocument(created.id, EXPLOITANT), false)
    })

    it('n’archive rien quand l’activation est refusée', async () => {
      await contratActif()
      const doublon = await createContract(saisie())
      await rejects(() => activateContract(doublon.id, EXPLOITANT), ContractOccupationConflictError)
      assert.deepEqual(await listContractDocuments(doublon.id), [])
    })

    it('donne l’aperçu d’un brouillon sans l’archiver', async () => {
      const created = await createContract(saisie())
      const preview = await previewContractSnapshot(created.id)
      assert.equal(preview?.contract.reference, created.reference)
      assert.deepEqual(await listContractDocuments(created.id), [])
    })
  })

  describe('avenants (ADR 025)', () => {
    it('change le prix par de nouvelles lignes, et l’échéancier proratise au jour d’effet', async () => {
      const id = await contratActif()
      const created = await createAmendment(
        id,
        avenant({
          priceMode: 'lines',
          lines: [ligne({ unitPriceCents: 90_000 }), ligne({ target: { kind: 'none' }, description: 'Parking', unitPriceCents: 5_000 })],
        }),
      )
      assert.equal(created.status, 'draft')
      assert.equal(created.number, 1)
      // Le montant de l'avenant suit ses lignes.
      assert.equal(created.amountCents, 95_000)

      const signed = await signAmendment(id, created.id, EXPLOITANT)
      assert.deepEqual(signed, { documentVersion: 2 })
      const amendment = await findAmendment(id, created.id)
      assert.equal(amendment?.status, 'signed')
      assert.ok(amendment?.signedAt)

      const { versions } = await findContractTerms(id)
      assert.deepEqual(
        versions.map((version) => [version.amendmentNumber, version.startsOn, version.endsOn, version.amountCents, version.lines.length]),
        [
          [null, '2026-03-01', '2026-06-14', 90_000, 1],
          [1, '2026-06-15', null, 95_000, 2],
        ],
      )
      const contract = await findContract(id)
      assert.ok(contract)
      const juin = contractSchedule(contract, scheduleVersions(versions), '2026-06-30')[3]
      assert.deepEqual(
        juin.pieces.map((piece) => [piece.numerator, piece.denominator, piece.amountCents]),
        [
          // 14/30 de 900 € ; puis 16/30 de 900 € et de 50 €, ligne à ligne.
          [14, 30, 42_000],
          [16, 30, 48_000 + 2_667],
        ],
      )
      assert.deepEqual(await listCurrentTerms([id], '2026-07-01'), new Map([[id, { amountCents: 95_000, resourceCode: 'BUR-E1' }]]))
    })

    it('déplace l’occupation à la date d’effet d’un changement de ressource', async () => {
      const id = await contratActif()
      const created = await createAmendment(
        id,
        avenant({ effectiveOn: '2026-05-01', reason: 'Passage au bureau 2', changesResource: true, resourceId: AUTRE_BUREAU }),
      )
      assert.ok(await signAmendment(id, created.id, EXPLOITANT))
      const { segments } = await findContractTerms(id)
      assert.deepEqual(
        segments.map((segment) => [segment.resource?.code, segment.startsOn, segment.endsOn]),
        [
          ['BUR-E1', '2026-03-01', '2026-04-30'],
          ['BUR-E2', '2026-05-01', null],
        ],
      )
      assert.equal(segmentOn(segments, '2026-06-01')?.resource?.code, 'BUR-E2')
      const document = await findContractDocument(id, 2)
      assert.equal(document?.snapshot?.amendment?.previousResource?.code, 'BUR-E1')
      assert.equal(document?.snapshot?.resource?.code, 'BUR-E2')
    })

    it('nomme ce qui occupe la nouvelle ressource, et laisse l’avenant en brouillon', async () => {
      const id = await contratActif()
      await asTenant((tx) =>
        tx.execute(sql`
          insert into bookings (resource_id, channel, starts_at, ends_at, title)
          values (${AUTRE_BUREAU}, 'staff', '2026-06-10 08:00:00', '2026-06-10 09:00:00', 'Rendez-vous')`),
      )
      const created = await createAmendment(id, avenant({ effectiveOn: '2026-05-01', changesResource: true, resourceId: AUTRE_BUREAU }))
      const error = await rejects(() => signAmendment(id, created.id, EXPLOITANT), ContractOccupationConflictError)
      assert.equal(error.resourceId, AUTRE_BUREAU)
      assert.deepEqual(error.conflicts.map((booking) => booking.title), ['Rendez-vous'])
      assert.equal((await findAmendment(id, created.id))?.status, 'draft')
      assert.equal((await listContractDocuments(id)).length, 1)
    })

    it('rend le refus de la base en français : date d’effet, contrat qui n’est pas en cours', async () => {
      const id = await contratActif()
      const tot = await createAmendment(id, avenant({ effectiveOn: '2026-03-01', priceMode: 'amount', amountCents: 95_000 }))
      const error = await rejects(() => signAmendment(id, tot.id, EXPLOITANT), AmendmentRefusedError)
      assert.match(error.message, /doit suivre le premier jour du contrat \(01\/03\/2026\)/)

      const brouillon = await createContract(saisie({ resourceId: null }))
      const refus = await rejects(() => createAmendment(brouillon.id, avenant()), AmendmentRefusedError)
      assert.match(refus.message, /contrat en cours/)
    })

    it('se modifie en brouillon, passe des lignes au montant, puis s’abandonne', async () => {
      const id = await contratActif()
      const created = await createAmendment(id, avenant({ priceMode: 'lines', lines: [ligne({ unitPriceCents: 99_000 })] }))
      assert.ok(await updateDraftAmendment(id, created.id, avenant({ effectiveOn: '2026-07-01', priceMode: 'amount', amountCents: 97_000 })))
      let amendment = await findAmendment(id, created.id)
      assert.equal(amendment?.effectiveOn, '2026-07-01')
      assert.equal(amendment?.amountCents, 97_000)
      assert.deepEqual(amendment?.lines, [])

      assert.ok(await updateDraftAmendment(id, created.id, avenant({ effectiveOn: '2026-07-01' })))
      amendment = await findAmendment(id, created.id)
      assert.equal(amendment?.amountCents, null)

      assert.ok(await abandonAmendment(id, created.id))
      assert.equal(await abandonAmendment(id, created.id), false)
      assert.equal(await signAmendment(id, created.id, EXPLOITANT), false)
      assert.equal((await listAmendments(id))[0].deletedAt !== null, true)
    })
  })
})
