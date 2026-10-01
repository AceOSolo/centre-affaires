import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { describe, it } from 'node:test'

import {
  DocumentIntegrityError,
  DocumentKeyError,
  documentKeyringFromEnv,
  isSealedDocument,
  openDocument,
  sealDocument,
  sealedKeyVersion,
  type DocumentKeyring,
} from './chiffrement-documents.ts'

const KEY = 'courrier/01999f00-0000-7000-8000-000000000001/scan.pdf'
const pdf = Buffer.from('%PDF-1.7\nCourrier de l’URSSAF — relevé de cotisations\n%%EOF')

const cle1 = randomBytes(32)
const cle2 = randomBytes(32)
const v1: DocumentKeyring = { currentVersion: 1, keys: new Map([[1, cle1]]) }
/** Après rotation : la clé 2 chiffre, la clé 1 relit encore les anciens objets. */
const v2: DocumentKeyring = { currentVersion: 2, keys: new Map([[2, cle2], [1, cle1]]) }

describe('chiffrement des documents', () => {
  describe('aller-retour', () => {
    it('rend le document déposé, octet pour octet', () => {
      const sealed = sealDocument(pdf, KEY, v1)
      assert.equal(sealed.keyVersion, 1)
      assert.deepEqual(Buffer.from(openDocument(sealed.bytes, 1, KEY, v1)), pdf)
    })

    it('ne laisse rien de lisible dans le stockage', () => {
      const { bytes } = sealDocument(pdf, KEY, v1)
      assert.ok(!bytes.includes('%PDF'))
      assert.ok(!bytes.includes('URSSAF'))
      assert.ok(isSealedDocument(bytes))
    })

    it('ne produit jamais deux fois le même chiffré', () => {
      assert.notDeepEqual(sealDocument(pdf, KEY, v1).bytes, sealDocument(pdf, KEY, v1).bytes)
    })

    it('chiffre avec la clé courante et inscrit sa version', () => {
      const sealed = sealDocument(pdf, KEY, v2)
      assert.equal(sealed.keyVersion, 2)
      assert.equal(sealedKeyVersion(sealed.bytes), 2)
      assert.deepEqual(Buffer.from(openDocument(sealed.bytes, 2, KEY, v2)), pdf)
    })

    it('relit après rotation un objet chiffré avec l’ancienne clé', () => {
      const ancien = sealDocument(pdf, KEY, v1)
      assert.deepEqual(Buffer.from(openDocument(ancien.bytes, 1, KEY, v2)), pdf)
    })

    it('chiffre un fichier vide comme un autre', () => {
      const sealed = sealDocument(new Uint8Array(0), KEY, v1)
      assert.equal(openDocument(sealed.bytes, 1, KEY, v1).byteLength, 0)
    })
  })

  describe('altération', () => {
    const altere = (index: (length: number) => number) => {
      const { bytes } = sealDocument(pdf, KEY, v1)
      bytes[index(bytes.length)] ^= 1
      return bytes
    }

    it('refuse un contenu modifié d’un seul bit', () => {
      assert.throws(() => openDocument(altere(() => 30), 1, KEY, v1), DocumentIntegrityError)
    })

    it('refuse une étiquette d’authentification modifiée', () => {
      assert.throws(() => openDocument(altere((n) => n - 1), 1, KEY, v1), DocumentIntegrityError)
    })

    it('refuse un vecteur d’initialisation modifié', () => {
      assert.throws(() => openDocument(altere(() => 8), 1, KEY, v1), DocumentIntegrityError)
    })

    it('refuse un document tronqué', () => {
      const { bytes } = sealDocument(pdf, KEY, v1)
      assert.throws(() => openDocument(bytes.subarray(0, bytes.length - 5), 1, KEY, v1), DocumentIntegrityError)
      assert.throws(() => openDocument(bytes.subarray(0, 10), 1, KEY, v1), DocumentIntegrityError)
    })

    it('refuse un chiffré déplacé sous la clé d’un autre document', () => {
      // Sans cela, qui peut écrire dans le stockage ferait lire à un client le
      // courrier d'un autre.
      const { bytes } = sealDocument(pdf, KEY, v1)
      assert.throws(
        () => openDocument(bytes, 1, 'courrier/01999f00-0000-7000-8000-000000000001/autre.pdf', v1),
        DocumentIntegrityError,
      )
    })

    it('refuse un objet remplacé par un fichier en clair quand la base le dit chiffré', () => {
      assert.throws(() => openDocument(pdf, 1, KEY, v1), DocumentIntegrityError)
    })
  })

  describe('objet hérité en clair', () => {
    it('le rend tel quel, sans clé configurée', () => {
      // Aucun trousseau passé : un objet déposé avant le chiffrement se relit
      // sans clé.
      const saved = { ...process.env }
      delete process.env.DOCUMENTS_ENCRYPTION_KEY
      delete process.env.DOCUMENTS_ENCRYPTION_KEY_VERSION
      try {
        assert.equal(openDocument(pdf, null, KEY), pdf)
      } finally {
        Object.assign(process.env, saved)
      }
    })

    it('déchiffre un objet chiffré dont la base n’a pas encore enregistré la version', () => {
      // Reprise interrompue entre l'écriture du chiffré et celle de la base.
      const { bytes } = sealDocument(pdf, KEY, v1)
      assert.deepEqual(Buffer.from(openDocument(bytes, null, KEY, v1)), pdf)
    })

    it('n’est pas pris pour un document chiffré', () => {
      assert.equal(isSealedDocument(pdf), false)
      assert.equal(sealedKeyVersion(pdf), undefined)
      assert.equal(isSealedDocument(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), false)
    })
  })

  describe('mauvaise version de clé', () => {
    it('refuse quand la base désigne une autre version que l’en-tête', () => {
      const { bytes } = sealDocument(pdf, KEY, v1)
      assert.throws(() => openDocument(bytes, 2, KEY, v2), DocumentIntegrityError)
    })

    it('refuse une version absente de l’environnement, en la nommant', () => {
      const { bytes } = sealDocument(pdf, KEY, v2)
      assert.throws(() => openDocument(bytes, 2, KEY, v1), (error: unknown) => {
        assert.ok(error instanceof DocumentKeyError)
        assert.match(error.message, /version 2/)
        return true
      })
    })

    it('refuse la clé d’un autre environnement portant le même numéro', () => {
      // Une branche copiée depuis la production : même version 1, autre clé.
      const { bytes } = sealDocument(pdf, KEY, v1)
      const autreEnvironnement: DocumentKeyring = { currentVersion: 1, keys: new Map([[1, randomBytes(32)]]) }
      assert.throws(() => openDocument(bytes, 1, KEY, autreEnvironnement), DocumentIntegrityError)
    })

    it('refuse un en-tête dont on a changé la version', () => {
      // La version fait partie des données authentifiées.
      const { bytes } = sealDocument(pdf, KEY, v1)
      const deux = Buffer.from(bytes)
      deux.writeUInt16BE(2, 4)
      const memeCle: DocumentKeyring = { currentVersion: 2, keys: new Map([[2, cle1], [1, cle1]]) }
      assert.throws(() => openDocument(deux, 2, KEY, memeCle), DocumentIntegrityError)
    })
  })

  describe('trousseau lu dans l’environnement', () => {
    const b64 = (key: Buffer) => key.toString('base64')

    it('lit la clé courante et son numéro', () => {
      const keyring = documentKeyringFromEnv({
        DOCUMENTS_ENCRYPTION_KEY: b64(cle1),
        DOCUMENTS_ENCRYPTION_KEY_VERSION: '1',
      })
      assert.equal(keyring.currentVersion, 1)
      assert.deepEqual(keyring.keys.get(1), cle1)
    })

    it('garde les clés précédentes pendant une rotation', () => {
      const keyring = documentKeyringFromEnv({
        DOCUMENTS_ENCRYPTION_KEY: b64(cle2),
        DOCUMENTS_ENCRYPTION_KEY_VERSION: '2',
        DOCUMENTS_ENCRYPTION_KEY_1: b64(cle1),
      })
      assert.equal(keyring.currentVersion, 2)
      assert.deepEqual([...keyring.keys.keys()].sort(), [1, 2])
      const ancien = sealDocument(pdf, KEY, v1)
      assert.deepEqual(Buffer.from(openDocument(ancien.bytes, 1, KEY, keyring)), pdf)
    })

    it('exige la clé et son numéro', () => {
      assert.throws(() => documentKeyringFromEnv({}), DocumentKeyError)
      assert.throws(
        () => documentKeyringFromEnv({ DOCUMENTS_ENCRYPTION_KEY: b64(cle1) }),
        DocumentKeyError,
      )
      assert.throws(
        () => documentKeyringFromEnv({ DOCUMENTS_ENCRYPTION_KEY_VERSION: '1' }),
        DocumentKeyError,
      )
    })

    it('refuse une clé qui ne fait pas 32 octets', () => {
      assert.throws(
        () =>
          documentKeyringFromEnv({
            DOCUMENTS_ENCRYPTION_KEY: randomBytes(16).toString('base64'),
            DOCUMENTS_ENCRYPTION_KEY_VERSION: '1',
          }),
        DocumentKeyError,
      )
    })

    it('refuse un numéro de version hors de la colonne', () => {
      for (const version of ['0', '-1', '1.5', 'deux', '40000']) {
        assert.throws(
          () =>
            documentKeyringFromEnv({
              DOCUMENTS_ENCRYPTION_KEY: b64(cle1),
              DOCUMENTS_ENCRYPTION_KEY_VERSION: version,
            }),
          DocumentKeyError,
          version,
        )
      }
    })

    it('refuse deux clés différentes sous le même numéro', () => {
      // L'oubli typique d'une rotation : nouvelle clé posée, numéro inchangé.
      assert.throws(
        () =>
          documentKeyringFromEnv({
            DOCUMENTS_ENCRYPTION_KEY: b64(cle2),
            DOCUMENTS_ENCRYPTION_KEY_VERSION: '1',
            DOCUMENTS_ENCRYPTION_KEY_1: b64(cle1),
          }),
        DocumentKeyError,
      )
    })

    it('refuse de chiffrer sans clé configurée, plutôt que de déposer en clair', () => {
      const saved = { ...process.env }
      delete process.env.DOCUMENTS_ENCRYPTION_KEY
      delete process.env.DOCUMENTS_ENCRYPTION_KEY_VERSION
      try {
        assert.throws(() => sealDocument(pdf, KEY), DocumentKeyError)
      } finally {
        Object.assign(process.env, saved)
      }
    })
  })
})
