# Migration Neon/PostgreSQL → MySQL : conventions

Document de travail de la migration (ADR 042). Il fixe **comment** traduire ;
il est la référence commune de tous ceux qui touchent au code.

## 1. Cible

- **MySQL 8.0.16+** (testé sur 8.4), `InnoDB`, `utf8mb4`, collation
  `utf8mb4_0900_as_ci` (insensible à la casse, **sensible aux accents**).
- Driver `mysql2`, Drizzle `drizzle-orm/mysql-core` + `drizzle-orm/mysql2`.
- Connexion par variables `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`,
  `DB_PASSWORD` (+ `DB_ADMIN_USER`, `DB_ADMIN_PASSWORD` pour les migrations).
- Authentification : Better Auth auto-hébergé (`src/lib/auth/`), tables `auth_*`.
- Stockage de fichiers : S3 (variables `S3_*`), inchangé dans son principe.
- **Base vide + seed de démo** : aucune donnée à migrer. Les 44 migrations
  PostgreSQL disparaissent ; la structure est regénérée par drizzle-kit depuis
  le schéma, les règles métier vivent dans `src/db/regles/*.sql`.

## 2. Ce qui est déjà posé (ne pas réécrire, signaler un besoin)

| Fichier | Rôle |
|---|---|
| `src/db/index.ts` | `createDatabase`, `withTenant`, `withClientScope`, `scopeClientIds`, `Transaction`, `Database` |
| `src/db/columns.ts` | `primaryKeyId()`, `timestamps()`, `deletedAt()`, `instant(name)`, `maintenant()` |
| `src/db/contexte.ts` | `tenantContext` (AsyncLocalStorage du centre courant) |
| `src/db/tenants.ts` | `tenants`, `tenantId()`, `DEFAULT_TENANT_ID` — **modèle de conversion d'un schéma** |
| `src/db/errors.ts` | `dbErrorCode`, `dbConstraintName`, constantes `DB_*` |
| `src/db/returning.ts` | `insertReturning`, `insertManyReturning`, `updateReturning`, `deleteReturning` |
| `src/db/migrer.ts` | migrateur (structure générée + règles rejouables + triggers `updated_at`) |
| `src/db/test-support.ts` | `raisonDeSaut`, `ouvrirBasesDeTest()`, `viderTables()` |
| `src/lib/uuid.ts` | `isUuid`, `uuidv7` |
| `src/lib/auth/*` | Better Auth (server, client, schema, session) |

## 3. Schéma Drizzle : pg-core → mysql-core

Les **noms de propriétés TypeScript et les noms de colonnes SQL ne changent
pas** (le code appelant en dépend). On ne change que la déclaration.

| PostgreSQL | MySQL |
|---|---|
| `pgTable` | `mysqlTable` |
| `uuid('x')` | `char('x', { length: 36 })` |
| `primaryKeyId()` | inchangé (déjà converti) |
| `tenantId()` | inchangé |
| `timestamp('x', { withTimezone: true })` | `instant('x')` (de `src/db/columns.ts`) |
| `.defaultNow()` | `.default(sql\`CURRENT_TIMESTAMP(3)\`)` |
| `integer` | `int` |
| `smallint`, `bigint`, `boolean`, `date`, `time`, `char` | idem (`drizzle-orm/mysql-core`). `date`/`time` : garder le `mode` utilisé |
| `text` **indexé, unique, clé étrangère ou avec `default`** | `varchar('x', { length: N })`, N le plus petit raisonnable (≤ 255 si indexé) |
| `text` libre | `text` (MySQL interdit `default` sur `text` : passer en `varchar` ou `sql\`('valeur')\``) |
| `jsonb` | `json` ; défaut : `.default(sql\`(JSON_OBJECT())\`)` / `(JSON_ARRAY())` |
| `pgEnum('n', vals)` + `n('col')` | `export const nEnum = (name: string) => mysqlEnum(name, vals)` — l'appel `nEnum('col')` ne change pas |
| `numeric` | `decimal` (ou, de préférence, entier en centimes) |
| tableaux `text('x').array()` | `json` typé `string[]` |
| `.returning()` | voir §5 |
| index partiel `.where(sql\`deleted_at is null\`)` | colonne générée + index unique, voir §3.1 |
| `check(name, sql\`…\`)` | idem ; `~ 'rx'` → `REGEXP_LIKE(col, 'rx', 'c')` (**`'c'` obligatoire** : la collation est insensible à la casse) ; `btrim` → `trim` ; pas de sous-requête ni de fonction non déterministe |
| `foreignKey`, `unique`, `index`, `uniqueIndex` | idem. Les clés étrangères composites `(tenant_id, id)` restent |
| `onDelete: 'cascade' / 'restrict' / 'set null'` | idem |
| `AnyPgColumn` | `AnyMySqlColumn` |

