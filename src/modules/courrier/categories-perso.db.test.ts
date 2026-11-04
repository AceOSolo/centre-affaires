import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'

import {
  DB_CHECK_VIOLATION,
  DB_FOREIGN_KEY_VIOLATION,
  DB_INSUFFICIENT_PRIVILEGE,
  dbErrorCode,
} from '../../db/errors.ts'
import { withClientScope, withTenant, type Transaction } from '../../db/index.ts'
import { ouvrirBasesDeTest, raisonDeSaut, type TestDatabases } from '../../db/test-support.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { uuidv7 } from '../../lib/uuid.ts'
import type { ClientAccount } from '../clients/comptes.ts'
import { toutVider } from '../clients/test-support.ts'
import {
  createCustomCategory,
  deleteCustomCategory,
  listCustomCategories,
  renameCustomCategory,
} from './categories-perso.ts'
import { MAX_CUSTOM_CATEGORIES } from './categories-perso-regles.ts'
import { classifyMail, mailFolderCounts } from './classement.ts'
import { findMailForAccounts, searchMailForAccounts } from './demandes-queries.ts'

/**
 * Catégories personnelles du courrier côté client (ADR 060), contre la base
 * et sous l'identité applicative :
 *
 * - création, renommage, limites ;
 * - suppression qui déclasse ses plis ;
 * - portée : celle du classement, l'accès d'une personne à une entreprise ;
 * - rubriques et filtres ;
 * - nom neutralisé avec la personne anonymisée.
 */
