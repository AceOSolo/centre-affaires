import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import { createDatabase, withTenant, type Transaction } from '../../db/index.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { sealDocument } from '../../lib/chiffrement-documents.ts'
import { resourceTypes } from '../ressources/schema.ts'
import type { ClientAccount } from '../clients/comptes.ts'
import { inspectionFieldsError, inspectionValuesError } from './champs.ts'
import { compareInspections } from './comparaison.ts'
import { purgeExpiredInspectionPhotos, purgeExpiredInspectionPhotoViews } from './conservation.ts'
import { InspectionRefusal } from './erreurs.ts'
import { defaultTemplates } from './modeles-defaut.ts'
import {
  createInspection,
  findInspection,
  findInspectionForAccounts,
  findPhotoForAccounts,
  findPhotoForStaff,
  findTemplateOverview,
  listInspections,
  listInspectionsForAccounts,
  listOccupationCandidates,
  listOpenEntries,
  publishInTransaction,
  publishTemplateVersion,
  saveInspection,
  signInspection,
  withdrawInspection,
} from './queries.ts'
import type { InspectionField } from './schema.ts'
import { serveInspectionPhoto } from './servir.ts'

/**
 * États des lieux de l'écran à la base (R06, R33, ADR 039) : les requêtes et
 * les écritures du back-office et de l'espace client, éprouvées sous le rôle
 * applicatif soumis à la RLS. Le stockage est une table en mémoire.
 */
const ownerUrl = process.env.TEST_OWNER_DATABASE_URL ?? process.env.DATABASE_URL
const appUrl = process.env.TEST_DATABASE_URL

const raison = !appUrl
  ? 'TEST_DATABASE_URL non défini'
  : !ownerUrl
    ? 'TEST_OWNER_DATABASE_URL non défini'
    : false