Propriétés à connaître :

- **Une colonne de clé étrangère doit avoir exactement le type de la colonne
  référencée** : `char(36)` partout pour les identifiants.
- Index `unique` sur colonne **nullable** : MySQL autorise plusieurs `NULL`,
  comme PostgreSQL.
- Longueur d'index : `varchar(255)` en `utf8mb4` = 1020 octets, sous la limite
  de 3072. Les index composites de plusieurs `varchar(255)` peuvent la dépasser :
  réduire les longueurs.
- Pas de `CHECK` sur une colonne utilisée par une action de clé étrangère
  `CASCADE`/`SET NULL` (MySQL refuse).
- Pas de contrainte `DEFERRABLE`.

### 3.1 Index uniques partiels

PostgreSQL : `unique (tenant_id, code) where deleted_at is null`.

MySQL : une colonne générée vaut `1` quand la ligne est « vivante » et `NULL`
sinon ; un index unique ignore les `NULL`.

```ts
live: tinyint('live').generatedAlwaysAs(sql`if(deleted_at is null, 1, null)`, { mode: 'virtual' }),
// …
uniqueIndex('resources_tenant_code_key').on(table.tenantId, table.code, table.live),
```

La colonne générée **ne fait pas partie des valeurs à insérer** (Drizzle
l'exclut de `$inferInsert`). Nommer ces colonnes `live` (ou `<condition>_live`
si plusieurs conditions coexistent sur la table). Pour une condition autre que
`deleted_at is null`, adapter l'expression (`if(status <> 'cancelled', 1, null)`).
Pour une valeur extraite d'un `json`, une colonne générée aussi :
`varchar('numero_key', {length: 64}).generatedAlwaysAs(sql\`json_unquote(json_extract(attributes, '$.numero'))\`, { mode: 'virtual' })`.

Un index partiel **non unique** (performance seulement) devient un index
ordinaire.

## 4. SQL des règles métier : `src/db/regles/NN-<module>.sql`

Chaque module écrit **un fichier** `src/db/regles/<NN>-<module>.sql`
(`NN` = 10 ressources, 20 reservations, 30 clients, 40 contrats, 50 facturation,
60 courrier, 70 notifications, 80 etats-des-lieux, 90 rgpd, 05 fondations…).

- **Idempotent** : `DROP TRIGGER IF EXISTS`, `DROP FUNCTION IF EXISTS`,
  `DROP PROCEDURE IF EXISTS`, puis `CREATE …`.
- Instructions séparées par une ligne `--> statement-breakpoint`. Un trigger ou
  une routine tient en **une** instruction `CREATE … BEGIN … END`, **sans
  `DELIMITER`**.
- Les commentaires `-- …` sont autorisés (espace après `--`).
- **Les tables sont créées avant** : les routines peuvent référencer n'importe
  quelle table du schéma.

### Traduction

