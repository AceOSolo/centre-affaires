import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import { migrate } from 'drizzle-orm/postgres-js/migrator'

import { createDatabase } from './index.ts'

/**
 * Le catalogue de la base tient les règles de `CLAUDE.md` et de l'ADR 019 pour
 * toute table, présente ou à venir — une table oubliée échoue ici, avant
 * d'exposer un centre à un autre ou une entreprise à sa voisine :
 *
 * - toute table métier (`tenant_id`) a la RLS activée et forcée, et une
 *   politique d'isolation par centre ;
 * - toute table qui porte `client_id` a une politique RESTRICTIVE qui lit la
 *   portée client (`current_client_ids()`) ;
 * - toute fonction SECURITY DEFINER fige son `search_path` ;
 * - les tables de la vague 3 ne se suppriment pas depuis l'application
 *   (décision 6).
 */
const ownerUrl = process.env.TEST_OWNER_DATABASE_URL ?? process.env.DATABASE_URL
const appUrl = process.env.TEST_DATABASE_URL

const raison = !appUrl
  ? 'TEST_DATABASE_URL non défini'
  : !ownerUrl
    ? 'TEST_OWNER_DATABASE_URL non défini'
    : false

describe('catalogue : isolation et conservation', { skip: raison }, () => {
  const owner = createDatabase(ownerUrl ?? '', { onnotice: () => {} })

  before(async () => {
    await migrate(owner.db, { migrationsFolder: './src/db/migrations' })
  })

  after(async () => {
    await owner.client.end()
  })

  const tablesAvec = (colonne: string) => owner.client`
    select c.relname as table, c.relrowsecurity as rls, c.relforcerowsecurity as forcee, c.oid
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
       and exists (
         select 1 from pg_attribute a
          where a.attrelid = c.oid and a.attname = ${colonne} and not a.attisdropped)
     order by c.relname`

  it('active et force la RLS, avec l’isolation par centre, sur toute table métier', async () => {
    const tables = await tablesAvec('tenant_id')
    assert.ok(tables.length > 30, `${tables.length} tables seulement`)
    const fautives: string[] = []
    for (const table of tables) {
      const [politique] = await owner.client`
        select count(*)::int as n from pg_policy
         where polrelid = ${table.oid} and polpermissive
           and pg_get_expr(polqual, polrelid) like '%current_tenant_id()%'`
      if (!table.rls || !table.forcee || politique.n === 0) fautives.push(table.table)
    }
    assert.deepEqual(fautives, [])
  })

  it('pose la portée client RESTRICTIVE sur toute table qui porte client_id', async () => {
    const tables = await tablesAvec('client_id')
    assert.ok(
      tables.some((table) => table.table === 'mail_requests') &&
        tables.some((table) => table.table === 'inspections'),
    )
    const fautives: string[] = []
    for (const table of tables) {
      const [politique] = await owner.client`
        select count(*)::int as n from pg_policy
         where polrelid = ${table.oid} and not polpermissive and polcmd = '*'
           and pg_get_expr(polqual, polrelid) like '%current_client_ids()%'
           and pg_get_expr(polwithcheck, polrelid) like '%current_client_ids()%'`
      if (politique.n === 0) fautives.push(table.table)
    }
    assert.deepEqual(fautives, [])
  })

  it('pose une politique restrictive sur chaque table de la vague 3 qui relève d’un client ou du seul back-office', async () => {
    const tables = [
      'mail_requests',
      'notification_templates',
      'notification_deliveries',
      'notification_preferences',
      'inspection_templates',
      'inspection_template_versions',
      'inspections',
      'inspection_photos',
      'inspection_photo_views',
    ]
    const rows = await owner.client`
      select c.relname as table, count(p.oid)::int as n
        from pg_class c
        left join pg_policy p on p.polrelid = c.oid and not p.polpermissive
       where c.relname in ${owner.client(tables)}
       group by c.relname`
    assert.deepEqual(
      rows.filter((row) => row.n === 0).map((row) => row.table),
      [],
    )
    assert.equal(rows.length, tables.length)
  })

  it('fige le search_path de toute fonction SECURITY DEFINER', async () => {
    const fautives = await owner.client`
      select p.proname
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prosecdef
         and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) as c where c like 'search_path=%')
       order by 1`
    assert.deepEqual(
      fautives.map((row) => row.proname),
      [],
    )
  })

  it('ne laisse pas l’application supprimer les lignes de la vague 3', async () => {
    const tables = [
      'mail_requests',
      'notification_templates',
      'notification_deliveries',
      'notification_preferences',
      'inspection_templates',
      'inspection_template_versions',
      'inspections',
      'inspection_photos',
      'inspection_photo_views',
    ]
    const rows = await owner.client`
      select t as table, has_table_privilege('app_centre', t, 'DELETE') as supprime
        from unnest(${tables}::text[]) as t`
    assert.deepEqual(
      rows.filter((row) => row.supprime).map((row) => row.table),
      [],
    )
  })
})
