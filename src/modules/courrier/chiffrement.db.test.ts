import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

import { createDatabase, withTenant } from '../../db/index.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import {
  isSealedDocument,
  openDocument,
  sealDocument,
  sealedKeyVersion,
  type DocumentKeyring,
} from '../../lib/chiffrement-documents.ts'
import { findScanForStaff } from './queries.ts'
import { encryptStoredScans, type ObjectStore } from './reprise-chiffrement.ts'
import { serveScan } from './servir.ts'

/**
 * Chiffrement au repos des numérisations (R22, ADR 020), éprouvé contre la
 * base : la reprise des objets déposés en clair, et la lecture qui déchiffre
 * avant d'envoyer. Le stockage est une table en mémoire ; la base est la
 * vraie, sous le rôle applicatif soumis à la RLS.
 */
const ownerUrl = process.env.TEST_OWNER_DATABASE_URL ?? process.env.DATABASE_URL
const appUrl = process.env.TEST_DATABASE_URL

const raison = !appUrl
  ? 'TEST_DATABASE_URL non défini'
  : !ownerUrl
    ? 'TEST_OWNER_DATABASE_URL non défini'
    : false

describe('chiffrement des numérisations', { skip: raison }, () => {
  // Les requêtes du module ouvrent leur propre connexion, par APP_DATABASE_URL.
  if (appUrl) process.env.APP_DATABASE_URL = appUrl

  const owner = createDatabase(ownerUrl ?? '', { onnotice: () => {} })
  const app = createDatabase(appUrl ?? '')

  const DURAND = '01a00000-0000-7000-8000-00000000e1a1'
  const CAMILLE = '01a00000-0000-7000-8000-00000000e1d1'

  const cle1 = randomBytes(32)
  const cle2 = randomBytes(32)
  const v1: DocumentKeyring = { currentVersion: 1, keys: new Map([[1, cle1]]) }
  /** Après rotation : la clé 2 chiffre, la clé 1 relit encore. */
  const v2: DocumentKeyring = { currentVersion: 2, keys: new Map([[2, cle2], [1, cle1]]) }

  const asTenant = <T>(run: Parameters<typeof withTenant<T>>[1]) =>
    withTenant(DEFAULT_TENANT_ID, run, app.db)

  /** Le stockage : une table en mémoire, observable. */
  let objets: Map<string, Uint8Array>
  const store: ObjectStore = {
    read: async (key) => objets.get(key),
    write: async (key, bytes) => {
      objets.set(key, Uint8Array.from(bytes))
    },
  }
  const lireObjet = async (key: string) => objets.get(key) as Uint8Array

  let numero = 0
  const scanPdf = (texte = 'Relevé URSSAF') => Buffer.from(`%PDF-1.7\n${texte} n° ${(numero += 1)}\n%%EOF`)

  /**
   * Un pli et sa numérisation, déposée en clair (`version` nulle) ou chiffrée
   * avec le trousseau donné.
   */
  const deposer = async (
    contenu: Buffer,
    {
      version = null as number | null,
      keyring = v1,
      deleted = false,
      byteSize = contenu.byteLength,
    } = {},
  ) => {
    const key = `courrier/${DEFAULT_TENANT_ID}/${randomBytes(8).toString('hex')}.pdf`
    const [item] = await asTenant((tx) =>
      tx.execute(sql`insert into mail_items (client_id) values (${DURAND}) returning id`),
    )
    const [scan] = await asTenant((tx) =>
      tx.execute(sql`
        insert into mail_scans (mail_item_id, side, storage_key, content_type, byte_size, encryption_key_version, deleted_at)
        values (${item.id}, 'envelope', ${key}, 'application/pdf', ${byteSize}, ${version},
                ${deleted ? sql`now()` : null})
        returning id`),
    )
    objets.set(key, version === null ? Uint8Array.from(contenu) : sealDocument(contenu, key, keyring).bytes)
    return { id: scan.id as string, key, contenu }
  }

  const version = async (id: string) => {
    const [row] = await asTenant((tx) =>
      tx.execute(sql`select encryption_key_version as v from mail_scans where id = ${id}`),
    )
    return row.v as number | null
  }

  const reprendre = (keyring: DocumentKeyring, apply = true) =>
    encryptStoredScans({ database: app.db, tenantId: DEFAULT_TENANT_ID, store, keyring, apply })

  before(async () => {
    await migrate(owner.db, { migrationsFolder: './src/db/migrations' })
  })

  beforeEach(async () => {
    objets = new Map()
    await owner.client`truncate table clients, staff_members cascade`
    await owner.client`delete from tenants where id <> ${DEFAULT_TENANT_ID}`
    await asTenant(async (tx) => {
      await tx.execute(sql`insert into clients (id, name, status) values (${DURAND}, 'Atelier Durand', 'active')`)
      await tx.execute(sql`
        insert into staff_members (id, email, full_name) values (${CAMILLE}, 'camille@centre.fr', 'Camille')`)
    })
  })

  after(async () => {
    const global = globalThis as { database?: { client: { end: () => Promise<void> } } }
    await Promise.all([owner.client.end(), app.client.end(), global.database?.client.end()])
  })

  describe('reprise des objets existants', () => {
    it('par défaut, compte sans rien toucher', async () => {
      const a = await deposer(scanPdf())
      await deposer(scanPdf())
      const ancien = await deposer(scanPdf(), { version: 1 })
      const avant = new Map(objets)

      const report = await reprendre(v2, false)
      assert.deepEqual(report.pending, { clair: 2, 'clé 1': 1 })
      assert.equal(report.encrypted + report.rotated + report.recorded, 0)
      assert.deepEqual(objets, avant)
      assert.equal(await version(a.id), null)
      assert.equal(await version(ancien.id), 1)
    })

    it('chiffre les objets en clair à la même clé de stockage, et enregistre la version', async () => {
      const a = await deposer(scanPdf())
      const b = await deposer(scanPdf())

      const report = await reprendre(v1)
      assert.equal(report.encrypted, 2)
      assert.deepEqual(report.failed, [])

      for (const { id, key, contenu } of [a, b]) {
        const stocke = await lireObjet(key)
        // Plus aucune copie lisible dans le stockage.
        assert.ok(isSealedDocument(stocke))
        assert.ok(!Buffer.from(stocke).includes('URSSAF'))
        assert.equal(objets.size, 2)
        assert.equal(await version(id), 1)
        assert.deepEqual(Buffer.from(openDocument(stocke, 1, key, v1)), contenu)
      }
    })

    it('se rejoue sans rien refaire', async () => {
      const a = await deposer(scanPdf())
      await reprendre(v1)
      const apres = await lireObjet(a.key)

      const encore = await reprendre(v1)
      assert.deepEqual(encore.pending, {})
      assert.equal(encore.encrypted, 0)
      assert.deepEqual(await lireObjet(a.key), apres)
    })

    it('termine une reprise interrompue sans rechiffrer', async () => {
      // Le chiffré a été écrit, la base n'a pas suivi.
      const a = await deposer(scanPdf())
      const chiffre = sealDocument(a.contenu, a.key, v1).bytes
      objets.set(a.key, chiffre)

      const report = await reprendre(v1)
      assert.equal(report.recorded, 1)
      assert.equal(report.encrypted, 0)
      assert.equal(await version(a.id), 1)
      assert.deepEqual(Buffer.from(await lireObjet(a.key)), chiffre)
    })

    it('rechiffre avec la nouvelle clé après une rotation', async () => {
      const a = await deposer(scanPdf(), { version: 1 })
      const clair = await deposer(scanPdf())

      const report = await reprendre(v2)
      assert.equal(report.rotated, 1)
      assert.equal(report.encrypted, 1)
      assert.equal(await version(a.id), 2)
      assert.equal(await version(clair.id), 2)
      assert.equal(sealedKeyVersion(await lireObjet(a.key)), 2)
      // L'ancienne clé peut partir : la nouvelle suffit.
      const seulementV2: DocumentKeyring = { currentVersion: 2, keys: new Map([[2, cle2]]) }
      assert.deepEqual(Buffer.from(openDocument(await lireObjet(a.key), 2, a.key, seulementV2)), a.contenu)
    })

    it('signale un objet absent, tronqué ou altéré, et le laisse tel quel', async () => {
      const absent = await deposer(scanPdf())
      objets.delete(absent.key)
      // Une taille qui ne correspond pas au dépôt : objet remplacé ou tronqué.
      const tronque = await deposer(scanPdf(), { byteSize: 9999 })
      const altere = await deposer(scanPdf(), { version: 1 })
      const octets = await lireObjet(altere.key)
      octets[25] ^= 1
      const saine = await deposer(scanPdf())

      const report = await reprendre(v2)
      assert.deepEqual(report.missing, [absent.id])
      assert.deepEqual(
        report.failed.map((failure) => failure.id).sort(),
        [tronque.id, altere.id].sort(),
      )
      // L'une n'empêche pas les autres.
      assert.equal(report.encrypted, 1)
      assert.equal(await version(saine.id), 2)

      assert.equal(await version(tronque.id), null)
      assert.equal(await version(altere.id), 1)
      assert.ok(!isSealedDocument(await lireObjet(tronque.key)))
      assert.equal(sealedKeyVersion(await lireObjet(altere.key)), 1)
    })

    it('ignore les numérisations purgées', async () => {
      await deposer(scanPdf(), { deleted: true })
      const report = await reprendre(v1)
      assert.deepEqual(report.pending, {})
      assert.equal(report.encrypted, 0)
    })
  })

  describe('lecture d’une numérisation', () => {
    const camille = { viewer: 'staff' as const, staffMemberId: CAMILLE, authUserId: 'u-camille' }

    const consultations = async () => {
      const [row] = await asTenant((tx) => tx.execute(sql`select count(*)::int as n from mail_scan_views`))
      return row.n as number
    }

    const servir = async (id: string) => {
      const scan = await findScanForStaff(id)
      assert.ok(scan)
      return serveScan(scan, camille, store.read as (key: string) => Promise<Uint8Array>)
    }

    // La clé de l'environnement, celle que lit l'application.
    const saved = {
      key: process.env.DOCUMENTS_ENCRYPTION_KEY,
      version: process.env.DOCUMENTS_ENCRYPTION_KEY_VERSION,
    }
    before(() => {
      process.env.DOCUMENTS_ENCRYPTION_KEY = cle1.toString('base64')
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

    it('rend le document déchiffré et journalise la consultation', async () => {
      const a = await deposer(scanPdf(), { version: 1 })
      const response = await servir(a.id)
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('content-type'), 'application/pdf')
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), a.contenu)
      assert.equal(await consultations(), 1)
    })

    it('rend tel quel un objet hérité en clair', async () => {
      const a = await deposer(scanPdf())
      const response = await servir(a.id)
      assert.equal(response.status, 200)
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), a.contenu)
    })

    it('rend un objet chiffré par une reprise interrompue', async () => {
      const a = await deposer(scanPdf())
      objets.set(a.key, sealDocument(a.contenu, a.key, v1).bytes)
      const response = await servir(a.id)
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), a.contenu)
    })

    it('refuse un document altéré, sans l’envoyer ni le journaliser', async (t) => {
      const erreurs = t.mock.method(console, 'error', () => {})
      const a = await deposer(scanPdf(), { version: 1 })
      ;(await lireObjet(a.key))[30] ^= 1

      const response = await servir(a.id)
      assert.equal(response.status, 500)
      assert.match(response.headers.get('content-type') ?? '', /^text\/plain/)
      const texte = await response.text()
      assert.match(texte, /Document refusé/)
      assert.ok(!texte.includes('URSSAF'))
      assert.equal(await consultations(), 0)
      assert.equal(erreurs.mock.callCount(), 1)
    })

    it('refuse un document chiffré avec une clé absente de l’environnement', async (t) => {
      t.mock.method(console, 'error', () => {})
      const a = await deposer(scanPdf(), { version: 2, keyring: v2 })
      const response = await servir(a.id)
      assert.equal(response.status, 500)
      assert.match(await response.text(), /clé de déchiffrement/)
      assert.equal(await consultations(), 0)
    })

    it('refuse un fichier en clair là où la base attend un chiffré', async (t) => {
      t.mock.method(console, 'error', () => {})
      const a = await deposer(scanPdf(), { version: 1 })
      objets.set(a.key, Uint8Array.from(a.contenu))
      const response = await servir(a.id)
      assert.equal(response.status, 500)
      assert.equal(await consultations(), 0)
    })
  })
})