| PostgreSQL | MySQL |
|---|---|
| `RAISE EXCEPTION … USING ERRCODE = 'CA009'` | `SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'CA009: <message en français>';` — le **préfixe `CAnnn:`** est ce que lit `dbErrorCode()` |
| Contrainte d'exclusion `bookings_no_overlap` | trigger `BEFORE INSERT` et `BEFORE UPDATE` : `SELECT … FOR UPDATE` sur la ressource (sérialise), puis `SELECT COUNT(*) … FOR UPDATE` sur les réservations qui chevauchent (`[)` : `starts_at < NEW.ends_at AND ends_at > NEW.starts_at`, `status <> 'cancelled'`, `id <> NEW.id`), `SIGNAL 'CA000: …'` s'il y en a |
| `current_setting('app.tenant_id')` / `current_tenant_id()` | variable de session `@app_tenant_id` |
| `app.client_ids` (tableau) | `@app_client_ids` (chaîne `id1,id2` ; `NULL` = pas de portée, `''` = portée vide) ; test `FIND_IN_SET(x, @app_client_ids)` |
| `set_config('app.anonymizing', …)` et autres drapeaux | variable de session `@app_<nom>` posée par la routine **et remise à `NULL`** en sortie (y compris sur erreur : `DECLARE EXIT HANDLER`) |
| `SECURITY DEFINER` | `SQL SECURITY DEFINER` (défaut MySQL) — la routine s'exécute avec les droits de son créateur |
| `CREATE FUNCTION … RETURNS table/setof` | `CREATE PROCEDURE` qui renvoie un jeu de résultats, appelée par `CALL`, ou — préférable — **requête écrite en TypeScript** |
| `RETURNS uuid` / `uuid_generate_v7()` | `char(36)` ; l'identifiant s'obtient par `uuid()` ou est passé par l'appelant |
| `ON CONFLICT … DO UPDATE … RETURNING` | `INSERT … ON DUPLICATE KEY UPDATE col = LAST_INSERT_ID(col + 1)` puis `SELECT LAST_INSERT_ID()` |
| `now()` | `CURRENT_TIMESTAMP(3)` (la connexion est en UTC) |
| `x::text`, `::uuid`, `::int` | `CAST(x AS …)` ou rien |
| `~ 'rx'` | `REGEXP_LIKE(x, 'rx', 'c')` |
| `date_trunc`, `generate_series`, `AT TIME ZONE`, `extract(epoch …)` | écrire en TypeScript (`src/lib/dates.ts`), ou `TIMESTAMPDIFF`, `DATE_FORMAT`. `CONVERT_TZ` seulement si inévitable |
| `jsonb ->> 'k'` | `JSON_UNQUOTE(JSON_EXTRACT(col, '$.k'))` |
| `coalesce`, `nullif`, `greatest`, `least`, `left`, `substring` | identiques |
| `FOR UPDATE` dans une fonction | autorisé |
| `UPDATE` de la même table depuis son trigger | **interdit** par MySQL (erreur 1442) : utiliser `SET NEW.col = …` dans un `BEFORE`, ou déplacer la logique en TypeScript |
| triggers `AFTER` qui écrivent la table qui les a déclenchés | idem, interdit |
| Politiques RLS (`CREATE POLICY`, `ENABLE ROW LEVEL SECURITY`) | **supprimées**. Voir §6 |
| Rôle `app_centre`, `BYPASSRLS` | supprimés. L'utilisateur applicatif a `SELECT/INSERT/UPDATE/DELETE` + `EXECUTE` |
| `REVOKE … ON document_sequences` | géré par `infra/migrer.ts` (lecture seule sur `document_sequences`) |

Contrôles `CHECK` multi-lignes ou inter-tables : trigger `BEFORE INSERT/UPDATE`.

### 4.1 Routines : contrat entre qui écrit le SQL et qui l'appelle

Plusieurs agents écrivent en parallèle, certains le SQL, d'autres le code qui
l'appelle. Pour que les deux moitiés s'ajustent sans se parler :

1. **Une fonction SQL PostgreSQL qui renvoie un scalaire ou rien** devient une
   `FUNCTION` MySQL de **même nom, mêmes paramètres dans le même ordre**
   (préfixés `p_` : `p_invoice_id`). Appel : ``sql`select name(${a}, ${b})` ``.
