import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import { PG_INSPECTION_LOCKED, pgErrorCode } from '../../db/errors.ts'
import { createDatabase, withClientScope, withTenant, type Transaction } from '../../db/index.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import {
  openDocument,
  sealDocument,
  sealedKeyVersion,
  type DocumentKeyring,
} from '../../lib/chiffrement-documents.ts'
import type { ObjectStore } from '../courrier/reprise-chiffrement.ts'
import { rekeyInspectionPhotos } from './rechiffrement.ts'

/**
 * Rechiffrement des photos d'états des lieux après une rotation de clé (R33,
 * ADR 020, ADR 041), sous `app_centre` : chaque photo vivante passe à la clé
 * courante, celles d'un état des lieux clos comprises, sans que rien d'autre
 * ne change ; hors de la fonction de la base, la version de clé reste figée.
 */
const ownerUrl = process.env.TEST_OWNER_DATABASE_URL ?? process.env.DATABASE_URL
const appUrl = process.env.TEST_DATABASE_URL

const raison = !appUrl
  ? 'TEST_DATABASE_URL non défini'
  : !ownerUrl
    ? 'TEST_OWNER_DATABASE_URL non défini'
    : false

describe('rechiffrement des photos d’états des lieux', { skip: raison }, () => {
  const owner = createDatabase(ownerUrl ?? '', { onnotice: () => {} })
  const app = createDatabase(appUrl ?? '')

  const DURAND = '01a00000-0000-7000-8000-0000000a7c01'
  const CAMILLE = '01a00000-0000-7000-8000-0000000a7e01'
  const BUREAU = '01a00000-0000-7000-8000-0000000a7b01'
  const CONTRAT = '01a00000-0000-7000-8000-0000000a7f01'

  const cle1 = randomBytes(32)
  const cle2 = randomBytes(32)
  const avant: DocumentKeyring = { currentVersion: 1, keys: new Map([[1, cle1]]) }
  const apres: DocumentKeyring = { currentVersion: 2, keys: new Map([[1, cle1], [2, cle2]]) }

  const asTenant = <T>(run: (tx: Transaction) => Promise<T>) => withTenant(DEFAULT_TENANT_ID, run, app.db)

  /** Le stockage, en mémoire. */
  const objets = new Map<string, Uint8Array>()
  const store: ObjectStore = {
    read: async (key) => objets.get(key),
    write: async (key, bytes) => {
      objets.set(key, bytes)
    },
  }

  let inspectionId = ''
  let numero = 0

  /** Une photo déposée avec la clé donnée : son fichier chiffré, et sa ligne. */
  const photo = async (keyring: DocumentKeyring, contenu = randomBytes(2_000)) => {
    numero += 1
    const key = `etats-des-lieux/test/rechiffrement-${numero}.jpg`
    const sealed = sealDocument(contenu, key, keyring)
    objets.set(key, sealed.bytes)
    const [row] = await asTenant((tx) =>
      tx.execute(sql`
        insert into inspection_photos (inspection_id, storage_key, encryption_key_version, content_type,
                                       byte_size, width, height, uploaded_by)
        values (${inspectionId}, ${key}, ${sealed.keyVersion}, 'image/jpeg', ${contenu.byteLength}, 1600, 1200, ${CAMILLE})
        returning id`),
    )
    return { id: row.id as string, key, contenu }
  }

  const version = async (id: string) => {
    const [row] = await asTenant((tx) =>
      tx.execute(sql`select encryption_key_version as v from inspection_photos where id = ${id}`),
    )
    return Number(row.v)
  }

  const rechiffrer = (apply: boolean, keyring = apres) =>
    rekeyInspectionPhotos({ database: app.db, tenantId: DEFAULT_TENANT_ID, store, keyring, apply })

  before(async () => {
    await migrate(owner.db, { migrationsFolder: './src/db/migrations' })
  })

  beforeEach(async () => {
    objets.clear()
    await owner.client`truncate table bookings, contracts, clients, resources cascade`
    await owner.client`truncate table staff_members cascade`
    await owner.client`truncate table inspection_templates cascade`
    inspectionId = await asTenant(async (tx) => {
      await tx.execute(sql`insert into staff_members (id, email) values (${CAMILLE}, 'camille@centre.fr')`)
      await tx.execute(sql`insert into clients (id, name, status) values (${DURAND}, 'Atelier Durand', 'active')`)
      await tx.execute(sql`
        insert into resources (id, resource_type, code, name) values (${BUREAU}, 'bureau', 'B-RK', 'Bureau 4')`)
      await tx.execute(sql`
        insert into contracts (id, client_id, reference, contract_type, starts_on, amount_cents)
        values (${CONTRAT}, ${DURAND}, 'RK-1', 'bureau', '2026-01-01', 90000)`)
      const [modele] = await tx.execute(sql`
        insert into inspection_templates (resource_type, name) values ('bureau', 'Bureau') returning id`)
      const [versionModele] = await tx.execute(sql`
        insert into inspection_template_versions (template_id, version, name, fields, created_by)
        values (${modele.id as string}, 1, 'Bureau',
                '[{"id":"murs","label":"Murs","type":"condition","required":true}]'::jsonb, ${CAMILLE})
        returning id`)
      const [etat] = await tx.execute(sql`
        insert into inspections (kind, resource_id, client_id, contract_id, template_version_id, values, created_by)
        values ('entry', ${BUREAU}, ${DURAND}, ${CONTRAT}, ${versionModele.id as string}, '{"murs":"bon"}'::jsonb, ${CAMILLE})
        returning id`)
      return etat.id as string
    })
  })

  after(async () => {
    await owner.client`truncate table bookings, contracts, clients, resources cascade`
    await owner.client`truncate table staff_members cascade`
    await owner.client`truncate table inspection_templates cascade`
    await Promise.all([owner.client.end(), app.client.end()])
  })

  it('rechiffre avec la clé courante les photos d’un état des lieux clos, sans rien changer d’autre', async () => {
    const ancienne = await photo(avant)
    const recente = await photo(apres)
    await asTenant((tx) =>
      tx.execute(sql`update inspections set status = 'closed', closed_by = ${CAMILLE} where id = ${inspectionId}`),
    )
    const [ligneAvant] = await owner.client`
      select to_jsonb(p) - 'updated_at' - 'encryption_key_version' as ligne from inspection_photos as p where id = ${ancienne.id}`

    // Essai à blanc : ce qu'il y a à faire, rien de fait.
    const essai = await rechiffrer(false)
    assert.deepEqual(essai.pending, { 'clé 1': 1 })
    assert.equal(await version(ancienne.id), 1)
    assert.equal(sealedKeyVersion(objets.get(ancienne.key) as Uint8Array), 1)

    const bilan = await rechiffrer(true)
    assert.deepEqual(
      { rotated: bilan.rotated, recorded: bilan.recorded, missing: bilan.missing, failed: bilan.failed },
      { rotated: 1, recorded: 0, missing: [], failed: [] },
    )
    assert.equal(await version(ancienne.id), 2)
    assert.equal(await version(recente.id), 2)
    // Le fichier se lit avec la nouvelle clé seule, et c'est le même.
    const seuleNouvelle: DocumentKeyring = { currentVersion: 2, keys: new Map([[2, cle2]]) }
    assert.deepEqual(
      Buffer.from(openDocument(objets.get(ancienne.key) as Uint8Array, 2, ancienne.key, seuleNouvelle)),
      ancienne.contenu,
    )
    const [ligneApres] = await owner.client`
      select to_jsonb(p) - 'updated_at' - 'encryption_key_version' as ligne from inspection_photos as p where id = ${ancienne.id}`
    assert.deepEqual(ligneApres.ligne, ligneAvant.ligne)

    // Rejoué : plus rien à faire.
    assert.deepEqual((await rechiffrer(true)).pending, {})
  })

  it('reprend une reprise interrompue, et signale un fichier absent ou altéré sans y toucher', async () => {
    const interrompue = await photo(avant)
    const absente = await photo(avant)
    const alteree = await photo(avant)
    // Le fichier est déjà rechiffré, la base ne le sait pas encore.
    objets.set(interrompue.key, sealDocument(interrompue.contenu, interrompue.key, apres).bytes)
    objets.delete(absente.key)
    const tronque = Buffer.from(objets.get(alteree.key) as Uint8Array)
    tronque[tronque.length - 1] ^= 0xff
    objets.set(alteree.key, tronque)

    const bilan = await rechiffrer(true)
    assert.equal(bilan.recorded, 1)
    assert.equal(bilan.rotated, 0)
    assert.deepEqual(bilan.missing, [absente.id])
    assert.deepEqual(bilan.failed.map((echec) => echec.id), [alteree.id])
    assert.equal(await version(interrompue.id), 2)
    assert.equal(await version(absente.id), 1)
    assert.equal(await version(alteree.id), 1)
  })

  it('garde la version de clé figée hors de la fonction de la base, qui ne change rien d’autre', async () => {
    const deposee = await photo(avant)
    const code = async (run: () => Promise<unknown>) => {
      try {
        await run()
      } catch (error) {
        return pgErrorCode(error)
      }
      return undefined
    }
    assert.equal(
      await code(() =>
        asTenant((tx) => tx.execute(sql`update inspection_photos set encryption_key_version = 2 where id = ${deposee.id}`)),
      ),
      PG_INSPECTION_LOCKED,
    )
    // Sous le drapeau, seule la version de clé passe.
    assert.equal(
      await code(() =>
        asTenant(async (tx) => {
          await tx.execute(sql`select set_config('app.inspection_photo_rekey', 'on', true)`)
          await tx.execute(sql`update inspection_photos set byte_size = 1 where id = ${deposee.id}`)
        }),
      ),
      PG_INSPECTION_LOCKED,
    )
    // Depuis un espace client : refusée.
    assert.equal(
      await code(() =>
        withClientScope(
          DEFAULT_TENANT_ID,
          [DURAND],
          (tx) => tx.execute(sql`select rekey_inspection_photo(${deposee.id}::uuid, 1, 2)`),
          app.db,
        ),
      ),
      PG_INSPECTION_LOCKED,
    )
    // La version de départ doit être celle de la ligne.
    const [mauvaise] = await asTenant((tx) =>
      tx.execute(sql`select rekey_inspection_photo(${deposee.id}::uuid, 3, 2) as done`),
    )
    assert.equal(mauvaise.done, false)
    assert.equal(await version(deposee.id), 1)
  })
})