describe('états des lieux, de l’écran à la base', { skip: raison }, () => {
  // Les requêtes du module ouvrent leur propre connexion, par APP_DATABASE_URL.
  if (appUrl) process.env.APP_DATABASE_URL = appUrl

  const owner = createDatabase(ownerUrl ?? '', { onnotice: () => {} })
  const app = createDatabase(appUrl ?? '')

  const DURAND = '01a00000-0000-7000-8000-0000000e0c01'
  const PETIT = '01a00000-0000-7000-8000-0000000e0c02'
  const JEANNE = '01a00000-0000-7000-8000-0000000e0d01'
  const PAUL = '01a00000-0000-7000-8000-0000000e0d02'
  const CAMILLE = '01a00000-0000-7000-8000-0000000e0e01'
  const BUREAU = '01a00000-0000-7000-8000-0000000e0b01'
  const VOITURE = '01a00000-0000-7000-8000-0000000e0b02'
  const CONTRAT = '01a00000-0000-7000-8000-0000000e0f01'
  const LOCATION = '01a00000-0000-7000-8000-0000000e0a01'
  const LOCATION_PETIT = '01a00000-0000-7000-8000-0000000e0a02'

  const durand: ClientAccount[] = [{ memberId: JEANNE, clientId: DURAND, clientName: 'Atelier Durand' }]
  const petit: ClientAccount[] = [{ memberId: PAUL, clientId: PETIT, clientName: 'Boulangerie Petit' }]

  const asTenant = <T>(run: (tx: Transaction) => Promise<T>) =>
    withTenant(DEFAULT_TENANT_ID, run, app.db)

  const refus = async (run: () => Promise<unknown>): Promise<string | undefined> => {
    try {
      await run()
    } catch (error) {
      if (error instanceof InspectionRefusal) return error.message
      throw error
    }
    return undefined
  }

  /** Valeurs complètes du modèle de départ d'un véhicule. */
  const VEHICULE_COMPLET = {
    kilometrage: 12_000,
    carburant: 'Plein',
    proprete_interieure: 'Propre',
    proprete_exterieure: 'Correcte',
    carrosserie: 'bon',
    cles: 2,
  }

  const ouvrir = (
    kind: 'entry' | 'exit' = 'entry',
    options: { booking?: string; entry?: string | null } = {},
  ) =>
    createInspection(
      {
        context: { kind: 'booking', id: options.booking ?? LOCATION },
        candidateKey: `b:${options.booking ?? LOCATION}`,
        kind,
        entryInspectionId: options.entry ?? null,
        performedAt: new Date(Date.now() - 60_000),
      },
      CAMILLE,
    )

  const clore = (id: string, values: Record<string, unknown> = VEHICULE_COMPLET) =>
    saveInspection(
      id,
      { values: values as never, observations: 'RAS', performedAt: new Date(Date.now() - 60_000) },
      CAMILLE,
    )

  let photos = 0
  const photo = async (inspectionId: string, storageKey?: string, keyVersion = 1) => {
    photos += 1
    const [row] = await asTenant((tx) =>
      tx.execute(sql`
        insert into inspection_photos (inspection_id, storage_key, encryption_key_version, content_type,
                                       byte_size, width, height, uploaded_by)
        values (${inspectionId}, ${storageKey ?? `etats-des-lieux/test/${photos}.jpg`}, ${keyVersion},
                'image/jpeg', 4, 2, 2, ${CAMILLE})
        returning id`),
    )
    return row.id as string
  }

  before(async () => {
    await migrate(owner.db, { migrationsFolder: './src/db/migrations' })
  })

  beforeEach(async () => {
    photos = 0
    await owner.client`truncate table bookings, contracts, clients, resources cascade`
    await owner.client`truncate table staff_members cascade`
    await owner.client`truncate table inspection_templates cascade`
    await owner.client`update tenants set inspection_photo_retention_months = 36, inspection_access_log_retention_months = 12 where id = ${DEFAULT_TENANT_ID}`
    await asTenant(async (tx) => {
      await tx.execute(sql`insert into staff_members (id, email, full_name) values (${CAMILLE}, 'camille@centre.fr', 'Camille Martin')`)
      await tx.execute(sql`
        insert into clients (id, name, status) values
          (${DURAND}, 'Atelier Durand', 'active'), (${PETIT}, 'Boulangerie Petit', 'active')`)
      await tx.execute(sql`
        insert into client_members (id, client_id, email, full_name, auth_user_id) values
          (${JEANNE}, ${DURAND}, 'jeanne@durand.fr', 'Jeanne Durand', 'u-jeanne'),
          (${PAUL}, ${PETIT}, 'paul@petit.fr', null, 'u-paul')`)
      await tx.execute(sql`
        insert into resources (id, resource_type, code, name) values
          (${BUREAU}, 'bureau', 'B-EDL', 'Bureau 4'), (${VOITURE}, 'vehicule', 'V-EDL', 'Utilitaire')`)
      await tx.execute(sql`
        insert into contracts (id, client_id, reference, contract_type, starts_on, amount_cents, resource_id) values
          (${CONTRAT}, ${DURAND}, 'EDL-1', 'bureau', '2026-11-01', 90000, ${BUREAU})`)
      await tx.execute(sql`
        insert into bookings (id, resource_id, client_id, kind, channel, status, title, starts_at, ends_at) values
          (${LOCATION}, ${VOITURE}, ${DURAND}, 'booking', 'staff', 'confirmed', 'Déménagement',
           now() + interval '1 hour', now() + interval '5 hours'),
          (${LOCATION_PETIT}, ${VOITURE}, ${PETIT}, 'booking', 'staff', 'confirmed', 'Livraison',
           now() + interval '1 day', now() + interval '1 day 4 hours')`)
    })
  })

  after(async () => {
    await owner.client`truncate table inspection_templates cascade`
    const global = globalThis as { database?: { client: { end: () => Promise<void> } } }
    await Promise.all([owner.client.end(), app.client.end(), global.database?.client.end()])
  })

  describe('validation : le code dit ce que dit la base', () => {
    const premier = (fields: unknown) =>
      asTenant(async (tx) => {
        const [row] = await tx.execute(sql`select inspection_fields_error(${JSON.stringify(fields)}::jsonb) as erreur`)
        return row.erreur as string | null
      })

    it('sur les modèles', async () => {
      const cas: unknown[] = [
        [{ id: 'murs', label: 'Murs', type: 'condition', required: true }],
        [],
        {},
        [{ id: 'Murs', label: 'Murs', type: 'text', required: true }],
        [{ id: 'murs', label: ' ', type: 'text', required: true }],
        [{ id: 'murs', label: 'Murs', type: 'photo', required: true }],
        [{ id: 'murs', label: 'Murs', type: 'text' }],
        [{ id: 'murs', label: 'Murs', type: 'text', required: true, unit: 'm²' }],
        [{ id: 'cles', label: 'Clés', type: 'number', required: true, unit: 'x'.repeat(21) }],
        [{ id: 'etat', label: 'État', type: 'choice', required: true, options: ['Seule'] }],
        [{ id: 'etat', label: 'État', type: 'choice', required: true, options: ['A', 'A'] }],
        [{ id: 'etat', label: 'État', type: 'choice', required: true }],
        [{ id: 'murs', label: 'Murs', type: 'text', required: true, options: ['A', 'B'] }],
        [{ id: 'murs', label: 'Murs', type: 'text', required: true, help: ' ' }],
        [{ id: 'murs', label: 'Murs', type: 'text', required: true, couleur: 'bleu' }],
        [
          { id: 'murs', label: 'Murs', type: 'text', required: true },
          { id: 'murs', label: 'Murs encore', type: 'text', required: false },
        ],
        ['murs'],
        ...resourceTypes.map((type) => defaultTemplates[type].fields),
      ]
      for (const fields of cas) {
        assert.equal(inspectionFieldsError(fields), await premier(fields), JSON.stringify(fields))
      }
    })

    it('sur les valeurs, en brouillon et à la clôture', async () => {
      const fields: InspectionField[] = defaultTemplates.vehicule.fields
      const cas: [Record<string, unknown> | unknown[], boolean][] = [
        [VEHICULE_COMPLET, true],
        [{ kilometrage: 12_000 }, false],
        [{ kilometrage: 12_000 }, true],
        [{ inconnu: 1 }, false],
        [{ kilometrage: '12 000' }, false],
        [{ carburant: 'Moitié' }, false],
        [{ carrosserie: 'excellent' }, false],
        [{ papiers_a_bord: 'oui' }, false],
        [{ dommages: 'x'.repeat(5001) }, false],
        [{ ...VEHICULE_COMPLET, carburant: null }, true],
        [{ ...VEHICULE_COMPLET, dommages: '' }, true],
        [[], false],
      ]
      for (const [values, complete] of cas) {
        const [row] = await asTenant((tx) =>
          tx.execute(sql`
            select inspection_values_error(${JSON.stringify(fields)}::jsonb, ${JSON.stringify(values)}::jsonb,
                                           ${complete}) as erreur`),
        )
        assert.equal(inspectionValuesError(fields, values, complete), row.erreur, JSON.stringify(values))
      }
    })
  })

  describe('modèles versionnés', () => {
    const CHAMPS: InspectionField[] = [
      { id: 'etat_general', label: 'État général', type: 'condition', required: true },
      { id: 'cles', label: 'Clés', type: 'number', unit: 'clés', required: true },
    ]

    it('publie la version 1, ne republie pas sans changement, versionne un nouveau nom, puis de nouveaux champs', async () => {
      assert.deepEqual(
        await publishTemplateVersion({ resourceType: 'bureau', name: 'Bureau', fields: CHAMPS }, CAMILLE),
        { status: 'published', version: 1 },
      )
      assert.deepEqual(
        await publishTemplateVersion({ resourceType: 'bureau', name: 'Bureau', fields: CHAMPS }, CAMILLE),
        { status: 'unchanged' },
      )
      // Le nom est figé avec la version (ADR 041) : le renommer en publie une.
      assert.deepEqual(
        await publishTemplateVersion({ resourceType: 'bureau', name: 'Bureaux', fields: CHAMPS }, CAMILLE),
        { status: 'published', version: 2 },
      )
      const v3 = [...CHAMPS, { id: 'proprete', label: 'Propreté', type: 'checkbox', required: false } as InspectionField]
      assert.deepEqual(
        await publishTemplateVersion({ resourceType: 'bureau', name: 'Bureaux', fields: v3 }, CAMILLE),
        { status: 'published', version: 3 },
      )
      const overview = await findTemplateOverview('bureau')
      assert.equal(overview.template?.name, 'Bureaux')
      assert.equal(overview.current?.version, 3)
      assert.deepEqual(overview.current?.fields, v3)
      assert.deepEqual(
        overview.versions.map((version) => version.version),
        [3, 2, 1],
      )
      assert.equal(overview.versions[1].createdByName, 'Camille Martin')
    })

    it('fait accepter chaque modèle de départ par la base', async () => {
      await asTenant(async (tx) => {
        for (const type of resourceTypes) {
          const outcome = await publishInTransaction(tx, { resourceType: type, ...defaultTemplates[type] }, null)
          assert.deepEqual(outcome, { status: 'published', version: 1 }, type)
        }
      })
    })

    it('publie le modèle de départ à la première saisie d’un type qui n’en a pas', async () => {
      assert.equal((await findTemplateOverview('vehicule')).template, null)
      const id = await ouvrir()
      const overview = await findTemplateOverview('vehicule')
      assert.equal(overview.current?.version, 1)
      assert.deepEqual(overview.current?.fields, defaultTemplates.vehicule.fields)
      const inspection = await findInspection(id)
      assert.equal(inspection?.template.version, 1)
    })

    it('garde à un état des lieux le nom que son modèle portait, même renommé depuis (ADR 041)', async () => {
      const id = await ouvrir()
      const avant = await findInspection(id)
      assert.equal(avant?.template.name, defaultTemplates.vehicule.name)
      assert.deepEqual(
        await publishTemplateVersion(
          { resourceType: 'vehicule', name: 'Véhicule de service', fields: defaultTemplates.vehicule.fields },
          CAMILLE,
        ),
        { status: 'published', version: 2 },
      )
      assert.equal((await findTemplateOverview('vehicule')).template?.name, 'Véhicule de service')
      const apres = await findInspection(id)
      assert.equal(apres?.template.version, 1)
      assert.equal(apres?.template.name, defaultTemplates.vehicule.name)
    })
  })

  describe('saisie', () => {
    it('propose les occupations de la réservation, du contrat ou de la ressource, et ne croit pas le formulaire', async () => {
      const parReservation = await listOccupationCandidates({ kind: 'booking', id: LOCATION })
      assert.deepEqual(
        parReservation.map((candidate) => [candidate.key, candidate.client.id, candidate.resource.id]),
        [[`b:${LOCATION}`, DURAND, VOITURE]],
      )
      const parContrat = await listOccupationCandidates({ kind: 'contract', id: CONTRAT })
      assert.deepEqual(
        parContrat.map((candidate) => [candidate.key, candidate.contractId, candidate.bookingId]),
        [[`c:${CONTRAT}:${BUREAU}`, CONTRAT, null]],
      )
      const parRessource = await listOccupationCandidates({ kind: 'resource', id: VOITURE })
      assert.deepEqual(
        parRessource.map((candidate) => candidate.key).sort(),
        [`b:${LOCATION}`, `b:${LOCATION_PETIT}`].sort(),
      )

      // Une clé qui n'est pas celle d'une occupation de ce point de départ.
      const message = await refus(() =>
        createInspection(
          {
            context: { kind: 'booking', id: LOCATION },
            candidateKey: `b:${LOCATION_PETIT}`,
            kind: 'entry',
            entryInspectionId: null,
            performedAt: new Date(),
          },
          CAMILLE,
        ),
      )
      assert.match(message ?? '', /n’est plus disponible/)

      const id = await createInspection(
        {
          context: { kind: 'contract', id: CONTRAT },
          candidateKey: `c:${CONTRAT}:${BUREAU}`,
          kind: 'entry',
          entryInspectionId: null,
          performedAt: new Date(),
        },
        CAMILLE,
      )
      const inspection = await findInspection(id)
      assert.equal(inspection?.client.id, DURAND)
      assert.equal(inspection?.resource.id, BUREAU)
      assert.equal(inspection?.contract?.reference, 'EDL-1')
      assert.equal(inspection?.stage, 'draft')
      assert.deepEqual(
        (await listInspections({ contractId: CONTRAT })).map((row) => row.id),
        [id],
      )
    })

    it('enregistre le brouillon, refuse une clôture incomplète, clôt, puis fige', async () => {
      const id = await ouvrir()
      await saveInspection(
        id,
        { values: { kilometrage: 12_000 }, observations: null, performedAt: new Date(Date.now() - 60_000) },
        null,
      )
      assert.match((await refus(() => clore(id, { kilometrage: 12_000 }))) ?? '', /est obligatoire/)
      assert.equal((await findInspection(id))?.stage, 'draft')

      await clore(id)
      const close = await findInspection(id)
      assert.equal(close?.stage, 'to_sign')
      assert.equal(close?.closedByName, 'Camille Martin')
      assert.ok(close?.closedAt)
      assert.match((await refus(() => clore(id))) ?? '', /clos ou retiré/)
      assert.deepEqual(
        (await listInspections({ stage: 'to_sign' })).map((row) => row.id),
        [id],
      )
    })

    it('rattache la sortie à l’entrée close ; chacune garde sa version, et elles se comparent', async () => {
      const entree = await ouvrir()
      assert.deepEqual(await listOpenEntries(DURAND, VOITURE), [])
      assert.match((await refus(() => ouvrir('exit', { entry: entree }))) ?? '', /n’est plus disponible/)
      await clore(entree)
      assert.deepEqual(
        (await listOpenEntries(DURAND, VOITURE)).map((row) => row.id),
        [entree],
      )
      // Une entrée d'un autre client n'est jamais proposée.
      assert.deepEqual(await listOpenEntries(PETIT, VOITURE), [])

      // Le modèle change entre l'entrée et la sortie.
      const v2 = defaultTemplates.vehicule.fields.map((field) =>
        field.id === 'carburant' ? { ...field, label: 'Niveau de charge ou de carburant' } : field,
      )
      await publishTemplateVersion(
        { resourceType: 'vehicule', name: defaultTemplates.vehicule.name, fields: v2 },
        CAMILLE,
      )
      const sortie = await ouvrir('exit', { entry: entree })
      await clore(sortie, { ...VEHICULE_COMPLET, kilometrage: 12_480, carburant: '1/2', carrosserie: 'usage' })
      assert.deepEqual(await listOpenEntries(DURAND, VOITURE), [])

      const detail = await findInspection(sortie)
      assert.equal(detail?.template.version, 2)
      assert.equal(detail?.entry?.id, entree)
      assert.equal(detail?.entry?.version, 1)
      const rows = compareInspections(
        { fields: detail!.entry!.fields, values: detail!.entry!.values },
        { fields: detail!.template.fields, values: detail!.values },
      )
      const row = (id: string) => rows.find((candidate) => candidate.fieldId === id)
      assert.equal(row('kilometrage')?.note, 'Écart : +480 km')
      assert.equal(row('carburant')?.label, 'Niveau de charge ou de carburant')
      assert.equal(row('carrosserie')?.change, 'worse')
      assert.equal((await findInspection(entree))?.exit?.id, sortie)
    })

    it('retire un brouillon, jamais un état clos', async () => {
      const brouillon = await ouvrir()
      await withdrawInspection(brouillon)
      assert.equal((await findInspection(brouillon))?.stage, 'withdrawn')
      assert.deepEqual(await listInspections(), [])
      const clos = await ouvrir()
      await clore(clos)
      assert.match((await refus(() => withdrawInspection(clos))) ?? '', /Seul un brouillon se retire/)
    })
  })

  describe('espace client', () => {
    it('ne montre que les états clos de l’entreprise', async () => {
      const brouillon = await ouvrir()
      const clos = await ouvrir()
      await clore(clos)
      const autre = await ouvrir('entry', { booking: LOCATION_PETIT })
      await clore(autre)

      assert.deepEqual(
        (await listInspectionsForAccounts(durand)).map((row) => row.id),
        [clos],
      )
      assert.equal(await findInspectionForAccounts(brouillon, durand), undefined)
      assert.equal(await findInspectionForAccounts(autre, durand), undefined)
      const vu = await findInspectionForAccounts(clos, durand)
      assert.equal(vu?.client.name, 'Atelier Durand')
      // Le client lit le nom de l'équipier, jamais son adresse.
      assert.equal(vu?.closedByName, 'Camille Martin')
    })

    it('valide une fois, au nom de la personne, avec ses réserves', async () => {
      const id = await ouvrir()
      await clore(id)
      assert.equal(await signInspection(id, petit, null), 'not_found')
      assert.equal(await signInspection(id, durand, 'Rayure sur le hayon'), 'signed')
      assert.equal(await signInspection(id, durand, 'Autre chose'), 'already_signed')

      const detail = await findInspection(id)
      assert.equal(detail?.stage, 'signed')
      assert.equal(detail?.signedByName, 'Jeanne Durand')
      assert.equal(detail?.clientRemarks, 'Rayure sur le hayon')
      assert.ok(detail?.signedAt && Date.now() - detail.signedAt.getTime() < 60_000)
      assert.equal(await signInspection(await ouvrir(), durand, null), 'not_found')
    })

    describe('photos', () => {
      const cle = randomBytes(32)
      const saved = {
        key: process.env.DOCUMENTS_ENCRYPTION_KEY,
        version: process.env.DOCUMENTS_ENCRYPTION_KEY_VERSION,
      }
      before(() => {
        process.env.DOCUMENTS_ENCRYPTION_KEY = cle.toString('base64')
        process.env.DOCUMENTS_ENCRYPTION_KEY_VERSION = '1'
      })
      after(() => {
        for (const [name, value] of [
          ['DOCUMENTS_ENCRYPTION_KEY', saved.key],
          ['DOCUMENTS_ENCRYPTION_KEY_VERSION', saved.version],
        ] as const) {
          if (value === undefined) delete process.env[name]
          else process.env[name] = value
        }
      })

      it('sert à l’entreprise ses photos, déchiffrées, et journalise chaque consultation', async () => {
        const id = await ouvrir()
        const image = new Uint8Array([0xff, 0xd8, 0xff, 0xd9])
        const key = 'etats-des-lieux/test/servie.jpg'
        const store = new Map([[key, sealDocument(image, key).bytes]])
        const photoId = await photo(id, key)
        await clore(id)

        assert.equal(await findPhotoForAccounts(photoId, petit), undefined)
        const pourJeanne = await findPhotoForAccounts(photoId, durand)
        assert.ok(pourJeanne)
        const response = await serveInspectionPhoto(
          pourJeanne,
          { viewer: 'client', clientMemberId: JEANNE, authUserId: 'u-jeanne', clientId: DURAND },
          async (stored) => store.get(stored)!,
        )
        assert.equal(response.status, 200)
        assert.equal(response.headers.get('content-type'), 'image/jpeg')
        assert.equal(response.headers.get('cache-control'), 'private, no-store')
        assert.deepEqual(new Uint8Array(await response.arrayBuffer()), image)

        const pourCamille = await findPhotoForStaff(photoId)
        assert.ok(pourCamille)
        await serveInspectionPhoto(
          pourCamille,
          { viewer: 'staff', staffMemberId: CAMILLE, authUserId: 'u-camille' },
          async (stored) => store.get(stored)!,
        )
        const journal = await asTenant((tx) =>
          tx.execute(sql`select viewer, client_member_id, staff_member_id from inspection_photo_views order by viewed_at`),
        )
        assert.deepEqual(
          journal.map((row) => [row.viewer, row.client_member_id, row.staff_member_id]),
          [
            ['client', JEANNE, null],
            ['staff', null, CAMILLE],
          ],
        )
      })

      it('refuse une photo altérée, sans la journaliser', async () => {
        const id = await ouvrir()
        const key = 'etats-des-lieux/test/alteree.jpg'
        const sealed = sealDocument(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), key).bytes
        sealed[sealed.length - 1] ^= 0xff
        const photoId = await photo(id, key)
        const found = await findPhotoForStaff(photoId)
        assert.ok(found)
        const response = await serveInspectionPhoto(
          found,
          { viewer: 'staff', staffMemberId: CAMILLE, authUserId: 'u-camille' },
          async () => sealed,
        )
        assert.equal(response.status, 500)
        const journal = await asTenant((tx) => tx.execute(sql`select 1 from inspection_photo_views`))
        assert.equal(journal.length, 0)
      })
    })
  })

  describe('conservation des photos', () => {
    /** Recule la clôture d'un état des lieux, sous le propriétaire (hors de l'application). */
    const reculerCloture = (id: string, mois: number) =>
      owner.client.begin(async (tx) => {
        await tx`select set_config('app.anonymization', 'on', true)`
        await tx`update inspections set closed_at = now() - make_interval(months => ${mois}) where id = ${id}`
      })

    it('efface le fichier puis marque la ligne, au terme compté depuis la sortie', async () => {
      const entree = await ouvrir()
      const photoEntree = await photo(entree, 'etats-des-lieux/test/entree.jpg')
      await clore(entree)
      const sortie = await ouvrir('exit', { entry: entree })
      const photoSortie = await photo(sortie, 'etats-des-lieux/test/sortie.jpg')
      await clore(sortie)
      const seule = await ouvrir('entry', { booking: LOCATION_PETIT })
      await photo(seule, 'etats-des-lieux/test/seule.jpg')
      await clore(seule)
      await reculerCloture(seule, 120)

      const effaces: string[] = []
      const supprimer = async (key: string) => {
        effaces.push(key)
      }
      assert.equal(await asTenant((tx) => purgeExpiredInspectionPhotos(tx, supprimer)), 0)
      assert.deepEqual(effaces, [])

      await reculerCloture(sortie, 37)
      assert.equal(await asTenant((tx) => purgeExpiredInspectionPhotos(tx, supprimer)), 2)
      assert.deepEqual(effaces.sort(), ['etats-des-lieux/test/entree.jpg', 'etats-des-lieux/test/sortie.jpg'])
      assert.equal(await findPhotoForStaff(photoEntree), undefined)
      assert.equal(await findPhotoForStaff(photoSortie), undefined)
      const detail = await findInspection(sortie)
      assert.equal(detail?.photos.length, 0)
      assert.equal(detail?.purgedPhotoCount, 1)
      // Rejouée, la purge ne trouve plus rien.
      assert.equal(await asTenant((tx) => purgeExpiredInspectionPhotos(tx, supprimer)), 0)
    })

    it('purge le journal des consultations à son terme', async () => {
      const id = await ouvrir()
      const photoId = await photo(id)
      await clore(id)
      await asTenant((tx) =>
        tx.execute(sql`
          insert into inspection_photo_views (photo_id, viewer, staff_member_id, auth_user_id, viewed_at)
          values (${photoId}, 'staff', ${CAMILLE}, 'u-camille', now() - interval '13 months'),
                 (${photoId}, 'staff', ${CAMILLE}, 'u-camille', now())`),
      )
      assert.equal(await asTenant(purgeExpiredInspectionPhotoViews), 1)
    })
  })
})
