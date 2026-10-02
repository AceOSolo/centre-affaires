# Centre d'affaires

Application de gestion du centre d'affaires Handfield, construite à partir du
cahier des charges DOMOTOP. Outil interne d'un seul centre, conçue pour
devenir un service multi-centres sans réécriture.

Elle sert trois publics :

- **l'équipe du centre** (back-office) : ressources, planning et réservations,
  clients et contrats, grilles tarifaires, courrier des entreprises
  domiciliées ;
- **les entreprises clientes** (espace client) : leur courrier numérisé, leurs
  réservations, leurs demandes ;
- **le public** : demande de réservation d'une salle, sans compte.

Les règles du projet, à lire avant toute contribution, sont dans
[`CLAUDE.md`](CLAUDE.md). Les décisions et leurs raisons sont dans
[`docs/decisions/`](docs/decisions/README.md).

## Stack

| Brique | Choix | Décision |
|---|---|---|
| Application | Next.js 16 (App Router), TypeScript, Tailwind CSS 4, primitives shadcn/Radix | ADR 001, 004 |
| Base | PostgreSQL 18 chez Neon (`aws-eu-central-1`), Drizzle ORM, RLS par centre et par client | ADR 002, 003, 019 |
| Authentification | Neon Auth (Better Auth managé) | ADR 008 |
| Fichiers | Neon Object Storage (S3), bucket privé `uploads` | ADR 015 |
| Courriels | SMTP de Brevo | ADR 015 |
| Hébergement | Image Docker sur le VPS de production, derrière Apache | ADR 013 |
| Sauvegardes | Lot nocturne chiffré, hors du serveur | ADR 022 |

## Organisation

```
src/
  app/
    (admin)/       back-office de l'équipe
    (portail)/     espace client et pages publiques
    api/           authentification, maintenance
  modules/         code métier, un dossier par domaine (schéma, règles, actions, composants)
  db/              connexion, centres, équipe, migrations
  lib/             utilitaires transverses
  components/ui/   primitives d'interface sans métier (ADR 004)
infra/             scripts d'administration, serveur de production
docs/              roadmap, décisions, RGPD, exploitation
```

Le code est rangé par domaine métier, pas par couche technique.

## Installation

Prérequis : Node.js 24, npm, Docker pour la base locale.

```bash
git clone https://github.com/AceOSolo/centre-affaires.git
cd centre-affaires
npm ci
cp .env.example .env.local
```

### Avec la branche Neon `dev` (travail courant)

`.env.local` désigne la branche `dev`, **jamais `production`** : pas de
données réelles en développement (ADR 003).

1. Remplir l'environnement : `neon env pull` sur la branche `dev`. Il écrit
   `DATABASE_URL`, `NEON_AUTH_*` et `AWS_*`.
2. Ajouter le rôle applicatif : `node infra/provision-role-applicatif.mjs`
   écrit `APP_DATABASE_URL`.

Laisser `SMTP_*` vide : sans configuration, aucun courriel ne part.

### Avec la base locale (hors ligne)

```bash
docker compose up -d                       # PostgreSQL 18 sur localhost:5432
npx drizzle-kit migrate                    # avec DATABASE_URL vers cette base
node infra/provision-role-applicatif.mjs   # APP_DATABASE_URL
node --env-file=.env.local infra/seed-demo.mjs   # données fictives
```

Neon Auth n'existe pas en local : la connexion n'y fonctionne pas.

**Volume de la base locale.** L'image `postgres:18` range ses données sous
`/var/lib/postgresql` et refuse de démarrer si un volume est encore monté sur
l'ancien emplacement, `/var/lib/postgresql/data`. Le `docker-compose.yml` monte
donc un volume neuf, `db-data-18`. L'ancien, `centre-affaires_db-data`, n'est
plus lu : la base locale repart vide et se remplit par les commandes
ci-dessus. Pour garder le contenu de l'ancien volume, le lire avec l'image qui
l'a écrit, en lui imposant l'ancien emplacement :

