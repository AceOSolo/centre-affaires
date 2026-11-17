import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'

import { DB_CLIENT_DOCUMENT_REFUSED, DB_INSUFFICIENT_PRIVILEGE, dbErrorCode } from '../../db/errors.ts'
import { withClientScope, withTenant, type Transaction } from '../../db/index.ts'
import { ouvrirBasesDeTest, raisonDeSaut, viderTables, type TestDatabases } from '../../db/test-support.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { isSealedDocument } from '../../lib/chiffrement-documents.ts'
import type { Message, SendResult } from '../../lib/courriel.ts'
import { createProposalInTransaction } from '../facturation/propositions-queries.ts'
import { notifyClientDocumentReceived, notifyClientDocumentRefused } from '../notifications/declencheurs-pieces.ts'
import type { ClientAccount } from './comptes.ts'
import { purgeExpiredClientDocuments, purgeExpiredClientDocumentViews } from './pieces-conservation.ts'
import {
  ClientDocumentRefusal,
  clientHasDocumentSpace,
  depositClientDocument,
  findDocumentForAccounts,
  findDocumentForStaff,
  hasDocumentSpace,
  listClientDocumentsForStaff,
  listDocumentKinds,
  loadClientDocumentSpace,
  moveDocumentKind,
  reviewClientDocument,
  saveDocumentKind,
  setDocumentKindActive,
  type DocumentStorage,
} from './pieces-queries.ts'
import { serveClientDocument } from './pieces-servir.ts'

/**
 * Pièces justificatives de la domiciliation (ADR 075), contre une vraie base :
 * la liste réglée par centre, le dépôt depuis l'espace client (chiffré, sous
 * portée client, un seul en attente par type), la vérification par l'accueil
 * et ses passages permis, les messages, la consultation journalisée et la
 * conservation. Le stockage est un faux en mémoire.
 */
