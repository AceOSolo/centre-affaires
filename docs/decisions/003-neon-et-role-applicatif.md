# ADR 003 — Plateforme Neon et rôle applicatif sans BYPASSRLS

**Date** : 2026-09-18
**Statut** : accepté

## Contexte

L'ADR 001 retient Neon en région EU sans en décrire la mise en œuvre. Le projet
est en place : `SimplX` (`bold-silence-51026235`), `aws-eu-central-1`,
PostgreSQL 18.6.

Le raccordement a révélé un défaut : les politiques de Row Level Security de la
migration 0003, pourtant posées en `ENABLE` **et** `FORCE`, ne filtraient
rien. Une requête sans `app.tenant_id` renvoyait toutes les lignes. L'isolation
par centre de la décision 1 du CLAUDE.md était décorative.

La cause est un attribut de rôle. `FORCE ROW LEVEL SECURITY` soumet le
propriétaire des tables aux politiques, mais l'attribut `BYPASSRLS` l'emporte
sur `FORCE`. Or `neondb_owner`, le rôle livré par Neon et celui que
`neon env pull` écrit dans `DATABASE_URL`, porte `BYPASSRLS`. En local, le rôle
`postgres` du `docker-compose.yml` est superutilisateur, ce qui revient au même.
L'application tournait donc sous une identité qui ne voyait jamais une seule
politique.

## Décision

**Une branche Neon par environnement.** `production` porte les données réelles.
`dev` est l'environnement de travail : c'est elle que `.env.local` désigne,
jamais `production`. Les autres branches (revue, essai) expirent seules au bout
de 7 jours, via la politique `branch` de `neon.ts`.

**Deux identités de connexion, jamais interchangeables.**

| Variable | Rôle | Usage |
| --- | --- | --- |
| `DATABASE_URL` | `neondb_owner` | migrations, outillage, `drizzle-kit` |
| `APP_DATABASE_URL` | `app_centre` | toutes les requêtes de l'application |

`app_centre` est créé par la migration 0004 en `NOBYPASSRLS`, avec les seuls
droits `SELECT, INSERT, UPDATE, DELETE` — aucun DDL. Son mot de passe est posé
par environnement par `infra/provision-role-applicatif.mjs` et ne figure dans
aucun fichier versionné.

**Neon Auth est l'implémentation de better-auth retenue par l'ADR 001.** Neon
Auth *est* Better Auth managé : utilisateurs et sessions vivent dans le schéma
`neon_auth` de la branche, interrogeables en SQL et compatibles RLS. Le client
est `@neondatabase/auth`, qui n'est pas interchangeable avec
`better-auth/client`. Ce n'est donc pas un second système d'authentification.

**Neon Object Storage** (bucket privé `uploads`, `eu-central-1`) tient le rôle
du « S3 européen » du CLAUDE.md pour les scans de courrier et les photos
d'états des lieux.

**PostgreSQL 18 partout** : Neon est en 18.6, le `docker-compose.yml` et la CI
passent en `postgres:18-alpine`.

## Justification

Retirer `BYPASSRLS` au propriétaire aurait été plus simple, mais les migrations
en ont besoin : la 0002 insère le premier centre dans `tenants`, dont la
politique exige `id = current_tenant_id()`. Sans contournement, elle échouerait
sur une base vierge. Les migrations doivent traverser les politiques ;
l'application ne le doit jamais. D'où deux rôles plutôt qu'un rôle amendé.

Le défaut est mesuré, pas supposé. Le test
« ne renvoie rien hors contexte de centre — RLS fermée par défaut » de
`src/modules/reservations/bookings.db.test.ts` échoue sous `neondb_owner`
(1 ligne au lieu de 0) et passe sous `app_centre`. Les tests de base réclament
désormais les deux URL : `TEST_OWNER_DATABASE_URL` pour l'installation et le
`TRUNCATE`, `TEST_DATABASE_URL` pour les assertions.

`.env.local` sur `dev` plutôt que sur `production` applique la règle RGPD du
CLAUDE.md : pas de données réelles en environnement de développement.

## Alternatives écartées

**Postgres local en Docker comme environnement de développement** : diverge de
la production sur la version, les extensions et l'absence de Neon Auth. Le
`docker-compose.yml` est conservé pour travailler hors ligne et pour la CI,
mais il n'est plus la référence.

**Vérifier le centre en code plutôt qu'en base** : contredit la décision 1 du
CLAUDE.md, et pour la même raison que la contrainte d'exclusion sur les
réservations — une garantie applicative cède à la première erreur de code.

**`protected: true` sur la branche `production`** : refusé par le plan Neon
gratuit (HTTP 422, quota de branches protégées à zéro). La ligne est commentée
dans `neon.ts`, à réactiver au passage sur un plan payant.

## Conséquences

Positives : l'isolation par centre est réellement appliquée et vérifiée par un
test. Chaque environnement a sa branche. Les documents sensibles sont stockés
en région EU.

Négatives : une étape de provision à ne pas oublier après chaque migration sur
un environnement neuf (`npx drizzle-kit migrate` puis
`node infra/provision-role-applicatif.mjs`). Un mot de passe de plus à gérer.
Toute nouvelle table doit être accessible à `app_centre` — couvert par
`ALTER DEFAULT PRIVILEGES`, à condition que les migrations restent jouées par
le propriétaire.

**Reste à faire** : la migration 0004 et la provision du rôle n'ont été jouées
que sur `dev`. Elles doivent l'être sur `production` avant le premier
déploiement.