```bash
docker run -d --name ancien-volume -e POSTGRES_PASSWORD=postgres \
  -e PGDATA=/var/lib/postgresql/data \
  -v centre-affaires_db-data:/var/lib/postgresql/data postgres:18-alpine
docker exec ancien-volume pg_dump -U postgres -Fc centre_affaires > ancien.dump
docker rm -f ancien-volume
docker volume rm centre-affaires_db-data   # quand il n'est plus utile
```

Pour un volume écrit par PostgreSQL 17, remplacer l'image par
`postgres:17-alpine`.

## Commandes

| Commande | Effet |
|---|---|
| `npm run dev` | serveur de développement |
| `npm run build` | construction de production |
| `npm run lint` | ESLint |
| `npx tsc --noEmit` | vérification des types (après `npx next typegen`) |
| `npm test` | tests unitaires et tests de base (`*.db.test.ts`) |
| `bash infra/serveur/sauvegarde.test.sh` | tests du script de sauvegarde |
| `npx drizzle-kit generate` | générer une migration depuis les schémas |
| `npx drizzle-kit migrate` | appliquer les migrations (propriétaire de la base) |

Une migration générée ne se modifie plus une fois appliquée.

## Base de test locale

Les tests de base mettent à l'épreuve ce que seul un vrai moteur vérifie :
- la contrainte anti-double-réservation ;
- les politiques RLS ;
- les triggers et la numérotation.

Ils appliquent eux-mêmes les migrations, puis vident les tables entre deux
suites. Ils ont besoin de deux URL vers une base **jetable** :

| Variable | Rôle | Usage |
|---|---|---|
| `TEST_OWNER_DATABASE_URL` | propriétaire (`postgres`) | migrations, `TRUNCATE` |
| `TEST_DATABASE_URL` | `app_centre`, sans `BYPASSRLS` | assertions, sous les politiques |

Avec la base de `docker compose` :

```bash
docker exec centre-affaires-db psql -U postgres -c "create database centre_affaires_test"
docker exec centre-affaires-db psql -U postgres \
  -c "do \$\$ begin if not exists (select from pg_roles where rolname = 'app_centre') then create role app_centre login nobypassrls; end if; end \$\$" \
  -c "alter role app_centre password 'test'"
export TEST_OWNER_DATABASE_URL=postgres://postgres:postgres@localhost:5432/centre_affaires_test
export TEST_DATABASE_URL=postgres://app_centre:test@localhost:5432/centre_affaires_test
npm test
```

Sans ces variables, les tests de base sont ignorés. Ils ne doivent jamais
viser une base Neon. La CI fait la même chose sur un PostgreSQL 18 jetable
(`.github/workflows/ci.yml`).

## Déploiement

Chaque push sur `main` dont la CI est verte est déployé sur le VPS de
production : l'image est construite par GitHub, puis lancée sur le serveur.
Les migrations se jouent à la main sur la branche `production`, avant la
fusion du code qui en dépend.

- Choix et raisons : [ADR 013](docs/decisions/013-hebergement-vps-de-production.md).
- Installation et exploitation du serveur, sauvegardes comprises :
  [`infra/serveur/README.md`](infra/serveur/README.md).

## Documentation

| Document | Contenu |
|---|---|
| [`docs/roadmap.md`](docs/roadmap.md) | Couverture du cahier des charges (R01 à R33), bloquants, vagues |
| [`docs/decisions/`](docs/decisions/README.md) | Décisions d'architecture (ADR) et leur index |
| [`docs/rgpd/registre-des-traitements.md`](docs/rgpd/registre-des-traitements.md) | Registre des traitements (RGPD, art. 30) |
| [`docs/rgpd/durees-de-conservation.md`](docs/rgpd/durees-de-conservation.md) | Durées de conservation, purges et réglages |
| [`docs/exploitation/restauration.md`](docs/exploitation/restauration.md) | Procédure de restauration et exercices |
| [`docs/exploitation/plan-de-reprise.md`](docs/exploitation/plan-de-reprise.md) | Plan de reprise : objectifs, rôles, secrets |
| [`infra/serveur/README.md`](infra/serveur/README.md) | Mise en production, crontab, sauvegardes |