describe('pièces justificatives de la domiciliation', { skip: raisonDeSaut }, () => {
  let bases: TestDatabases

  const DURAND = '01a00000-0000-7000-8000-000000075c01'
  const PETIT = '01a00000-0000-7000-8000-000000075c02'
  const SALLE = '01a00000-0000-7000-8000-000000075c03'
  const CAMILLE = '01a00000-0000-7000-8000-000000075d01'
  const LEO = '01a00000-0000-7000-8000-000000075d02'
  const NOUR = '01a00000-0000-7000-8000-000000075d03'
  const ACCUEIL = '01a00000-0000-7000-8000-000000075e01'

  const durand: ClientAccount = { memberId: CAMILLE, clientId: DURAND, clientName: 'Atelier Durand' }
  const petit: ClientAccount = { memberId: NOUR, clientId: PETIT, clientName: 'Petit SAS' }

  const pdf = (text = 'Kbis') => new TextEncoder().encode(`%PDF-1.7\n${text}\n%%EOF\n`)

  let stockage: Map<string, Uint8Array>
  const storage: DocumentStorage = {
    async put(key, body) {
      stockage.set(key, new Uint8Array(body))
    },
    async remove(key) {
      stockage.delete(key)
    },
  }

  let envoyes: Message[] = []
  const send = async (message: Message): Promise<SendResult> => {
    envoyes.push(message)
    return { status: 'sent', recipients: message.to, failed: [], error: null }
  }

  const db = () => bases.app.db
  const asTenant = <T>(run: (tx: Transaction) => Promise<T>) => withTenant(DEFAULT_TENANT_ID, run, db())
  const lire = async (text: string, params: unknown[] = []) =>
    (await bases.owner.client.query(text, params))[0] as Record<string, unknown>[]
  const code = async (run: () => Promise<unknown>) => {
    try {
      await run()
    } catch (error) {
      return dbErrorCode(error)
    }
    return undefined
  }

  const deposer = (account: ClientAccount, kindCode: string, text?: string) =>
    depositClientDocument({ account, kindCode, file: { bytes: pdf(text), contentType: 'application/pdf' } }, { database: db(), storage })

  /** Demande de domiciliation de l'entreprise, avec la situation de sa société. */
  const demande = (clientId: string, situation: string) =>
    asTenant((tx) =>
      createProposalInTransaction(tx, {
        product: 'domiciliation',
        channel: 'client',
        clientId,
        requesterName: 'Camille Durand',
        requesterEmail: 'camille@durand.exemple',
        requesterCompany: 'Atelier Durand',
        answers: { situation, raisonSociale: 'Atelier Durand' },
        lines: [],
      }),
    )

  const saved: Record<string, string | undefined> = {}

  before(async () => {
    for (const name of ['DOCUMENTS_ENCRYPTION_KEY', 'DOCUMENTS_ENCRYPTION_KEY_VERSION', 'APP_URL']) saved[name] = process.env[name]
    process.env.DOCUMENTS_ENCRYPTION_KEY = randomBytes(32).toString('base64')
    process.env.DOCUMENTS_ENCRYPTION_KEY_VERSION = '1'
    process.env.APP_URL = 'https://centre.exemple'
    bases = await ouvrirBasesDeTest()
    ;(globalThis as { database?: unknown }).database = bases.app
  })

  beforeEach(async () => {
    stockage = new Map()
    envoyes = []
    await viderTables(
      bases.owner,
      'client_document_views',
      'client_documents',
      'client_document_kinds',
      'notification_deliveries',
      'proposal_lines',
      'proposals',
      'client_members',
      'clients',
      'staff_members',
      'resources',
    )
    await bases.owner.client.query("update tenants set email = 'accueil@centre.exemple' where id = ?", [DEFAULT_TENANT_ID])
    await asTenant(async (tx) => {
      await tx.execute(sql`insert into clients (id, name, status) values (${DURAND}, 'Atelier Durand', 'prospect'), (${PETIT}, 'Petit SAS', 'active')`)
      await tx.execute(sql`
        insert into client_members (id, client_id, email, full_name)
        values (${CAMILLE}, ${DURAND}, 'camille@durand.exemple', 'Camille Durand'),
               (${LEO}, ${DURAND}, 'leo@durand.exemple', 'Léo Durand'),
               (${NOUR}, ${PETIT}, 'nour@petit.exemple', 'Nour Petit')`)
      await tx.execute(sql`insert into staff_members (id, email, full_name, role) values (${ACCUEIL}, 'accueil@centre.exemple', 'Alix Accueil', 'staff')`)
      await tx.execute(sql`insert into resources (id, resource_type, code, name) values (${SALLE}, 'salle', 'SAL-75', 'Salle 75')`)
    })
  })

  after(async () => {
    await viderTables(bases.owner, 'client_document_views', 'client_documents', 'client_document_kinds', 'notification_deliveries', 'proposals', 'client_members', 'clients', 'staff_members', 'resources')
    await bases.owner.client.query('update tenants set email = null where id = ?', [DEFAULT_TENANT_ID])
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    delete (globalThis as { database?: unknown }).database
    await bases.fermer()
  })

  describe('liste des pièces demandées', () => {
    it('applique la liste du code tant que le centre n’y touche pas, puis l’écrit à la première modification', async () => {
      const avant = await listDocumentKinds(db())
      assert.equal(avant.customized, false)
      assert.deepEqual(avant.kinds.map((kind) => kind.code), ['piece-identite', 'kbis', 'statuts', 'justificatif-domicile'])
      assert.equal((await lire('select count(*) as n from client_document_kinds'))[0].n, 0)

      const ajoutee = await saveDocumentKind(null, { label: 'Attestation URSSAF', help: null, appliesTo: 'registered' }, ACCUEIL, db())
      assert.equal(ajoutee, 'attestation-urssaf')
      await saveDocumentKind('kbis', { label: 'Extrait Kbis original', help: 'De moins d’un mois.', appliesTo: 'registered' }, ACCUEIL, db())
      await setDocumentKindActive('statuts', false, ACCUEIL, db())
      await moveDocumentKind('justificatif-domicile', 'up', ACCUEIL, db())

      const apres = await listDocumentKinds(db())
      assert.equal(apres.customized, true)
      assert.deepEqual(
        apres.kinds.map((kind) => [kind.code, kind.active]),
        [
          ['piece-identite', true],
          ['kbis', true],
          ['justificatif-domicile', true],
          ['statuts', false],
          ['attestation-urssaf', true],
        ],
      )
      assert.equal(apres.kinds.find((kind) => kind.code === 'kbis')?.label, 'Extrait Kbis original')
    })

    it('refuse de l’écrire depuis l’espace client, d’en changer un code ou d’en supprimer une', async () => {
      await saveDocumentKind(null, { label: 'Attestation', help: null, appliesTo: 'all' }, ACCUEIL, db())
      assert.equal(
        await code(() =>
          withClientScope(DEFAULT_TENANT_ID, [DURAND], (tx) => tx.execute(sql`update client_document_kinds set label = 'X'`), db()),
        ),
        DB_INSUFFICIENT_PRIVILEGE,
      )
      assert.equal(
        await code(() => asTenant((tx) => tx.execute(sql`update client_document_kinds set code = 'autre' where code = 'kbis'`))),
        DB_CLIENT_DOCUMENT_REFUSED,
      )
      assert.equal(
        await code(() => asTenant((tx) => tx.execute(sql`delete from client_document_kinds where code = 'kbis'`))),
        DB_CLIENT_DOCUMENT_REFUSED,
      )
    })
  })

  describe('dépôt depuis l’espace client', () => {
    it('ouvre la rubrique à une entreprise qui a demandé une domiciliation, selon la situation de sa société', async () => {
      assert.equal(await hasDocumentSpace([durand], db()), false)
      assert.equal(await clientHasDocumentSpace(DURAND, db()), false)
      await demande(DURAND, 'creation')
      assert.equal(await hasDocumentSpace([durand], db()), true)
      assert.equal(await clientHasDocumentSpace(DURAND, db()), true)

      const [espace] = await loadClientDocumentSpace([durand, petit], db())
      assert.equal(espace.clientId, DURAND)
      assert.equal(espace.situation, 'creation')
      assert.deepEqual(espace.items.map((item) => [item.kind.code, item.state]), [
        ['piece-identite', 'missing'],
        ['statuts', 'missing'],
        ['justificatif-domicile', 'missing'],
      ])
    })

    it('dépose une pièce chiffrée, à vérifier ; refuse une seconde pièce du même type tant que la première attend', async () => {
      await demande(DURAND, 'immatriculee')
      const { id, kindLabel } = await deposer(durand, 'kbis')
      assert.equal(kindLabel, 'Extrait Kbis')

      const [ligne] = await lire('select * from client_documents where id = ?', [id])
      assert.equal(ligne.status, 'received')
      assert.equal(ligne.uploaded_by_member_id, CAMILLE)
      assert.equal(ligne.content_type, 'application/pdf')
      assert.equal(Number(ligne.encryption_key_version), 1)
      const stocke = stockage.get(String(ligne.storage_key))
      assert.ok(stocke && isSealedDocument(stocke), 'le stockage ne voit que du chiffré')
      assert.match(String(ligne.storage_key), /^pieces\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.pdf$/)

      // Léo, de la même entreprise, ne dépose pas un second Kbis : la base refuse, le fichier part.
      const leo = { ...durand, memberId: LEO }
      await assert.rejects(deposer(leo, 'kbis'), (error) => error instanceof ClientDocumentRefusal && /déjà déposée/.test(error.message))
      assert.equal(stockage.size, 1)

      // Une pièce que le centre ne demande pas à une société immatriculée.
      await assert.rejects(deposer(durand, 'statuts'), /pas demandée/)
      assert.equal(stockage.size, 1)
    })

    it('refuse sous portée client une pièce pour une autre entreprise, ou déjà vérifiée', async () => {
      await demande(DURAND, 'immatriculee')
      const insertion = (clientId: string, member: string, status = 'received') => sql`
        insert into client_documents (id, client_id, kind_code, kind_label, storage_key, encryption_key_version, content_type, byte_size, status, uploaded_by_member_id)
        values (uuid(), ${clientId}, 'kbis', 'Extrait Kbis', ${`pieces/x/${Math.random()}.pdf`}, 1, 'application/pdf', 10, ${status}, ${member})`
      assert.equal(
        await code(() => withClientScope(DEFAULT_TENANT_ID, [PETIT], (tx) => tx.execute(insertion(DURAND, CAMILLE)), db())),
        DB_INSUFFICIENT_PRIVILEGE,
      )
      assert.equal(
        await code(() => withClientScope(DEFAULT_TENANT_ID, [DURAND], (tx) => tx.execute(insertion(DURAND, CAMILLE, 'accepted')), db())),
        DB_CLIENT_DOCUMENT_REFUSED,
      )
    })
  })

  describe('vérification par l’accueil', () => {
    it('valide, puis refuse une pièce validée ; jamais l’inverse ; le client redépose une pièce refusée', async () => {
      await demande(DURAND, 'immatriculee')
      const { id } = await deposer(durand, 'kbis')

      await reviewClientDocument(id, { status: 'accepted' }, ACCUEIL, db())
      let vue = await listClientDocumentsForStaff(DURAND, db())
      const kbis = () => vue.items.find((item) => item.kind.code === 'kbis')
      assert.equal(kbis()?.state, 'accepted')
      assert.equal(kbis()?.latest?.reviewedByName, 'Alix Accueil')
      assert.equal(kbis()?.latest?.uploadedBy, 'Camille Durand')

      await reviewClientDocument(id, { status: 'refused', reason: 'Extrait de plus de trois mois.' }, ACCUEIL, db())
      await assert.rejects(
        reviewClientDocument(id, { status: 'accepted' }, ACCUEIL, db()),
        (error) => error instanceof ClientDocumentRefusal && /Passage impossible/.test(error.message),
      )

      const nouvelle = await deposer(durand, 'kbis', 'Kbis récent')
      vue = await listClientDocumentsForStaff(DURAND, db())
      assert.equal(kbis()?.latest?.id, nouvelle.id)
      assert.equal(kbis()?.state, 'received')
      assert.deepEqual(kbis()?.history.map((document) => document.status), ['received', 'refused'])
    })

    it('ne laisse l’espace client ni modifier ni supprimer une pièce ; le fichier ne se remplace pas', async () => {
      await demande(DURAND, 'immatriculee')
      const { id } = await deposer(durand, 'kbis')
      assert.equal(
        await code(() =>
          withClientScope(DEFAULT_TENANT_ID, [DURAND], (tx) => tx.execute(sql`update client_documents set status = 'accepted' where id = ${id}`), db()),
        ),
        DB_INSUFFICIENT_PRIVILEGE,
      )
      assert.equal(
        await code(() => asTenant((tx) => tx.execute(sql`update client_documents set storage_key = 'autre.pdf' where id = ${id}`))),
        DB_CLIENT_DOCUMENT_REFUSED,
      )
      assert.equal(
        await code(() => asTenant((tx) => tx.execute(sql`update client_documents set deleted_at = CURRENT_TIMESTAMP(3) where id = ${id}`))),
        DB_CLIENT_DOCUMENT_REFUSED,
      )
      assert.equal(await code(() => asTenant((tx) => tx.execute(sql`delete from client_documents where id = ${id}`))), DB_CLIENT_DOCUMENT_REFUSED)
    })
  })

  describe('messages', () => {
    it('prévient l’accueil d’une pièce reçue, et le client d’une pièce refusée, avec le motif', async () => {
      await demande(DURAND, 'immatriculee')
      const { id } = await deposer(durand, 'kbis')

      const recue = await notifyClientDocumentReceived(id, { database: db(), send })
      assert.equal(recue?.status, 'sent')
      assert.deepEqual(envoyes[0].to, ['accueil@centre.exemple'])
      assert.equal(envoyes[0].subject, 'Pièce déposée — Extrait Kbis, Atelier Durand')
      assert.match(envoyes[0].text, /Camille Durand a déposé pour Atelier Durand : Extrait Kbis\./)
      assert.match(envoyes[0].text, new RegExp(`https://centre.exemple/clients/${DURAND}#pieces`))

      // Pas encore refusée : rien ne part au client.
      assert.equal(await notifyClientDocumentRefused(id, { database: db(), send }), null)

      await reviewClientDocument(id, { status: 'refused', reason: 'Extrait de plus de trois mois.' }, ACCUEIL, db())
      const refusee = await notifyClientDocumentRefused(id, { database: db(), send })
      assert.equal(refusee?.status, 'sent')
      assert.deepEqual(envoyes[1].to.sort(), ['camille@durand.exemple', 'leo@durand.exemple'])
      assert.match(envoyes[1].text, /Motif : Extrait de plus de trois mois\./)
      assert.match(envoyes[1].text, /https:\/\/centre.exemple\/compte\/pieces/)

      const journal = await lire('select event, audience, client_id, related_type, related_id from notification_deliveries order by sent_at, event')
      assert.deepEqual(
        journal.map((row) => [row.event, row.audience, row.client_id, row.related_type, row.related_id]),
        [
          ['client_document_received', 'centre', DURAND, 'client_document', id],
          ['client_document_refused', 'client', DURAND, 'client_document', id],
        ],
      )
    })
  })

  describe('consultation', () => {
    it('sert la pièce déchiffrée à l’accueil et au client, journalisée ; jamais celle d’une autre entreprise', async () => {
      await demande(DURAND, 'immatriculee')
      const { id } = await deposer(durand, 'kbis', 'Contenu du Kbis')
      const read = async (key: string) => stockage.get(key) as Uint8Array

      const pourAccueil = await findDocumentForStaff(id, DURAND, db())
      assert.ok(pourAccueil)
      assert.equal(await findDocumentForStaff(id, PETIT, db()), undefined)
      const reponse = await serveClientDocument(pourAccueil, { viewer: 'staff', staffMemberId: ACCUEIL, authUserId: 'u-accueil' }, read)
      assert.equal(reponse.status, 200)
      assert.equal(reponse.headers.get('content-type'), 'application/pdf')
      assert.equal(reponse.headers.get('cache-control'), 'private, no-store')
      assert.match(new TextDecoder().decode(await reponse.arrayBuffer()), /Contenu du Kbis/)

      assert.equal(await findDocumentForAccounts(id, [petit], db()), undefined)
      const pourClient = await findDocumentForAccounts(id, [durand], db())
      assert.ok(pourClient)
      await serveClientDocument(pourClient, { viewer: 'client', clientMemberId: CAMILLE, authUserId: 'u-camille', clientId: DURAND }, read)

      const vues = await lire('select viewer, staff_member_id, client_member_id from client_document_views order by viewed_at, viewer')
      assert.deepEqual(
        vues.map((row) => [row.viewer, row.staff_member_id, row.client_member_id]).sort(),
        [
          ['client', null, CAMILLE],
          ['staff', ACCUEIL, null],
        ],
      )

      // Une pièce altérée n'est ni servie ni journalisée.
      const altere = await serveClientDocument(pourAccueil, { viewer: 'staff', staffMemberId: ACCUEIL, authUserId: 'u-accueil' }, async () => pdf('remplacé'))
      assert.equal(altere.status, 500)
      assert.equal((await lire('select count(*) as n from client_document_views'))[0].n, 2)
    })
  })

  describe('conservation', () => {
    it('efface le fichier d’une pièce refusée depuis plus de trois mois, et elle seule', async () => {
      await demande(DURAND, 'immatriculee')
      const ancienne = await deposer(durand, 'kbis')
      // Refusée il y a quatre mois : la date de la vérification se pose avec son passage d'état.
      await asTenant((tx) =>
        tx.execute(sql`
          update client_documents
             set status = 'refused', refusal_reason = 'Illisible.', reviewed_by = ${ACCUEIL},
                 reviewed_at = CURRENT_TIMESTAMP(3) - interval 4 month
           where id = ${ancienne.id}`),
      )
      const recente = await deposer(durand, 'kbis', 'Nouveau')
      await reviewClientDocument(recente.id, { status: 'refused', reason: 'Toujours illisible.' }, ACCUEIL, db())
      const gardee = await deposer(durand, 'piece-identite')

      const efface: string[] = []
      const remove = async (key: string) => {
        efface.push(key)
        stockage.delete(key)
      }
      assert.equal(await asTenant((tx) => purgeExpiredClientDocuments(tx, remove)), 1)
      const [ligne] = await lire('select storage_key, deleted_at from client_documents where id = ?', [ancienne.id])
      assert.deepEqual(efface, [ligne.storage_key])
      assert.ok(ligne.deleted_at)
      // Une pièce effacée ne s'ouvre plus et ne change plus.
      assert.equal(await findDocumentForStaff(ancienne.id, DURAND, db()), undefined)
      assert.equal((await lire('select deleted_at from client_documents where id = ?', [recente.id]))[0].deleted_at, null)
      assert.equal((await lire('select deleted_at from client_documents where id = ?', [gardee.id]))[0].deleted_at, null)
      // Rejouée, la purge ne trouve plus rien.
      assert.equal(await asTenant((tx) => purgeExpiredClientDocuments(tx, remove)), 0)
    })

    it('efface les pièces d’une relation finie depuis plus que la durée du centre ; garde celles d’une relation vivante', async () => {
      await demande(DURAND, 'immatriculee')
      const { id } = await deposer(durand, 'kbis')
      await reviewClientDocument(id, { status: 'accepted' }, ACCUEIL, db())
      const remove = async (key: string) => void stockage.delete(key)
      // Fiche créée hier : la relation vit.
      assert.equal(await asTenant((tx) => purgeExpiredClientDocuments(tx, remove)), 0)
      // Dernière activité il y a six ans, au-delà des cinq ans par défaut.
      await bases.owner.client.query('update clients set created_at = CURRENT_TIMESTAMP(3) - interval 6 year where id = ?', [DURAND])
      assert.equal(await asTenant((tx) => purgeExpiredClientDocuments(tx, remove)), 1)
      assert.equal(stockage.size, 0)
    })

    it('purge le journal des consultations au terme de sa durée', async () => {
      await demande(DURAND, 'immatriculee')
      const { id } = await deposer(durand, 'kbis')
      await asTenant((tx) =>
        tx.execute(sql`
          insert into client_document_views (id, document_id, viewer, staff_member_id, auth_user_id, viewed_at)
          values (uuid(), ${id}, 'staff', ${ACCUEIL}, 'u', CURRENT_TIMESTAMP(3) - interval 13 month),
                 (uuid(), ${id}, 'staff', ${ACCUEIL}, 'u', CURRENT_TIMESTAMP(3))`),
      )
      assert.equal(await asTenant(purgeExpiredClientDocumentViews), 1)
      assert.equal((await lire('select count(*) as n from client_document_views'))[0].n, 1)
      assert.equal(
        await code(() => asTenant((tx) => tx.execute(sql`delete from client_document_views`))),
        DB_INSUFFICIENT_PRIVILEGE,
      )
    })
  })
})