2. **Une fonction PostgreSQL qui crée une entité ou renvoie une ligne / un jeu
   de lignes** devient une `PROCEDURE` de même nom, qui **ne renvoie rien** :
   - si elle créait une ligne, l'**identifiant est un paramètre `p_id char(36)`
     placé en premier**, fourni par l'appelant (`uuidv7()`) ;
   - l'appelant relit ce qu'il veut par identifiant, dans la même transaction ;
   - appel : ``await tx.execute(sql`call name(${id}, ${a})`) ``.
3. Une fonction PostgreSQL qui renvoyait un jeu de lignes pour la lecture
   (liste, agrégat) est **réécrite en TypeScript** (requête Drizzle ou `sql`) :
   pas de procédure à jeu de résultats.
4. Une fonction qui n'existe que pour un trigger ou une politique RLS
   (`current_tenant_id()`, `tenant_id_default()`…) **disparaît**.
5. Chaque agent qui écrit un fichier `src/db/regles/NN-*.sql` rédige **d'abord**
   `docs/migration-mysql/routines-<module>.md` : un tableau
   `nom(paramètres) → type de retour | FUNCTION/PROCEDURE | appelée par (fichiers)`,
   des routines **appelées depuis le TypeScript**. Les agents qui appellent
   ces routines le lisent avant de conclure et alignent leurs appels.

**Le portage doit conserver les règles, pas seulement la syntaxe** : chaque
trigger de PostgreSQL (migrations 0002…0044, dans
`../centre-affaires.avant-mysql/src/db/migrations/`) a un équivalent MySQL
avec le **même code `CAnnn` et le même message**, et chaque fonction SQL
appelée par le code a un équivalent de même nom et de mêmes arguments (ou est
réécrite en TypeScript, auquel cas l'appelant est adapté).

## 5. Code TypeScript

### Insertions / mises à jour avec relecture

MySQL n'a pas de `RETURNING`. Remplacer :

```ts
const [row] = await tx.insert(t).values(v).returning()           // avant
const row = await insertReturning(tx, t, v)                      // après
const rows = await insertManyReturning(tx, t, vs)
const rows = await updateReturning(tx, t, set, where)            // UPDATE … RETURNING
const rows = await deleteReturning(tx, t, where)
```

`.returning({ id: t.id })` → `insertReturning` puis `.id`, ou, quand seul l'id
compte, générer l'id avant (`uuidv7()`), insérer, utiliser l'id.

Tables sans colonne `id` (clé composite) : insérer, puis relire par la clé.

### Conflits

```ts
.onConflictDoNothing()          // avant
.onDuplicateKeyUpdate({ set: { id: sql`id` } })   // après : no-op, mais les autres erreurs remontent
```

**Ne pas utiliser `.ignore()`** : `INSERT IGNORE` avalerait aussi les erreurs de
clé étrangère et de `CHECK`. Pour savoir si la ligne a été insérée : générer
l'id avant, relire par cet id (si une autre ligne l'a emporté, l'id n'existe pas).

