import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Pool, PoolConnection } from 'mysql2/promise'

/**
 * Migrateur : deux dossiers, appliqués dans cet ordre.
 *
 * 1. `src/db/migrations/` — structure (tables, index, clés étrangères),
 *    **générée par `drizzle-kit generate`** depuis le schéma Drizzle. Chaque
 *    fichier n'est appliqué qu'une fois et ne s'édite plus ensuite.
 *
 * 2. `src/db/regles/` — ce que Drizzle ne décrit pas : règles métier (triggers
 *    `SIGNAL`), procédures et fonctions stockées, ligne du centre unique. Ces
 *    fichiers sont **idempotents** (`DROP … IF EXISTS` puis `CREATE`) et se
 *    rejouent dès que leur contenu change — ils s'éditent librement.
 *
 * Puis deux familles de triggers sont générées, table par table :
 *
 * - `<table>_set_updated_at` : tient `updated_at` à jour sur toute table qui
 *   porte cette colonne ;
 * - `<table>_guard_tenant_insert` / `_update` : sur toute table qui porte
 *   `tenant_id`, refusent (`CA014`) d'écrire pour un autre centre que celui de
 *   `@app_tenant_id`, posée par `withTenant()`. C'est ce qui reste de la RLS
 *   d'écriture (ADR 042).
 *
 * Les instructions d'un fichier sont séparées par `--> statement-breakpoint`,
 * le marqueur de Drizzle : un trigger ou une procédure tient en une seule
 * instruction envoyée telle quelle, sans `DELIMITER`.
 */
const BREAKPOINT = '--> statement-breakpoint'

export type MigrationReport = {
  structure: string[]
  regles: string[]
  /** Triggers générés : `updated_at` et gardes de centre. */
  triggers: number
}

function statements(sqlText: string): string[] {
  return sqlText
    .split(BREAKPOINT)
    .map((part) => part.trim())
    .filter((part) => part.replace(/--[^\n]*/g, '').trim() !== '')
}

function sqlFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.sql'))
      .sort()
  } catch {
    return []
  }
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex')

export async function migrate(
  pool: Pool,
  options: { structure?: string; regles?: string } = {},
): Promise<MigrationReport> {
  const structureDir = options.structure ?? join(process.cwd(), 'src', 'db', 'migrations')
  const reglesDir = options.regles ?? join(process.cwd(), 'src', 'db', 'regles')
  const report: MigrationReport = { structure: [], regles: [], triggers: 0 }

  const connection: PoolConnection = await pool.getConnection()
  try {
    // Un seul migrateur à la fois : deux déploiements simultanés ne doivent
    // pas jouer les mêmes instructions.
    const [[lock]] = (await connection.query("select get_lock('centre_affaires_migrer', 60) as ok")) as unknown as [
      [{ ok: number }],
    ]
    if (lock.ok !== 1) throw new Error('Migration déjà en cours (verrou non obtenu en 60 s).')

    await connection.query(`
      create table if not exists __migrations (
        name varchar(255) not null primary key,
        checksum char(64) not null,
        applied_at datetime(3) not null default current_timestamp(3)
      )`)
    const [rows] = (await connection.query('select name, checksum from __migrations')) as unknown as [
      { name: string; checksum: string }[],
    ]
    const known = new Map(rows.map((row) => [row.name, row.checksum]))

    for (const file of sqlFiles(structureDir)) {
      const key = `structure/${file}`
      if (known.has(key)) continue
      const text = readFileSync(join(structureDir, file), 'utf8')
      for (const statement of statements(text)) await connection.query(statement)
      await connection.query('insert into __migrations (name, checksum) values (?, ?)', [key, sha(text)])
      report.structure.push(file)
    }

    for (const file of sqlFiles(reglesDir)) {
      const key = `regles/${file}`
      const text = readFileSync(join(reglesDir, file), 'utf8')
      const checksum = sha(text)
      if (known.get(key) === checksum) continue
      for (const statement of statements(text)) await connection.query(statement)
      await connection.query(
        `insert into __migrations (name, checksum) values (?, ?)
         on duplicate key update checksum = values(checksum), applied_at = current_timestamp(3)`,
        [key, checksum],
      )
      report.regles.push(file)
    }

    // `updated_at` tenu en base plutôt que dans le code : une mise à jour par
    // SQL direct ou par un script d'import reste datée correctement.
    const [tables] = (await connection.query(
      `select c.table_name as name
         from information_schema.columns c
         join information_schema.tables t
           on t.table_schema = c.table_schema and t.table_name = c.table_name
        where c.table_schema = database() and c.column_name = 'updated_at'
          and t.table_type = 'BASE TABLE'`,
    )) as unknown as [{ name: string }[]]
    const [existing] = (await connection.query(
      `select trigger_name as name from information_schema.triggers
        where trigger_schema = database() and trigger_name like '%\\_set\\_updated\\_at'`,
    )) as unknown as [{ name: string }[]]
    const present = new Set(existing.map((row) => row.name))
    for (const { name } of tables) {
      const trigger = `${name}_set_updated_at`
      if (present.has(trigger)) continue
      await connection.query(
        `create trigger \`${trigger}\` before update on \`${name}\`
         for each row set new.updated_at = current_timestamp(3)`,
      )
      report.triggers++
    }

    // Garde d'écriture par centre : voir l'en-tête.
    const [tenantTables] = (await connection.query(
      `select c.table_name as name
         from information_schema.columns c
         join information_schema.tables t
           on t.table_schema = c.table_schema and t.table_name = c.table_name
        where c.table_schema = database() and c.column_name = 'tenant_id'
          and t.table_type = 'BASE TABLE'`,
    )) as unknown as [{ name: string }[]]
    const [guards] = (await connection.query(
      `select trigger_name as name from information_schema.triggers
        where trigger_schema = database() and trigger_name like '%\\_guard\\_tenant\\_%'`,
    )) as unknown as [{ name: string }[]]
    const guarded = new Set(guards.map((row) => row.name))
    for (const { name } of tenantTables) {
      for (const event of ['insert', 'update'] as const) {
        const trigger = `${name}_guard_tenant_${event}`
        if (guarded.has(trigger)) continue
        await connection.query(
          `create trigger \`${trigger}\` before ${event} on \`${name}\`
           for each row
           begin
             if @app_tenant_id is not null and new.tenant_id <> @app_tenant_id then
               signal sqlstate '45000'
                 set message_text = 'CA014: écriture refusée : cette ligne appartient à un autre centre.';
             end if;
           end`,
        )
        report.triggers++
      }
    }
  } finally {
    await connection.query("select release_lock('centre_affaires_migrer')").catch(() => {})
    connection.release()
  }
  return report
}
