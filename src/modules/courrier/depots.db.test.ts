import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'

import { DB_MAIL_TEAM_REFUSED, dbErrorCode } from '../../db/errors.ts'
import { withTenant, type Transaction } from '../../db/index.ts'
import { ouvrirBasesDeTest, raisonDeSaut, viderTables, type TestDatabases } from '../../db/test-support.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { uuidv7 } from '../../lib/uuid.ts'
import type { ClientAccount } from '../clients/comptes.ts'
import { findMailForAccounts, refuseMailRequest, requestScan, searchMailForAccounts } from './demandes-queries.ts'
import {
  discardRequestDrafts,
  findContentDrafts,
  recordContentDraft,
  recordDraftDiscard,
  validateContentDraft,
} from './depots.ts'
import {
  findScanForAccounts,
  listMailForAccounts,
  listOpenings,
  MailStateError,
  requestOpening,
  withdrawMail,
  type StoredScan,
} from './queries.ts'

/**
 * Contenu numérisé à valider avant d'être montré au client (ADR 079), contre
 * la base sous l'identité applicative :
 *
 * - un dépôt n'existe pas pour le client — ni lien, ni compte, ni relevé —
 *   tant que l'accueil ne l'a pas validé ; un nouveau dépôt remplace le
 *   précédent, qui ne compte jamais ;
 * - la validation fait le geste : pli ouvert (demandé ou d'office), ou
 *   numérisation demandée faite ;
 * - la base refuse le reste (`CA025`), quel que soit le chemin d'écriture.
 */
