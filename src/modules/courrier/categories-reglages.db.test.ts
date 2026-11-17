import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'

import { sql } from 'drizzle-orm'

import { DB_CLIENT_MAIL_REFUSED, DB_INSUFFICIENT_PRIVILEGE, dbErrorCode } from '../../db/errors.ts'
import { withClientScope, withTenant, type Transaction } from '../../db/index.ts'
import { ouvrirBasesDeTest, raisonDeSaut, type TestDatabases } from '../../db/test-support.ts'
import { DEFAULT_TENANT_ID } from '../../db/tenants.ts'
import { uuidv7 } from '../../lib/uuid.ts'
import type { ClientAccount } from '../clients/comptes.ts'
import { toutVider } from '../clients/test-support.ts'
import { createCustomCategory } from './categories-perso.ts'
import { listCentreCategories, loadCategoryLists, saveCentreCategories, savePersonCategories } from './categories-reglages.ts'
import type { CategoryEntry } from './categories-reglages-regles.ts'
import { mailCategories } from './categories.ts'

/**
 * Catégories du courrier réglées par le centre et par chaque personne
 * (ADR 078), contre la base et sous l'identité applicative :
 *
 * - le centre renomme, masque, ordonne ses catégories ; la personne fait de
 *   même pour elle seule, ses associés et le centre gardent les leurs ;
 * - jamais d'écriture du réglage du centre sous portée client, ni du réglage
 *   d'une autre entreprise ; un réglage reste celui de sa personne (`CA024`) ;
 * - les noms donnés s'effacent avec la personne anonymisée.
 */
