# ADR 042 — MySQL sur le VPS, authentification Better Auth auto-hébergée, fin de la RLS

**Date** : 2026-10-15
**Statut** : accepté — remplace l'ADR 003 (Neon, rôle applicatif sans
BYPASSRLS) et la partie « base » de l'ADR 001 ; remplace Neon Auth de
l'ADR 008 par Better Auth auto-hébergé ; amende les décisions 1 et 3 du
`CLAUDE.md`

## Contexte

La base tournait sur Neon (PostgreSQL 18, région EU) et l'authentification sur
Neon Auth. L'exploitant héberge déjà l'application sur son propre VPS
(ADR 013) et veut y héberger aussi la base : une seule machine, une seule
configuration (`.env`), aucune dépendance à un fournisseur de plateforme pour
les données de ses clients.

Le choix de MySQL a été fait par l'exploitant en connaissance de cause : le
produit s'appuyait sur des fonctions propres à PostgreSQL (Row Level Security,
contrainte d'exclusion `EXCLUDE USING gist`, `tstzrange`, index partiels,
`jsonb`, fonctions PL/pgSQL). Rien n'a été conservé par défaut : chacune est
remplacée par un équivalent MySQL ou par du code, décrit ci-dessous.

## Décision

**MySQL 8.4 (≥ 8.0.16)**, InnoDB, `utf8mb4`, collation `utf8mb4_0900_as_ci`
(insensible à la casse, sensible aux accents), fuseau de session UTC,
isolation `READ COMMITTED` (celle de PostgreSQL pour laquelle les transactions
ont été écrites). Driver `mysql2`, Drizzle `mysql-core`.

**Configuration entièrement dans le `.env`** : `DB_HOST`, `DB_PORT`,
`DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_SSL` pour l'application ;
`DB_ADMIN_USER`, `DB_ADMIN_PASSWORD` pour les migrations.

**Deux identités** (reprise de l'ADR 003, sans la RLS) : l'utilisateur
applicatif n'a que `SELECT`, `INSERT`, `UPDATE`, `DELETE` table par table, et
`EXECUTE` ; il ne peut ni définir la structure, ni écrire dans
`document_sequences` (la numérotation passe par `next_document_number()`,
`SQL SECURITY DEFINER`, ADR 021). L'administrateur joue les migrations.

**Migrations en deux temps** (`npm run db:migrer`, `infra/migrer.ts`) :

1. `src/db/migrations/` : structure, générée par `drizzle-kit generate` depuis
   le schéma, appliquée une fois ;
2. `src/db/regles/` : règles métier (triggers `SIGNAL`, routines), rejouées
   quand leur contenu change, plus les triggers `updated_at` et les gardes de
   centre, générés table par table.

Les 44 migrations PostgreSQL sont remplacées par une structure regénérée : il
n'y avait aucune donnée à reprendre (la base repart vide avec le seed de
démo). Cela lève, une fois, la règle « migrations jamais éditées après
application ».

### Ce que MySQL ne sait pas faire, et ce qui le remplace

| PostgreSQL | MySQL |
|---|---|
| Row Level Security (isolation par centre) | **Aucune lecture filtrée par la base.** `withTenant()` pose `@app_tenant_id` ; les **écritures** sont refusées (`CA014`) par des triggers générés sur toute table portant `tenant_id`. Les lectures portent leur filtre dans le code |
| RLS restrictive par portée client (ADR 019) | Variable `@app_client_ids` ; triggers de garde en écriture ; **toute lecture sous `withClientScope()` filtre explicitement** sur les entreprises du compte, avec un test par module |
| Contrainte d'exclusion anti-double-réservation (décision 3) | Triggers `BEFORE INSERT/UPDATE` sur `bookings` : verrou de la ressource (`SELECT … FOR UPDATE`) puis refus du chevauchement `[)` (`CA000`). Toujours au niveau base, toujours indépendant du code applicatif |
| Index partiels (`WHERE deleted_at IS NULL`) | Colonne générée valant `1` ou `NULL` + index unique (les `NULL` ne se heurtent pas) |
| `timestamptz` | `datetime(3)`, UTC (décision 4 inchangée) |
| `jsonb`, index sur un champ JSON | `json` ; colonne générée pour indexer un champ |
| `uuid_generate_v7()` | UUID v7 posé par l'application (`uuidv7()`) ; `uuid()` en secours côté base |
| `RETURNING` | identifiant connu avant l'insertion, ligne relue dans la transaction (`src/db/returning.ts`) |
| Fonctions PL/pgSQL qui renvoient des lignes | `PROCEDURE` sans résultat (l'appelant relit) ou requête TypeScript |

### Authentification : Better Auth auto-hébergé

Better Auth (déjà la brique de Neon Auth, ADR 003) tourne dans l'application,
sur les tables `auth_users`, `auth_sessions`, `auth_accounts`,
`auth_verifications` de la même base. L'API est servie sur `/api/auth`, les
cookies sont first-party. Le rattachement d'un compte à un membre de l'équipe
ou d'un client se fait toujours à la première connexion, sur l'adresse
(ADR 008) ; **cette adresse doit être vérifiée** : l'inscription envoie un
message de confirmation (SMTP, ADR 015). `AUTH_SKIP_EMAIL_VERIFICATION=true`
n'existe que pour le développement et est refusé en production.

### Stockage de fichiers

Inchangé dans son principe (S3, chiffré avant dépôt, ADR 020) : l'endpoint est
désormais configurable (`S3_ENDPOINT`…), MinIO sur le VPS convient. La garde
« région UE obligatoire » est conservée.

## Conséquences

- **L'isolation entre centres est plus faible qu'avec PostgreSQL** : une
  requête qui oublie son filtre `tenant_id` lit les données d'un autre centre.
  Sans conséquence tant que le produit est mono-centre (un seul centre en
  base). **Avant d'ouvrir un second centre**, il faut : (1) ajouter le filtre
  `tenant_id` à toutes les requêtes de lecture qui ne l'ont pas, (2) un test de
  non-fuite par module, comme celui de la portée client. Ce chantier est
  inscrit dans `docs/roadmap.md`.
- **Portée client** : la protection par la base est désormais limitée aux
  écritures. Les lectures de l'espace client dépendent de filtres écrits dans
  le code : toute nouvelle requête sous `withClientScope()` doit filtrer sur
  les `clientIds`, et un test doit le prouver.
- La décision 1 du `CLAUDE.md` reste : `tenant_id` sur toutes les tables,
  défaut sur le centre unique. Seule la ligne « Row Level Security Postgres
  activé » est remplacée.
- La sauvegarde passe de `pg_dump` à `mysqldump` chiffré (ADR 022 : mêmes
  garanties, mêmes durées, test de restauration inchangé).
- Plus de branches de base : les environnements de revue se font avec une
  base jetable (`docker compose up -d`, `TEST_DB_NAME`).

## Écarté

- **PostgreSQL sur le VPS.** Aurait conservé la RLS, la contrainte
  d'exclusion et les 44 migrations. Écarté par l'exploitant.
- **Vues par centre avec `WITH CHECK OPTION`** pour retrouver un filtre en
  lecture côté base : doublerait le schéma (tables et vues), à reconstruire à
  chaque `ALTER TABLE`. À reconsidérer à l'arrivée d'un second centre.
- **Auth.js, un SSO externe** : pas de besoin exprimé, Better Auth était déjà
  la brique en place.