describe('contenu à valider avant le client', { skip: raisonDeSaut }, () => {
  let bases: TestDatabases

  const DURAND = '01a00000-0000-7000-8000-0000000f0c01'
  const JEANNE = '01a00000-0000-7000-8000-0000000f0d01'
  const CAMILLE = '01a00000-0000-7000-8000-0000000f0e01'
  const durand: ClientAccount[] = [{ memberId: JEANNE, clientId: DURAND, clientName: 'Atelier Durand' }]

  const asTenant = <T>(run: (tx: Transaction) => Promise<T>) => withTenant(DEFAULT_TENANT_ID, run, bases.app.db)
  const lire = async (requete: ReturnType<typeof sql>) =>
    ((await asTenant((tx) => tx.execute(requete))) as unknown as [Record<string, unknown>[]])[0]

  const toutVider = () =>
    viderTables(
      bases.owner,
      'crm_consumptions',
      'mail_scan_views',
      'mail_scans',
      'mail_requests',
      'mail_items',
      'client_members',
      'clients',
      'staff_members',
    )

  const pli = async ({ ouvert = false } = {}): Promise<string> => {
    const id = uuidv7()
    await asTenant((tx) =>
      tx.execute(sql`
        insert into mail_items (id, client_id, kind, sender, status, opened_at, opened_by)
        values (${id}, ${DURAND}, 'lettre', 'URSSAF', ${ouvert ? 'opened' : 'received'},
                ${ouvert ? sql`CURRENT_TIMESTAMP(3)` : null}, ${ouvert ? CAMILLE : null})`),
    )
    return id
  }

  /** Un contenu déjà déposé au stockage (le stockage n'est pas éprouvé ici). */
  const depose = (nom: string, pages = 1): StoredScan[] => [
    {
      side: 'content',
      key: `courrier/test/${nom}.pdf`,
      scan: { bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]), contentType: 'application/pdf', pageCount: pages },
      encryptionKeyVersion: 1,
    },
  ]

  const etat = async (table: 'mail_items' | 'mail_requests', id: string) =>
    (await lire(sql`select * from ${sql.raw(table)} where id = ${id}`))[0]

  /** Ce que l'espace client voit du contenu d'un pli : le lien de la fiche, de la liste et des demandes. */
  const vuDuClient = async (mailItemId: string, scanId: string) => {
    const fiche = await findMailForAccounts(mailItemId, durand)
    const liste = (await listMailForAccounts(durand)).find((row) => row.id === mailItemId)
    const boite = (
      await searchMailForAccounts(durand, {}, { number: 1, size: 20 }, 'Europe/Paris')
    ).rows.find((row) => row.id === mailItemId)
    return {
      scans: fiche?.scans.filter((scan) => scan.side === 'content').map((scan) => scan.id) ?? [],
      liste: liste?.contentScanId ?? null,
      carte: boite?.contentScanId ?? null,
      compte: boite?.contentScanCount ?? 0,
      demandes: fiche?.requests.map((request) => request.contentScanId) ?? [],
      fichier: (await findScanForAccounts(scanId, durand))?.id ?? null,
    }
  }

  const refusParLaBase = async (run: () => Promise<unknown>) => {
    try {
      await run()
    } catch (error) {
      return dbErrorCode(error)
    }
    assert.fail('la base aurait dû refuser')
  }

  before(async () => {
    bases = await ouvrirBasesDeTest()
    ;(globalThis as { database?: unknown }).database = bases.app
  })

  beforeEach(async () => {
    await toutVider()
    await asTenant(async (tx) => {
      await tx.execute(sql`insert into clients (id, name, status) values (${DURAND}, 'Atelier Durand', 'active')`)
      await tx.execute(sql`
        insert into client_members (id, client_id, email, full_name, auth_user_id)
        values (${JEANNE}, ${DURAND}, 'jeanne@durand.fr', 'Jeanne Durand', 'u-jeanne')`)
      await tx.execute(sql`insert into staff_members (id, email, full_name) values (${CAMILLE}, 'camille@centre.fr', 'Camille')`)
    })
  })

  after(async () => {
    await toutVider()
    delete (globalThis as { database?: unknown }).database
    await bases.fermer()
  })

  it('ouverture demandée : invisible avant la validation, remplacée sans compter, puis publiée', async () => {
    const id = await pli()
    assert.equal(await requestOpening(id, durand), true)
    const [demandeOuverture] = await lire(sql`select id, status from mail_requests where mail_item_id = ${id}`)
    const requestId = demandeOuverture.id as string

    const premier = await recordContentDraft({ mailItemId: id, requestId }, CAMILLE, depose('premier', 5))
    // Déposer, c'est commencer : le client ne l'annule plus.
    assert.equal((await etat('mail_requests', requestId)).status, 'in_progress')
    assert.equal((await etat('mail_items', id)).status, 'opening_requested')
    assert.deepEqual(await vuDuClient(id, premier.draftId), {
      scans: [],
      liste: null,
      carte: null,
      compte: 0,
      demandes: [null],
      fichier: null,
    })

    // Un fichier refait remplace le premier : purgé, il ne compte nulle part.
    const second = await recordContentDraft({ mailItemId: id, requestId }, CAMILLE, depose('second', 2))
    assert.deepEqual(second.replacedKeys, ['courrier/test/premier.pdf'])
    const drafts = await findContentDrafts(id)
    assert.deepEqual(
      drafts.map((draft) => [draft.id, draft.purpose, draft.pageCount]),
      [[second.draftId, 'opening', 2]],
    )

    assert.deepEqual(await validateContentDraft(second.draftId, CAMILLE), {
      mailItemId: id,
      purpose: 'opening',
      requestId,
    })
    const item = await etat('mail_items', id)
    assert.equal(item.status, 'opened')
    assert.equal(item.opened_by, CAMILLE)
    assert.equal((await etat('mail_requests', requestId)).status, 'done')
    assert.deepEqual(await vuDuClient(id, second.draftId), {
      scans: [second.draftId],
      liste: second.draftId,
      carte: second.draftId,
      compte: 1,
      demandes: [second.draftId],
      fichier: second.draftId,
    })
    // Le relevé lit les pages du contenu validé, pas celles du dépôt remplacé.
    const [ouverture] = await listOpenings({ startsAt: new Date(Date.now() - 3600_000), endsAt: new Date(Date.now() + 3600_000) })
    assert.equal(ouverture.pageCount, 2)
    assert.deepEqual(await findContentDrafts(id), [])
  })

  it('numérisation demandée : la validation fait la demande', async () => {
    const id = await pli({ ouvert: true })
    const outcome = await requestScan(id, durand, null)
    assert.ok(outcome.ok)
    const requestId = outcome.requestId
    const depot = await recordContentDraft({ mailItemId: id, requestId }, CAMILLE, depose('scan', 3))
    assert.equal((await findContentDrafts(id))[0].purpose, 'scan')
    assert.equal((await vuDuClient(id, depot.draftId)).fichier, null)

    assert.deepEqual(await validateContentDraft(depot.draftId, CAMILLE), { mailItemId: id, purpose: 'scan', requestId })
    const demande = await etat('mail_requests', requestId)
    assert.equal(demande.status, 'done')
    assert.equal(demande.completed_by_staff_id, CAMILLE)
    assert.equal((await vuDuClient(id, depot.draftId)).fichier, depot.draftId)
    // Une seconde validation ne republie rien.
    await assert.rejects(validateContentDraft(depot.draftId, CAMILLE), MailStateError)
  })

  it('ouverture d’office : une demande arrivée entre-temps en devient l’origine', async () => {
    const id = await pli()
    const depot = await recordContentDraft({ mailItemId: id, requestId: null }, CAMILLE, depose('office'))
    assert.equal(depot.requestId, null)
    assert.equal(await requestOpening(id, durand), true)
    const validated = await validateContentDraft(depot.draftId, CAMILLE)
    assert.equal(validated.purpose, 'opening')
    assert.ok(validated.requestId)
    assert.equal((await etat('mail_requests', validated.requestId)).status, 'done')
    const [scan] = await lire(sql`select mail_request_id, pending_validation from mail_scans where id = ${depot.draftId}`)
    assert.equal(scan.mail_request_id, validated.requestId)
    assert.equal(Number(scan.pending_validation), 0)
    // Le pli est ouvert : plus de dépôt d'office.
    await assert.rejects(
      recordContentDraft({ mailItemId: id, requestId: null }, CAMILLE, depose('trop-tard')),
      (error) => error instanceof MailStateError && /déjà ouvert/.test(error.message),
    )
  })

  it('abandon, refus, retrait : rien n’est publié', async () => {
    const id = await pli()
    const abandon = await recordContentDraft({ mailItemId: id, requestId: null }, CAMILLE, depose('abandon'))
    assert.deepEqual((await recordDraftDiscard(abandon.draftId)).keys, ['courrier/test/abandon.pdf'])
    await assert.rejects(validateContentDraft(abandon.draftId, CAMILLE), MailStateError)
    assert.equal((await etat('mail_items', id)).status, 'received')

    const ouvert = await pli({ ouvert: true })
    const outcome = await requestScan(ouvert, durand, null)
    assert.ok(outcome.ok)
    const depot = await recordContentDraft({ mailItemId: ouvert, requestId: outcome.requestId }, CAMILLE, depose('refus'))
    await refuseMailRequest(outcome.requestId, CAMILLE, 'Pli illisible.')
    await assert.rejects(validateContentDraft(depot.draftId, CAMILLE), /plus en cours/)
    await discardRequestDrafts(outcome.requestId)
    assert.deepEqual(await findContentDrafts(ouvert), [])

    const retire = await pli()
    await withdrawMail(retire)
    await assert.rejects(
      recordContentDraft({ mailItemId: retire, requestId: null }, CAMILLE, depose('retire')),
      (error) => error instanceof MailStateError && /retiré/.test(error.message),
    )
  })

  it('la base refuse les raccourcis (CA025)', async () => {
    const id = await pli()
    const depot = await recordContentDraft({ mailItemId: id, requestId: null }, CAMILLE, depose('raccourci'))
    // Publier sans ouvrir le pli.
    assert.equal(
      await refusParLaBase(() =>
        asTenant((tx) => tx.execute(sql`update mail_scans set pending_validation = 0 where id = ${depot.draftId}`)),
      ),
      DB_MAIL_TEAM_REFUSED,
    )
    // Un dépôt sur un pli retiré, par un autre chemin que l'écran.
    const retire = await pli()
    await withdrawMail(retire)
    assert.equal(
      await refusParLaBase(() =>
        asTenant((tx) =>
          tx.execute(sql`
            insert into mail_scans (id, mail_item_id, side, storage_key, content_type, byte_size, pending_validation)
            values (${uuidv7()}, ${retire}, 'content', 'courrier/test/x.pdf', 'application/pdf', 5, 1)`),
        ),
      ),
      DB_MAIL_TEAM_REFUSED,
    )
    // Un contenu validé ne redevient pas « à valider » ; un dépôt purgé ne se publie plus.
    await validateContentDraft(depot.draftId, CAMILLE)
    assert.equal(
      await refusParLaBase(() =>
        asTenant((tx) => tx.execute(sql`update mail_scans set pending_validation = 1 where id = ${depot.draftId}`)),
      ),
      DB_MAIL_TEAM_REFUSED,
    )
    const autre = await pli()
    const purge = await recordContentDraft({ mailItemId: autre, requestId: null }, CAMILLE, depose('purge'))
    await recordDraftDiscard(purge.draftId)
    await asTenant((tx) => tx.execute(sql`update mail_items set status = 'opened', opened_at = current_timestamp(3), opened_by = ${CAMILLE} where id = ${autre}`))
    assert.equal(
      await refusParLaBase(() =>
        asTenant((tx) => tx.execute(sql`update mail_scans set pending_validation = 0 where id = ${purge.draftId}`)),
      ),
      DB_MAIL_TEAM_REFUSED,
    )
  })
})