describe('catégories du courrier réglables', { skip: raisonDeSaut }, () => {
  let bases: TestDatabases

  const ACCUEIL = '01a00000-0000-7000-8000-0000000f7a01'
  const DURAND = '01a00000-0000-7000-8000-0000000f7b01'
  const PETIT = '01a00000-0000-7000-8000-0000000f7b02'
  const JEANNE = '01a00000-0000-7000-8000-0000000f7c01'
  const JULES = '01a00000-0000-7000-8000-0000000f7c02'
  const PAUL = '01a00000-0000-7000-8000-0000000f7c03'

  const jeanne: ClientAccount[] = [{ memberId: JEANNE, clientId: DURAND, clientName: 'Atelier Durand' }]
  const jules: ClientAccount[] = [{ memberId: JULES, clientId: DURAND, clientName: 'Atelier Durand' }]

  const asTenant = <T>(run: (tx: Transaction) => Promise<T>) => withTenant(DEFAULT_TENANT_ID, run, bases.app.db)
  const lire = async (text: string, params: unknown[] = []) =>
    (await bases.owner.client.query(text, params))[0] as Record<string, unknown>[]
  const listOf = async (accounts: ClientAccount[]) => (await loadCategoryLists(accounts)).get(DURAND) as CategoryEntry[]
  /** La liste telle que l'écran l'envoie, modifiée par `change`. */
  const inputs = (list: CategoryEntry[], change: (entry: CategoryEntry) => Partial<CategoryEntry> = () => ({})) =>
    list.map((entry) => ({ key: entry.key, name: entry.name, hidden: entry.hidden, ...change(entry) }))
  const codeAttendu = async (run: () => Promise<unknown>) => {
    try {
      await run()
    } catch (error) {
      return dbErrorCode(error)
    }
    return undefined
  }

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

  it('sans réglage : la liste du code, puis les catégories de la personne', async () => {
    const created = await createCustomCategory(jeanne, DURAND, 'Comptable')
    assert.ok(created.ok)
    const list = await listOf(jeanne)
    assert.deepEqual(
      list.map((entry) => entry.key),
      [...mailCategories, created.id],
    )
    assert.equal(list[0].name, 'Impôts et taxes')
  })

  it('le centre renomme, masque et ordonne ; chaque client le voit, sans rien écrire chez lui', async () => {
    const centre = await listCentreCategories(bases.app.db)
    const order = ['publicite', ...centre.map((entry) => entry.category).filter((key) => key !== 'publicite')]
    const saved = await saveCentreCategories(
      order.map((key) => ({
        key,
        name: key === 'publicite' ? 'Prospectus' : (centre.find((entry) => entry.category === key)?.name ?? ''),
        hidden: key === 'autre',
      })),
      bases.app.db,
    )
    assert.deepEqual(saved, { ok: true })
    const list = await listOf(jeanne)
    assert.equal(list[0].key, 'publicite')
    assert.equal(list[0].name, 'Prospectus')
    assert.equal(list.find((entry) => entry.key === 'autre')?.hidden, true)
    assert.deepEqual(await lire('select id from mail_member_category_prefs'), [])
    // Un nom pris deux fois est refusé, champ par champ.
    const twice = await saveCentreCategories(
      centre.map((entry) => ({ key: entry.category, name: entry.category === 'banque' ? 'Clients' : entry.name, hidden: false })),
      bases.app.db,
    )
    assert.equal(twice.ok, false)
    assert.ok(!twice.ok && twice.fieldErrors?.['nom-banque'])
  })

  it('la personne renomme, masque et ordonne pour elle seule ; le centre et son associé gardent les leurs', async () => {
    const created = await createCustomCategory(jeanne, DURAND, 'Comptable')
    assert.ok(created.ok)
    const list = await listOf(jeanne)
    const keys = list.map((entry) => entry.key)
    const reordered = [created.id, ...keys.filter((key) => key !== created.id)]
    const saved = await savePersonCategories(
      jeanne,
      DURAND,
      reordered.map((key) => {
        const entry = list.find((candidate) => candidate.key === key) as CategoryEntry
        return { key, name: key === 'impots' ? 'Fisc' : entry.name, hidden: key === 'publicite' }
      }),
    )
    assert.deepEqual(saved, { ok: true })

    const mine = await listOf(jeanne)
    assert.equal(mine[0].key, created.id, 'sa catégorie en tête')
    assert.equal(mine.find((entry) => entry.key === 'impots')?.name, 'Fisc')
    assert.equal(mine.find((entry) => entry.key === 'impots')?.centreName, 'Impôts et taxes')
    assert.equal(mine.find((entry) => entry.key === 'publicite')?.hidden, true)

    const his = await listOf(jules)
    assert.equal(his[0].key, 'impots')
    assert.equal(his[0].name, 'Impôts et taxes')
    assert.equal((await listCentreCategories(bases.app.db))[0].name, 'Impôts et taxes')

    // Revenir à l'état de départ efface les réglages : rien ne diffère du centre.
    const back = await savePersonCategories(
      jeanne,
      DURAND,
      [...mailCategories.map((key) => ({ key, name: list.find((entry) => entry.key === key)?.name ?? '', hidden: false })), { key: created.id, name: 'Comptable', hidden: false }],
    )
    assert.deepEqual(back, { ok: true })
    assert.deepEqual(await lire('select id from mail_member_category_prefs'), [])
  })

  it('échange deux noms de catégories personnelles sans heurter leur unicité', async () => {
    const a = await createCustomCategory(jeanne, DURAND, 'Comptable')
    const b = await createCustomCategory(jeanne, DURAND, 'Avocat')
    assert.ok(a.ok && b.ok)
    const list = await listOf(jeanne)
    const saved = await savePersonCategories(
      jeanne,
      DURAND,
      inputs(list, (entry) =>
        entry.key === a.id ? { name: 'Avocat' } : entry.key === b.id ? { name: 'Comptable' } : {},
      ),
    )
    assert.deepEqual(saved, { ok: true })
    const names = await lire('select id, name from mail_member_categories order by name')
    assert.deepEqual(names, [
      { id: a.id, name: 'Avocat' },
      { id: b.id, name: 'Comptable' },
    ])
  })

  it('refuse une liste périmée : une catégorie créée dans un autre onglet', async () => {
    const list = await listOf(jeanne)
    await createCustomCategory(jeanne, DURAND, 'Comptable')
    const saved = await savePersonCategories(jeanne, DURAND, inputs(list))
    assert.equal(saved.ok, false)
    assert.match((!saved.ok && saved.error) || '', /rechargez la page/)
  })

  it('une catégorie à soi ne peut pas reprendre le nom d’une proposée, sous le nom que la personne lui voit', async () => {
    const list = await listOf(jeanne)
    await savePersonCategories(jeanne, DURAND, inputs(list, (entry) => (entry.key === 'impots' ? { name: 'Fisc' } : {})))
    const fisc = await createCustomCategory(jeanne, DURAND, 'fisc')
    assert.equal(fisc.ok, false)
    // « Impôts et taxes » est libre pour Jeanne, qui l'a renommée ; pas pour Jules.
    assert.ok((await createCustomCategory(jeanne, DURAND, 'Impôts et taxes')).ok)
    assert.equal((await createCustomCategory(jules, DURAND, 'Impôts et taxes')).ok, false)
  })

  it('sous portée client : ni le réglage du centre, ni celui d’une autre entreprise', async () => {
    assert.equal(
      await codeAttendu(() =>
        withClientScope(
          DEFAULT_TENANT_ID,
          [DURAND],
          (tx) => tx.execute(sql`insert into mail_category_defaults (id, category, name) values (${uuidv7()}, 'impots', 'Fisc')`),
          bases.app.db,
        ),
      ),
      DB_INSUFFICIENT_PRIVILEGE,
    )
    assert.equal(
      await codeAttendu(() =>
        withClientScope(
          DEFAULT_TENANT_ID,
          [DURAND],
          (tx) =>
            tx.execute(sql`
              insert into mail_member_category_prefs (id, client_id, client_member_id, category, name)
              values (${uuidv7()}, ${PETIT}, ${PAUL}, 'impots', 'Fisc')`),
          bases.app.db,
        ),
      ),
      DB_INSUFFICIENT_PRIVILEGE,
    )
    // Par l'application : une entreprise hors du compte n'est pas réglée.
    const outside = await savePersonCategories(jeanne, PETIT, [])
    assert.equal(outside.ok, false)
  })

  it('un réglage reste celui de sa personne et de sa catégorie (CA024)', async () => {
    const list = await listOf(jeanne)
    await savePersonCategories(jeanne, DURAND, inputs(list, (entry) => (entry.key === 'impots' ? { name: 'Fisc' } : {})))
    assert.equal(
      await codeAttendu(() =>
        asTenant((tx) => tx.execute(sql`update mail_member_category_prefs set client_member_id = ${JULES}`)),
      ),
      DB_CLIENT_MAIL_REFUSED,
    )
    assert.equal(
      await codeAttendu(() => asTenant((tx) => tx.execute(sql`update mail_member_category_prefs set category = 'banque'`))),
      DB_CLIENT_MAIL_REFUSED,
    )
  })

  it('les noms donnés par la personne s’effacent avec elle ; masquage et rang restent', async () => {
    const list = await listOf(jeanne)
    await savePersonCategories(
      jeanne,
      DURAND,
      inputs(list, (entry) => (entry.key === 'impots' ? { name: 'Dossier Martin', hidden: true } : {})),
    )
    await asTenant(async (tx) => {
      await tx.execute(sql`update client_members set deleted_at = current_timestamp(3) where id = ${JEANNE}`)
      await tx.execute(sql`select anonymize_client_member(${JEANNE}, ${ACCUEIL}, 'erasure_request', current_date())`)
    })
    const [pref] = await lire('select name, hidden from mail_member_category_prefs where client_member_id = ?', [JEANNE])
    assert.equal(pref.name, null)
    assert.equal(Number(pref.hidden), 1)
  })
})
