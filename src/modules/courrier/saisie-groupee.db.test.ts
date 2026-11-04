import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'

import { withTenant, type Transaction } from '../../db/index.ts'
import { ouvrirBasesDeTest, raisonDeSaut, type TestDatabases } from '../../db/test-support.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { todayIsoDate } from '../../lib/dates.ts'
import { toutVider } from '../clients/test-support.ts'
import type { ScanFile } from './fichiers.ts'
import { findMailSpots, withdrawMail, type StoredScan } from './queries.ts'
import {
  EnvelopeStorageError,
  listMailRecipients,
  registerMailEntry,
  registerMailEntryWithEnvelopes,
  UnknownRecipientError,
  type EnvelopeStorage,
} from './saisie-groupee.ts'
import type { EntryItem } from './saisie-groupee-regles.ts'
import { batchRecipients, closeOpenBatch, findOpenBatch } from './tournees.ts'

/**
 * Saisie groupée du courrier (ADR 058), éprouvée contre la base sous
 * l'identité applicative : une photo = un pli, les plis de l'envoi entrent
 * dans la tournée ouverte en une fois ou pas du tout, chacun avec son
 * expéditeur et sa photo, dans l'ordre des photos.
 */
describe('saisie groupée du courrier', { skip: raisonDeSaut }, () => {
  let bases: TestDatabases

  const ACCUEIL = '01a00000-0000-7000-8000-0000000f5a01'
  const DURAND = '01a00000-0000-7000-8000-0000000f5b01'
  const PETIT = '01a00000-0000-7000-8000-0000000f5b02'
  const BUREAU = '01a00000-0000-7000-8000-0000000f5b03'
  const ARCHIVE = '01a00000-0000-7000-8000-0000000f5b04'
  const BAL = '01a00000-0000-7000-8000-0000000f5d01'
  const PARIS = 'Europe/Paris'

  const asTenant = <T>(run: (tx: Transaction) => Promise<T>) => withTenant(DEFAULT_TENANT_ID, run, bases.app.db)
  const lire = async (text: string, params: unknown[] = []) =>
    (await bases.owner.client.query(text, params))[0] as Record<string, unknown>[]

  let cle = 0
  /** Une photo d'enveloppe déjà déposée au stockage, telle que `store` la rend. */
  const deposee = (nom: string): StoredScan => ({
    side: 'envelope',
    key: `courrier/test/${nom}.jpg`,
    scan: { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), contentType: 'image/jpeg' },
    encryptionKeyVersion: 1,
  })
  /** Un pli de la saisie, comme l'écran l'envoie. */
  const pli = (
    clientId: string,
    kind: EntryItem<StoredScan>['kind'],
    extra: { sender?: string; photo?: string } = {},
  ): EntryItem<StoredScan> => ({
    key: String((cle += 1)),
    clientId,
    kind,
    sender: extra.sender ?? null,
    ...(extra.photo ? { envelope: deposee(extra.photo) } : {}),
  })
  const enregistrer = (entry: EntryItem<StoredScan>[], at = new Date(Date.now() - 60_000)) =>
    registerMailEntry(entry, at, ACCUEIL, bases.app.db)

  before(async () => {
    bases = await ouvrirBasesDeTest()
    ;(globalThis as { database?: unknown }).database = bases.app
  })

  beforeEach(async () => {
    await toutVider(bases.owner)
    await asTenant(async (tx) => {
      await tx.execute(sql`insert into staff_members (id, email, role) values (${ACCUEIL}, 'accueil@centre.test', 'admin')`)
      await tx.execute(sql`
        insert into clients (id, name, status, deleted_at) values
          (${DURAND}, 'Atelier Durand', 'active', null), (${PETIT}, 'Petit Conseil', 'active', null),
          (${BUREAU}, 'Bureau Martin', 'active', null),
          (${ARCHIVE}, 'Ancienne SARL', 'inactive', current_timestamp(3))`)
      await tx.execute(sql`
        insert into resources (id, resource_type, code, name) values (${BAL}, 'boite_aux_lettres', 'BAL-12', 'Boîte 12')`)
      // Durand et Petit sont domiciliés, Durand avec la boîte 12 ; Martin a un bureau.
      await tx.execute(sql`
        insert into contracts (client_id, reference, contract_type, status, starts_on, amount_cents, resource_id) values
          (${DURAND}, 'DOM-1', 'domiciliation', 'active', makedate(year(current_date()) - 1, 1), 3000, ${BAL}),
          (${PETIT}, 'DOM-2', 'domiciliation', 'active', makedate(year(current_date()) - 1, 1), 3000, null),
          (${BUREAU}, 'BUR-1', 'bureau', 'active', makedate(year(current_date()) - 1, 1), 50000, null)`)
    })
  })

  after(async () => {
    await toutVider(bases.owner)
    await bases?.fermer()
  })

  it('liste les domiciliés d’abord, avec leur boîte, sans les fiches archivées', async () => {
    const recipients = await listMailRecipients(todayIsoDate(PARIS), bases.app.db)
    assert.deepEqual(
      recipients.map((r) => [r.name, r.domiciled, r.mailbox]),
      [
        ['Atelier Durand', true, 'BAL-12'],
        ['Petit Conseil', true, null],
        ['Bureau Martin', false, null],
      ],
    )
  })

  it('« 3 lettres pour Durand, 1 colis et 1 recommandé pour Petit » : cinq plis dans la tournée, avec leurs expéditeurs', async () => {
    const receivedAt = new Date(Date.now() - 60_000)
    const done = await enregistrer(
      [
        pli(DURAND, 'lettre', { sender: 'URSSAF', photo: 'd1' }),
        pli(DURAND, 'lettre', { photo: 'd2' }),
        pli(DURAND, 'lettre'),
        pli(PETIT, 'colis', { sender: 'Fournisseur Delta', photo: 'p1' }),
        pli(PETIT, 'recommande'),
      ],
      receivedAt,
    )
    assert.deepEqual(done, { items: 5, clients: 2, envelopes: 3 })

    const open = await findOpenBatch()
    assert.equal(open?.items.length, 5)
    assert.equal(open?.clientCount, 2)
    const rows = await lire(`select id, client_id, kind, status, batch_id, registered_by, sender, received_at from mail_items`)
    assert.ok(rows.every((row) => row.batch_id === open?.id && row.status === 'received'))
    assert.ok(rows.every((row) => row.registered_by === ACCUEIL))
    assert.ok(rows.every((row) => (row.received_at as Date).getTime() === receivedAt.getTime()))
    assert.deepEqual(
      rows.map((row) => row.sender).sort(),
      ['Fournisseur Delta', 'URSSAF', null, null, null].sort(),
    )
    const tally = (clientId: string, kind: string) =>
      rows.filter((row) => row.client_id === clientId && row.kind === kind).length
    assert.deepEqual([tally(DURAND, 'lettre'), tally(PETIT, 'colis'), tally(PETIT, 'recommande')], [3, 1, 1])

    // Une photo par pli, chacune sur son pli ; les plis sans photo attendent la leur.
    const scans = await lire(`
      select i.client_id, i.kind, s.side, s.storage_key, s.uploaded_by, s.page_count
        from mail_scans s join mail_items i on i.id = s.mail_item_id
       order by s.storage_key`)
    assert.deepEqual(
      scans.map((row) => [row.client_id, row.kind, row.side, row.storage_key, row.uploaded_by, row.page_count]),
      [
        [DURAND, 'lettre', 'envelope', 'courrier/test/d1.jpg', ACCUEIL, null],
        [DURAND, 'lettre', 'envelope', 'courrier/test/d2.jpg', ACCUEIL, null],
        [PETIT, 'colis', 'envelope', 'courrier/test/p1.jpg', ACCUEIL, null],
      ],
    )
    assert.deepEqual(open?.items.map((item) => item.envelope).sort(), [false, false, true, true, true])
  })

  it('le rang de chaque pli dans sa journée suit l’ordre des photos, après les plis déjà reçus ce jour-là', async () => {
    const at = new Date(Date.now() - 60_000)
    // Un pli enregistré plus tôt, à la même heure : il reste le premier de la pile.
    await enregistrer([pli(DURAND, 'colis', { sender: 'Plus tôt' })], at)
    // Six photos d'un coup : dans la même milliseconde, l'ordre ne tient qu'aux identifiants.
    await enregistrer(
      [
        ...Array.from({ length: 4 }, (_, i) => pli(DURAND, 'lettre', { sender: `Photo ${i + 1}`, photo: `ordre-${i + 1}` })),
        pli(PETIT, 'lettre', { sender: 'Petit 1' }),
        pli(DURAND, 'lettre', { sender: 'Photo 5' }),
        pli(DURAND, 'recommande', { sender: 'Photo 6', photo: 'ordre-6' }),
      ],
      at,
    )
    const rows = await lire(`select id, sender from mail_items`)
    const reperes = await findMailSpots(
      rows.map((row) => row.id as string),
      PARIS,
    )
    const rang = (sender: string) => {
      const row = rows.find((candidate) => candidate.sender === sender)
      return reperes.get(row?.id as string)
    }
    assert.deepEqual(
      ['Plus tôt', 'Photo 1', 'Photo 2', 'Photo 3', 'Photo 4', 'Photo 5', 'Photo 6'].map((sender) => rang(sender)?.rank),
      [1, 2, 3, 4, 5, 6, 7],
    )
    assert.equal(rang('Photo 6')?.total, 7)
    assert.deepEqual(rang('Petit 1'), { rank: 1, total: 1, day: todayIsoDate(PARIS, at) })

    // Retirer un pli renumérote ceux qui le suivent, comme avant (ADR 057).
    await withdrawMail(rows.find((row) => row.sender === 'Photo 2')?.id as string)
    const apres = await findMailSpots(rows.map((row) => row.id as string), PARIS)
    assert.equal(apres.get(rows.find((row) => row.sender === 'Photo 3')?.id as string)?.rank, 3)
  })

  it('une deuxième saisie entre dans la même tournée, tant qu’elle est ouverte', async () => {
    await enregistrer([pli(DURAND, 'lettre'), pli(DURAND, 'lettre')])
    await enregistrer([pli(PETIT, 'lettre')])
    const open = await findOpenBatch()
    assert.equal(open?.items.length, 3)

    assert.ok(open)
    await closeOpenBatch(ACCUEIL, open.id)
    await enregistrer([pli(PETIT, 'lettre')])
    const next = await findOpenBatch()
    assert.notEqual(next?.id, open?.id)
    assert.equal(next?.items.length, 1)
  })

  it('la fin de tournée prévient comme avant : nombre et nature des plis, « pas de courrier » aux autres domiciliés', async () => {
    await enregistrer([
      pli(DURAND, 'lettre', { photo: 'f1' }),
      pli(DURAND, 'colis'),
      pli(DURAND, 'lettre', { sender: 'URSSAF' }),
      pli(BUREAU, 'autre'),
    ])
    const open = await findOpenBatch()
    assert.ok(open)
    const preview = await batchRecipients(open.id, bases.app.db)
    assert.deepEqual(
      preview.received.map((entry) => [entry.clientId, entry.count, entry.byKind.lettre, entry.byKind.colis, entry.byKind.autre]),
      [
        [DURAND, 3, 2, 1, 0],
        [BUREAU, 1, 0, 0, 1],
      ].sort((x, y) => (String(x[0]) < String(y[0]) ? -1 : 1)),
    )
    // Petit, domicilié sans pli, reçoit « pas de courrier aujourd'hui » ; Martin n'est pas domicilié.
    assert.deepEqual(preview.none, [PETIT])
  })

  it('une entreprise archivée entre-temps : rien n’est enregistré, ni pli, ni photo, ni tournée', async () => {
    await assert.rejects(
      enregistrer([pli(DURAND, 'lettre', { photo: 'a1' }), pli(ARCHIVE, 'lettre')]),
      (error) => error instanceof UnknownRecipientError && error.clientIds.includes(ARCHIVE),
    )
    assert.deepEqual(await lire(`select id from mail_items`), [])
    assert.deepEqual(await lire(`select id from mail_scans`), [])
    // La tournée ouverte par cette saisie part avec elle.
    assert.deepEqual(await lire(`select id from mail_batches`), [])
  })

  describe('photos déposées d’abord, puis tout enregistré ensemble (tout ou rien)', () => {
    /** Un faux stockage : les objets déposés, observables, et une panne au besoin. */
    const fauxStockage = (panneAuDepot?: number) => {
      const objets = new Set<string>()
      let depots = 0
      const storage: EnvelopeStorage = {
        store: async (tenantId, { envelope }) => {
          depots += 1
          if (depots === panneAuDepot) throw new Error('Stockage injoignable')
          const key = `courrier/${tenantId}/faux-${depots}.jpg`
          objets.add(key)
          return [{ side: 'envelope', key, scan: envelope, encryptionKeyVersion: 1 }]
        },
        discard: async (stored) => {
          for (const { key } of stored) objets.delete(key)
        },
      }
      return { storage, objets }
    }
    const photo = { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), contentType: 'image/jpeg' as const }
    const recu = (clientId: string, avecPhoto: boolean): EntryItem<ScanFile> => ({
      key: String((cle += 1)),
      clientId,
      kind: 'lettre',
      sender: null,
      ...(avecPhoto ? { envelope: photo } : {}),
    })

    it('chaque photo déposée devient l’enveloppe de son pli', async () => {
      const { storage, objets } = fauxStockage()
      const done = await registerMailEntryWithEnvelopes(
        [recu(DURAND, true), recu(DURAND, false), recu(PETIT, true)],
        new Date(Date.now() - 60_000),
        ACCUEIL,
        { storage, database: bases.app.db },
      )
      assert.deepEqual(done, { items: 3, clients: 2, envelopes: 2 })
      const keys = (await lire(`select storage_key from mail_scans order by storage_key`)).map((row) => row.storage_key)
      assert.deepEqual(keys, [...objets].sort())
      assert.equal(objets.size, 2)
    })

    it('une entreprise archivée entre-temps : les photos déjà déposées sont effacées', async () => {
      const { storage, objets } = fauxStockage()
      await assert.rejects(
        registerMailEntryWithEnvelopes([recu(DURAND, true), recu(ARCHIVE, true)], new Date(Date.now() - 60_000), ACCUEIL, {
          storage,
          database: bases.app.db,
        }),
        UnknownRecipientError,
      )
      assert.equal(objets.size, 0)
      assert.deepEqual(await lire(`select id from mail_items`), [])
    })

    it('une photo qui ne se dépose pas : rien n’est enregistré, les précédentes sont effacées', async () => {
      const { storage, objets } = fauxStockage(2)
      await assert.rejects(
        registerMailEntryWithEnvelopes(
          [recu(DURAND, true), recu(DURAND, false), recu(PETIT, true), recu(PETIT, true)],
          new Date(Date.now() - 60_000),
          ACCUEIL,
          { storage, database: bases.app.db },
        ),
        EnvelopeStorageError,
      )
      assert.equal(objets.size, 0)
      assert.deepEqual(await lire(`select id from mail_items`), [])
      assert.deepEqual(await lire(`select id from mail_batches`), [])
    })
  })

  it('une saisie vide n’ouvre pas de tournée', async () => {
    assert.deepEqual(await enregistrer([]), { items: 0, clients: 0, envelopes: 0 })
    assert.deepEqual(await lire(`select id from mail_batches`), [])
  })
})