`.onConflictDoUpdate({ target, set })` → `.onDuplicateKeyUpdate({ set })`.
`target` disparaît (MySQL réagit à n'importe quel index unique).

### Divers

| PostgreSQL / postgres-js | MySQL / mysql2 |
|---|---|
| `sql\`now()\`` | `maintenant()` (de `src/db/columns.ts`) ou `sql\`CURRENT_TIMESTAMP(3)\`` |
| `ilike` | `like` (la collation est insensible à la casse) ; `%`/`_` à échapper comme avant |
| `= any(${array})` | `inArray(col, array)` (tableau vide : tester avant, `inArray` vide lève) |
| `tx.execute(sql\`…\`)` | rend `[rows, fields]` pour un `SELECT`, `[ResultSetHeader, …]` pour une écriture. Lire `const [rows] = await tx.execute(…)`. Préférer le query builder |
| `.rows`, `result.count` | `rows` du tuple ; `header.affectedRows` |
| `FOR UPDATE SKIP LOCKED` | `.for('update', { skipLocked: true })` |
| `pgErrorCode`, `pgConstraintName`, `PG_*` | `dbErrorCode`, `dbConstraintName`, `DB_*` (même valeurs de code) |
| `PG_EXCLUSION_VIOLATION` (`23P01`) | `DB_EXCLUSION_VIOLATION` (`CA000`) |
| `error.code === '23505'` (lecture directe) | `dbErrorCode(error) === DB_UNIQUE_VIOLATION` |
| `set_config('app.x', v, true)` | `set @app_x = v` — seulement via `withTenant` / `withClientScope` |
| `select … from f(args)` (fonction SQL) | `select f(args)` ou `call p(args)` |
| `date` en `mode: 'string'` | inchangé |
| `gen_random_uuid()` | `uuidv7()` côté code |
| agrégats : `count(*)` rend un nombre en pg-postgres-js (string) | `mysql2` rend un nombre pour `count`, une **chaîne** pour `sum`/`avg` de `decimal` : `Number()` |
| `GROUP BY` partiel | `ONLY_FULL_GROUP_BY` est actif : tout champ sélectionné est groupé ou agrégé |
| `LIMIT … OFFSET` | idem |
| `DISTINCT ON` | réécrire (sous-requête avec `ROW_NUMBER()` ou `GROUP BY`) |
| `BOOL` | `tinyint(1)` : `boolean` Drizzle convertit |
| `%` dans `LIKE` | idem |
| chaîne vide vs `NULL` | inchangé |

**Isolation** : la connexion est en `READ COMMITTED`, comme PostgreSQL.

**Interblocages** (`40P01`) : MySQL les détecte et annule une transaction.
Ordonner les verrous comme le code le faisait déjà (`orderBy(id).for('update')`).

## 6. Isolation par centre et par portée client — sans RLS

PostgreSQL filtrait les lectures par RLS. **MySQL n'a pas de RLS** : la base ne
filtre plus les lectures.

- Aujourd'hui **un seul centre existe**. Le filtre sur `tenant_id` n'est donc pas
  obligatoire pour le correct fonctionnement, mais **toute nouvelle requête
  écrite ou touchée par la migration doit porter `eq(table.tenantId, tenantId)`
  quand `tenantId` est à portée sans effort** (les fonctions de requête ont
  `currentTenantId()`). Ne pas refactorer en masse les requêtes qui ne le font
  pas : l'ADR 042 liste ce chantier pour l'arrivée d'un second centre.
- Les écritures sont gardées par la base : le migrateur génère, pour toute
  table qui porte `tenant_id`, des triggers `<table>_guard_tenant_insert` /
  `_update` qui refusent `NEW.tenant_id <> @app_tenant_id` quand
  `@app_tenant_id` n'est pas `NULL` (`CA014`, `DB_TENANT_MISMATCH`). **Les
  modules n'ont rien à écrire pour cela** (de même pour `updated_at`).
- **Portée client (ADR 019) : critique.** L'espace client lit sous
  `withClientScope()`. PostgreSQL empêchait même une requête sans filtre de
  voir les données d'un autre client. Désormais, **toute requête exécutée sous
  `withClientScope()` filtre elle-même sur les entreprises du compte** :
  `inArray(table.clientId, clientIds)` (ou la jointure équivalente) sur chacune
  des tables suivantes : `clients`, `client_members`, `client_contacts`,
  `contracts`, `bookings`, `mail_items`, `mail_scans`, `mail_scan_views`, et
  toute table que les politiques restrictives des migrations 0026, 0041, 0042,
  0044 listaient. Les écritures sous portée sont, en plus, gardées par trigger
  (`FIND_IN_SET(NEW.client_id, @app_client_ids)`, `CA009`/`CA010`/… selon la
  table, comme le faisaient les politiques `WITH CHECK`).
  Chaque module qui expose des requêtes de portée client **vérifie une à une**
  qu'elles portent ce filtre, et ajoute un test qui, sous la portée du client A,
  ne voit rien du client B.

## 7. Tests

- Les `*.db.test.ts` utilisent `src/db/test-support.ts` :

```ts
import { after, before, beforeEach, describe, it } from 'node:test'
import { ouvrirBasesDeTest, raisonDeSaut, viderTables, type TestDatabases } from '../../db/test-support.ts'

describe('…', { skip: raisonDeSaut }, () => {
  let bases: TestDatabases
  before(async () => { bases = await ouvrirBasesDeTest() })   // crée la base, applique migrations + règles
  after(async () => { await bases.fermer() })
  beforeEach(async () => { await viderTables(bases.owner, 'bookings', 'resources') })
  // bases.owner : propriétaire (DDL, vidage) ; bases.app : identité applicative
})
```

- Plus de `migrate` de drizzle, plus de `TEST_DATABASE_URL`, plus de
  `owner.client\`…\`` (tagged template postgres-js) : `owner.client.query('…', [params])`
  ou `owner.db.execute(sql\`…\`)`.
- Les tests de RLS (« sans contexte, aucune ligne ») sont **supprimés** ; leur
  intention est reportée sur ce qui existe désormais : gardes d'écriture
  (`CA014`), portée client (filtre explicite), droits (`document_sequences`).
- Chaque règle portée de PostgreSQL vers un trigger MySQL **garde son test**.
- Les tests unitaires (sans base) doivent passer sans MySQL :
  `node --test "src/modules/<module>/**/*.test.ts"`.
- Lancer les tests d'intégration :

```powershell
$env:TEST_DB_NAME = 'centre_affaires_test'   # MySQL local : root sans mot de passe, 127.0.0.1:3306
node --test --test-concurrency=1 "src/modules/<module>/**/*.test.ts"
```

  Chaque fichier de test ouvre la base, applique `src/db/migrations` puis
  `src/db/regles` — la structure (migrations/*.sql) est générée par
  drizzle-kit par le chef de projet une fois tous les schémas convertis.

## 8. Règles de travail

- Garder les commentaires, en français, qui expliquent le **pourquoi**.
  Corriger ceux qui nomment PostgreSQL, Neon, RLS, `uuid_generate_v7`,
  `timestamptz`, `jsonb`, migration `00xx` quand l'affirmation n'est plus vraie.
- Conventions : `snake_case` en base, `camelCase` en TS, imports avec extension
  `.ts`, pas de dépendance nouvelle sans justification.
- Ne pas modifier les fichiers hors de votre périmètre. Si un fichier commun
  (`src/db/*.ts` de la liste §2, `package.json`, `CLAUDE.md`) doit changer,
  **le dire dans le compte rendu** plutôt que de le modifier.
- `src/db/migrations/` (structure) est regénéré en bloc : n'y toucher pas.
- La copie de l'état d'origine (PostgreSQL) est dans
  `../centre-affaires.avant-mysql/` : c'est la référence pour porter les
  règles (ses migrations SQL font foi).

## 9. Pièges MySQL constatés pendant la migration

- Un `CHECK` ne peut pas être un `CASE … END` nu (erreur 3812) : l'envelopper
  dans une comparaison ou un `AND`. Il n'accepte aucune routine stockée.
- `SIGNAL … MESSAGE_TEXT` : littéral ou variable, **128 caractères au plus**, pas
  de `CONCAT` direct (passer par une variable locale, tronquée).
- La connexion est en `utf8mb4_0900_as_ci` (`charset` de `createDatabase`) :
  une connexion ouverte autrement lève l'erreur 1267 en comparant une colonne
  à `@app_*`.
- Créer une routine sous `log_bin` exige `DETERMINISTIC` ou `MODIFIES SQL DATA`
  (ou `log_bin_trust_function_creators=1`).
- Écrire dans une `FUNCTION` appelée depuis une requête est refusé sous binlog :
  utiliser une `PROCEDURE` à paramètre `OUT`.
- `now()` n'est pas constant dans une transaction : comparer avant/après.
- `CONVERT_TZ` exige les tables de fuseaux (`mysql_tzinfo_to_sql`).
