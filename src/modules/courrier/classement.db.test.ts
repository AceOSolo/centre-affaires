import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'

import { DB_INSUFFICIENT_PRIVILEGE, dbErrorCode } from '../../db/errors.ts'
import { withClientScope, withTenant, type Transaction } from '../../db/index.ts'
import { ouvrirBasesDeTest, raisonDeSaut, type TestDatabases } from '../../db/test-support.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { uuidv7 } from '../../lib/uuid.ts'
import type { ClientAccount } from '../clients/comptes.ts'
import { toutVider } from '../clients/test-support.ts'
import { classifyMail, mailFolderCounts, markMailRead } from './classement.ts'
import { findMailForAccounts, searchMailForAccounts } from './demandes-queries.ts'

/**
 * Classement du courrier côté client (ADR 044), contre la base et sous
 * l'identité applicative :
 *
 * - propre à chaque personne : ce qu'une associée range, l'autre ne le voit pas ;
 * - jamais sur le courrier d'une autre entreprise ;
 * - filtres et compteurs des rubriques ;
 * - étiquettes effacées avec la personne anonymisée.
 */
describe('classement du courrier côté client', { skip: raisonDeSaut }, () => {
  let bases: TestDatabases

  const ACCUEIL = '01a00000-0000-7000-8000-0000000f6a01'
  const DURAND = '01a00000-0000-7000-8000-0000000f6b01'
  const PETIT = '01a00000-0000-7000-8000-0000000f6b02'
  const JEANNE = '01a00000-0000-7000-8000-0000000f6c01'
  const JULES = '01a00000-0000-7000-8000-0000000f6c02'
  const PAUL = '01a00000-0000-7000-8000-0000000f6c03'

  const jeanne: ClientAccount[] = [{ memberId: JEANNE, clientId: DURAND, clientName: 'Atelier Durand' }]
  const jules: ClientAccount[] = [{ memberId: JULES, clientId: DURAND, clientName: 'Atelier Durand' }]
  const PAGE = { number: 1, size: 20 }
  const TZ = 'Europe/Paris'

  const asTenant = <T>(run: (tx: Transaction) => Promise<T>) => withTenant(DEFAULT_TENANT_ID, run, bases.app.db)
  const lire = async (text: string, params: unknown[] = []) =>
    (await bases.owner.client.query(text, params))[0] as Record<string, unknown>[]

  const pli = async (clientId: string) => {
    const id = uuidv7()
    await asTenant((tx) => tx.execute(sql`insert into mail_items (id, client_id, sender) values (${id}, ${clientId}, 'Banque')`))
    return id
  }
  const ids = async (accounts: ClientAccount[], filters: Parameters<typeof searchMailForAccounts>[1]) =>
    (await searchMailForAccounts(accounts, filters, PAGE, TZ)).rows.map((row) => row.id).sort()

  before(async () => {
    bases = await ouvrirBasesDeTest()
    ;(globalThis as { database?: unknown }).database = bases.app
  })

  beforeEach(async () => {
    await toutVider(bases.owner)
    await asTenant(async (tx) => {
      await tx.execute(sql`insert into staff_members (id, email, role) values (${ACCUEIL}, 'accueil@centre.fr', 'admin')`)
      await tx.execute(sql`
        insert into clients (id, name, status) values
          (${DURAND}, 'Atelier Durand', 'active'), (${PETIT}, 'Petit Conseil', 'active')`)
      await tx.execute(sql`
        insert into client_members (id, client_id, email, full_name, auth_user_id) values
          (${JEANNE}, ${DURAND}, 'jeanne@durand.fr', 'Jeanne Durand', 'u-jeanne'),
          (${JULES}, ${DURAND}, 'jules@durand.fr', 'Jules Durand', 'u-jules'),
          (${PAUL}, ${PETIT}, 'paul@petit.fr', 'Paul Petit', 'u-paul')`)
    })
  })

  after(async () => {
    await toutVider(bases.owner)
    delete (globalThis as { database?: unknown }).database
    await bases.fermer()
  })

  it('classe pour la personne seulement : l’associé garde son propre classement', async () => {
    const impots = await pli(DURAND)
    const autre = await pli(DURAND)
    assert.equal(await classifyMail(jeanne, [impots], { type: 'category', category: 'impots' }), 1)
    await classifyMail(jeanne, [impots, autre], { type: 'handled' })
    await classifyMail(jeanne, [impots], { type: 'addTag', tag: 'à payer' })

    const vuParJeanne = await findMailForAccounts(impots, jeanne)
    assert.equal(vuParJeanne?.classification.category, 'impots')
    assert.ok(vuParJeanne?.classification.handledAt)
    assert.ok(vuParJeanne?.classification.readAt, 'traité vaut lu')
    assert.deepEqual(vuParJeanne?.classification.tags, ['à payer'])

    const vuParJules = await findMailForAccounts(impots, jules)
    assert.deepEqual(vuParJules?.classification, { readAt: null, handledAt: null, category: null, tags: [] })
  })

  it('ignore le courrier d’une autre entreprise, même désigné par son identifiant', async () => {
    const chezPetit = await pli(PETIT)
    assert.equal(await classifyMail(jeanne, [chezPetit], { type: 'read' }), 0)
    assert.deepEqual(await lire('select id from mail_item_member_states'), [])
  })

  it('refuse, sous portée client, d’écrire le classement d’une autre entreprise', async () => {
    const chezPetit = await pli(PETIT)
    let code: string | undefined
    try {
      await withClientScope(
        DEFAULT_TENANT_ID,
        [DURAND],
        (tx) =>
          tx.execute(sql`
            insert into mail_item_member_states (id, client_id, mail_item_id, client_member_id)
            values (${uuidv7()}, ${PETIT}, ${chezPetit}, ${PAUL})`),
        bases.app.db,
      )
    } catch (error) {
      code = dbErrorCode(error)
    }
    assert.equal(code, DB_INSUFFICIENT_PRIVILEGE)
  })

  it('filtre par suivi, catégorie et étiquette', async () => {
    const [banque, impots, rien] = [await pli(DURAND), await pli(DURAND), await pli(DURAND)]
    await classifyMail(jeanne, [banque], { type: 'category', category: 'banque' })
    await classifyMail(jeanne, [impots], { type: 'category', category: 'impots' })
    await classifyMail(jeanne, [impots], { type: 'handled' })
    await classifyMail(jeanne, [banque], { type: 'addTag', tag: 'comptable' })
    await markMailRead(jeanne, banque)

    assert.deepEqual(await ids(jeanne, { followUp: 'non-lus' }), [rien])
    assert.deepEqual(await ids(jeanne, { followUp: 'a-traiter' }), [banque, rien].sort())
    assert.deepEqual(await ids(jeanne, { followUp: 'traites' }), [impots])
    assert.deepEqual(await ids(jeanne, { category: 'banque' }), [banque])
    assert.deepEqual(await ids(jeanne, { category: 'non-classe' }), [rien])
    assert.deepEqual(await ids(jeanne, { tag: 'comptable' }), [banque])
    // Le classement de Jeanne ne filtre rien pour Jules.
    assert.deepEqual(await ids(jules, { followUp: 'non-lus' }), [banque, impots, rien].sort())
  })

  it('compte les rubriques et les étiquettes de la personne', async () => {
    const [a, b, c] = [await pli(DURAND), await pli(DURAND), await pli(DURAND)]
    await pli(PETIT)
    await classifyMail(jeanne, [a, b], { type: 'category', category: 'fournisseurs' })
    await classifyMail(jeanne, [a], { type: 'handled' })
    await classifyMail(jeanne, [a, c], { type: 'addTag', tag: 'urgent' })

    const counts = await mailFolderCounts(jeanne)
    assert.equal(counts.total, 3)
    assert.equal(counts.unread, 2)
    assert.equal(counts.handled, 1)
    assert.equal(counts.toHandle, 2)
    assert.deepEqual(counts.byCategory.fournisseurs, { total: 2, unread: 1 })
    assert.deepEqual(counts.byCategory['non-classe'], { total: 1, unread: 1 })
    assert.deepEqual(counts.tags, [{ tag: 'urgent', count: 2 }])
  })

  it('efface les étiquettes de la personne anonymisée, garde le reste du classement', async () => {
    const item = await pli(DURAND)
    await classifyMail(jeanne, [item], { type: 'addTag', tag: 'dossier Martin' })
    await classifyMail(jeanne, [item], { type: 'category', category: 'juridique' })
    await asTenant(async (tx) => {
      await tx.execute(sql`update client_members set deleted_at = current_timestamp(3) where id = ${JEANNE}`)
      await tx.execute(sql`select anonymize_client_member(${JEANNE}, ${ACCUEIL}, 'erasure_request', current_date())`)
    })
    const [state] = await lire('select category, tags from mail_item_member_states where client_member_id = ?', [JEANNE])
    assert.equal(state.category, 'juridique')
    assert.deepEqual(state.tags, [])
  })
})