describe('catégories personnelles du courrier', { skip: raisonDeSaut }, () => {
  let bases: TestDatabases

  const ACCUEIL = '01a00000-0000-7000-8000-0000000f7a01'
  const DURAND = '01a00000-0000-7000-8000-0000000f7b01'
  const PETIT = '01a00000-0000-7000-8000-0000000f7b02'
  const JEANNE = '01a00000-0000-7000-8000-0000000f7c01'
  const JULES = '01a00000-0000-7000-8000-0000000f7c02'
  const JEANNE_PETIT = '01a00000-0000-7000-8000-0000000f7c03'
  const AUTRE_CENTRE = '01a00000-0000-7000-8000-0000000f7d01'

  const jeanne: ClientAccount[] = [{ memberId: JEANNE, clientId: DURAND, clientName: 'Atelier Durand' }]
  const jules: ClientAccount[] = [{ memberId: JULES, clientId: DURAND, clientName: 'Atelier Durand' }]
  /** Jeanne a aussi un accès à Petit Conseil : deux listes, une par entreprise. */
  const jeanneDeuxSocietes: ClientAccount[] = [
    ...jeanne,
    { memberId: JEANNE_PETIT, clientId: PETIT, clientName: 'Petit Conseil' },
  ]
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
  const creer = async (accounts: ClientAccount[], name: string, clientId = accounts[0].clientId) => {
    const result = await createCustomCategory(accounts, clientId, name)
    assert.ok(result.ok, result.ok ? undefined : result.error)
    return result.id
  }
  const ids = async (accounts: ClientAccount[], category: Parameters<typeof searchMailForAccounts>[1]['category']) =>
    (await searchMailForAccounts(accounts, { category }, PAGE, TZ)).rows.map((row) => row.id).sort()

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
          (${JEANNE_PETIT}, ${PETIT}, 'jeanne@durand.fr', 'Jeanne Durand', 'u-jeanne')`)
    })
  })

  after(async () => {
    await toutVider(bases.owner)
    await bases.owner.client.query('delete from tenants where id = ?', [AUTRE_CENTRE])
    delete (globalThis as { database?: unknown }).database
    await bases.fermer()
  })

  it('crée et liste les catégories de la personne, par ordre alphabétique', async () => {
    await creer(jeanne, '  Contrats   en cours ')
    await creer(jeanne, 'Comptable')
    const liste = await listCustomCategories(jeanne)
    assert.deepEqual(
      liste.map((entry) => [entry.name, entry.clientId, entry.mailCount]),
      [
        ['Comptable', DURAND, 0],
        ['Contrats en cours', DURAND, 0],
      ],
    )
    // L'associé ne voit rien de ses catégories.
    assert.deepEqual(await listCustomCategories(jules), [])
  })

  it('refuse un doublon à la casse près, un nom proposé, et une vingt et unième catégorie', async () => {
    await creer(jeanne, 'Comptable')
    const doublon = await createCustomCategory(jeanne, DURAND, 'COMPTABLE')
    assert.equal(doublon.ok, false)
    const proposee = await createCustomCategory(jeanne, DURAND, 'Assurances')
    assert.equal(proposee.ok, false)
    // Jules peut avoir sa propre « Comptable ».
    assert.ok((await createCustomCategory(jules, DURAND, 'Comptable')).ok)

    for (let index = 1; index < MAX_CUSTOM_CATEGORIES; index++) await creer(jeanne, `Dossier ${index}`)
    const deTrop = await createCustomCategory(jeanne, DURAND, 'Une de trop')
    assert.equal(deTrop.ok, false)
    assert.match(deTrop.ok ? '' : deTrop.error, /20 catégories au plus/)
    assert.equal((await listCustomCategories(jeanne)).length, MAX_CUSTOM_CATEGORIES)
  })

  it('refuse une entreprise qui n’est pas celle du compte', async () => {
    const result = await createCustomCategory(jeanne, PETIT, 'Comptable')
    assert.deepEqual(result, { ok: false, error: 'Entreprise introuvable dans votre espace.' })
    assert.deepEqual(await lire('select id from mail_member_categories'), [])
  })

  it('renomme une catégorie : ses plis y restent rangés', async () => {
    const comptable = await creer(jeanne, 'Comptable')
    await creer(jeanne, 'Contrats')
    const item = await pli(DURAND)
    assert.equal(await classifyMail(jeanne, [item], { type: 'customCategory', id: comptable }), 1)

    assert.deepEqual(await renameCustomCategory(jeanne, comptable, 'Expert-comptable'), {
      ok: true,
      id: comptable,
      name: 'Expert-comptable',
    })
    assert.equal((await renameCustomCategory(jeanne, comptable, 'contrats')).ok, false)
    // Changer la casse de son propre nom est permis.
    assert.ok((await renameCustomCategory(jeanne, comptable, 'expert-comptable')).ok)
    assert.equal((await findMailForAccounts(item, jeanne))?.classification.customCategoryId, comptable)
    // L'associé ne renomme pas la catégorie de Jeanne.
    assert.equal((await renameCustomCategory(jules, comptable, 'Piratée')).ok, false)
    const [row] = await lire('select name from mail_member_categories where id = ?', [comptable])
    assert.equal(row.name, 'expert-comptable')
  })

  it('supprime une catégorie : ses plis redeviennent non classés, ceux des autres ne bougent pas', async () => {
    const comptable = await creer(jeanne, 'Comptable')
    const [a, b, c] = [await pli(DURAND), await pli(DURAND), await pli(DURAND)]
    await classifyMail(jeanne, [a, b], { type: 'customCategory', id: comptable })
    await classifyMail(jeanne, [b], { type: 'addTag', tag: 'urgent' })
    await classifyMail(jeanne, [c], { type: 'category', category: 'banque' })
    await classifyMail(jules, [a], { type: 'category', category: 'impots' })

    // Jules ne la supprime pas.
    assert.equal(await deleteCustomCategory(jules, comptable), null)
    assert.deepEqual(await deleteCustomCategory(jeanne, comptable), { name: 'Comptable', declassified: 2 })

    assert.deepEqual(await lire('select id from mail_member_categories'), [])
    assert.deepEqual(await ids(jeanne, 'non-classe'), [a, b].sort())
    const deB = await findMailForAccounts(b, jeanne)
    assert.equal(deB?.classification.customCategoryId, null)
    assert.deepEqual(deB?.classification.tags, ['urgent'], 'les étiquettes restent')
    assert.equal((await findMailForAccounts(c, jeanne))?.classification.category, 'banque')
    assert.equal((await findMailForAccounts(a, jules))?.classification.category, 'impots')
  })

  it('range dans les rubriques et filtre la boîte aux lettres', async () => {
    const comptable = await creer(jeanne, 'Comptable')
    const vide = await creer(jeanne, 'Vide')
    const [a, b, c] = [await pli(DURAND), await pli(DURAND), await pli(DURAND)]
    await classifyMail(jeanne, [a, b], { type: 'customCategory', id: comptable })
    await classifyMail(jeanne, [a], { type: 'read' })
    await classifyMail(jeanne, [c], { type: 'category', category: 'banque' })

    const counts = await mailFolderCounts(jeanne)
    assert.deepEqual(
      counts.custom.map((entry) => [entry.id, entry.name, entry.total, entry.unread]),
      [
        [comptable, 'Comptable', 2, 1],
        [vide, 'Vide', 0, 0],
      ],
    )
    assert.deepEqual(counts.byCategory.banque, { total: 1, unread: 1 })
    assert.deepEqual(counts.byCategory['non-classe'], { total: 0, unread: 0 })
    assert.equal(counts.total, 3)

    assert.deepEqual(await ids(jeanne, comptable as never), [a, b].sort())
    assert.deepEqual(await ids(jeanne, 'banque'), [c])
    assert.deepEqual(await ids(jeanne, 'non-classe'), [])
    // Pour Jules, la catégorie de Jeanne ne range rien.
    assert.deepEqual(await ids(jules, comptable as never), [])
  })

  it('ne range que le courrier de l’entreprise de la catégorie, et jamais avec celle d’un autre', async () => {
    const chezDurand = await creer(jeanneDeuxSocietes, 'Comptable', DURAND)
    const [pliDurand, pliPetit] = [await pli(DURAND), await pli(PETIT)]
    assert.equal(
      await classifyMail(jeanneDeuxSocietes, [pliDurand, pliPetit], { type: 'customCategory', id: chezDurand }),
      1,
    )
    assert.equal((await findMailForAccounts(pliPetit, jeanneDeuxSocietes))?.classification.customCategoryId, null)
    // Jules ne range rien avec la catégorie de Jeanne.
    assert.equal(await classifyMail(jules, [pliDurand], { type: 'customCategory', id: chezDurand }), 0)

    // La base le tient aussi : un classement ne vise que la catégorie de sa personne.
    let code: string | undefined
    try {
      await asTenant((tx) =>
        tx.execute(sql`
          insert into mail_item_member_states (id, client_id, mail_item_id, client_member_id, custom_category_id)
          values (${uuidv7()}, ${DURAND}, ${pliDurand}, ${JULES}, ${chezDurand})`),
      )
    } catch (error) {
      code = dbErrorCode(error)
    }
    assert.equal(code, DB_FOREIGN_KEY_VIOLATION)
  })

  it('refuse une catégorie proposée et une catégorie personnelle sur le même pli', async () => {
    const comptable = await creer(jeanne, 'Comptable')
    const item = await pli(DURAND)
    let code: string | undefined
    try {
      await asTenant((tx) =>
        tx.execute(sql`
          insert into mail_item_member_states (id, client_id, mail_item_id, client_member_id, category, custom_category_id)
          values (${uuidv7()}, ${DURAND}, ${item}, ${JEANNE}, 'banque', ${comptable})`),
      )
    } catch (error) {
      code = dbErrorCode(error)
    }
    assert.equal(code, DB_CHECK_VIOLATION)
  })

  it('refuse, sous portée client, d’écrire la catégorie d’une autre entreprise', async () => {
    let code: string | undefined
    try {
      await withClientScope(
        DEFAULT_TENANT_ID,
        [DURAND],
        (tx) =>
          tx.execute(sql`
            insert into mail_member_categories (id, client_id, client_member_id, name)
            values (${uuidv7()}, ${PETIT}, ${JEANNE_PETIT}, 'Intrus')`),
        bases.app.db,
      )
    } catch (error) {
      code = dbErrorCode(error)
    }
    assert.equal(code, DB_INSUFFICIENT_PRIVILEGE)
  })

  it('ne lit que les catégories du centre courant', async () => {
    await creer(jeanne, 'Comptable')
    await bases.owner.client.query(
      `insert into tenants (id, name, slug) values (?, 'Autre centre', 'autre-centre-categories')
       on duplicate key update id = id`,
      [AUTRE_CENTRE],
    )
    // Une ligne d'un autre centre qui porterait les mêmes identifiants (copie, import) n'apparaît pas.
    const connection = await bases.owner.client.getConnection()
    try {
      await connection.query('set foreign_key_checks = 0')
      await connection.query(
        `insert into mail_member_categories (id, tenant_id, client_id, client_member_id, name)
         values (?, ?, ?, ?, 'Autre centre')`,
        [uuidv7(), AUTRE_CENTRE, DURAND, JEANNE],
      )
    } finally {
      await connection.query('set foreign_key_checks = 1')
      connection.release()
    }
    assert.deepEqual(
      (await listCustomCategories(jeanne)).map((entry) => entry.name),
      ['Comptable'],
    )
    assert.deepEqual(
      (await mailFolderCounts(jeanne)).custom.map((entry) => entry.name),
      ['Comptable'],
    )
  })

  it('neutralise le nom des catégories de la personne anonymisée, garde son classement', async () => {
    const comptable = await creer(jeanne, 'Dossier Martin')
    const item = await pli(DURAND)
    await classifyMail(jeanne, [item], { type: 'customCategory', id: comptable })
    await asTenant(async (tx) => {
      await tx.execute(sql`update client_members set deleted_at = current_timestamp(3) where id = ${JEANNE}`)
      await tx.execute(sql`select anonymize_client_member(${JEANNE}, ${ACCUEIL}, 'erasure_request', current_date())`)
    })
    const [category] = await lire('select name from mail_member_categories where id = ?', [comptable])
    assert.match(String(category.name), /^Catégorie [0-9a-f]{12}$/)
    const [state] = await lire('select custom_category_id from mail_item_member_states where client_member_id = ?', [JEANNE])
    assert.equal(state.custom_category_id, comptable)
  })
})
