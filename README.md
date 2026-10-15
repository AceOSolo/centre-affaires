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
| Base | MySQL 8.4 sur le VPS (Docker, même compose que l'application), Drizzle ORM, règles en triggers, isolation par centre et par client dans le code | ADR 042 |
| Authentification | Better Auth auto-hébergé, sur la même base | ADR 042 |
| Fichiers | S3 en région UE (MinIO sur le VPS ou hébergeur), bucket privé `uploads` | ADR 015, 042 |
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

Prérequis : Node.js 24, npm, Docker pour la base locale (MySQL 8.4).

```bash
git clone https://github.com/AceOSolo/centre-affaires.git
cd centre-affaires
npm ci
cp .env.example .env.local
```

Toute la configuration est dans `.env.local` (modèle : `.env.example`,
commenté variable par variable). Laisser `SMTP_*` vide : sans configuration,
aucun courriel ne part. Poser `AUTH_SKIP_EMAIL_VERIFICATION=true` en
développement : sans courriel, la connexion ne demande pas la vérification
d'adresse (l'application le refuse en production).

### Base locale

```bash
docker compose up -d db          # MySQL 8.4 sur 127.0.0.1:3306
# .env.local : DB_HOST=127.0.0.1, DB_NAME=centre_affaires, DB_USER=centre_affaires,
#   DB_PASSWORD=<au choix>, DB_ADMIN_USER=root, DB_ADMIN_PASSWORD=root
npm run db:migrer                # crée la base et DB_USER, structure, règles, droits
node --env-file=.env.local infra/seed-demo.mjs   # données fictives
npm run dev
```

`npm run db:migrer` se rejoue sans risque. Repartir de zéro :
`docker compose down -v` (efface le volume `db-data`).

### Stockage local (facultatif)

```bash
docker compose --profile stockage up -d    # MinIO : API 9000, console 9001
```

Créer le bucket `uploads` dans la console (`http://127.0.0.1:9001`, utilisateur
`minio`, mot de passe `minio-secret`), puis renseigner `S3_*` dans
`.env.local` (`S3_ENDPOINT=http://127.0.0.1:9000`, `S3_FORCE_PATH_STYLE=true`).
Sans stockage configuré, tout fonctionne sauf le dépôt de documents.

## Commandes

| Commande | Effet |
|---|---|
| `npm run dev` | serveur de développement |
| `npm run build` | construction de production |
| `npm run lint` | ESLint |
| `npx tsc --noEmit` | vérification des types (après `npx next typegen`) |
| `npm test` | tests unitaires et tests de base (`*.db.test.ts`) |
| `bash infra/serveur/sauvegarde.test.sh` | tests du script de sauvegarde |
| `npm run db:migrer` | créer la base et l'utilisateur applicatif, appliquer structure et règles, accorder les droits |
| `npx drizzle-kit generate` | régénérer la structure SQL depuis les schémas (`src/db/migrations/`) |

La structure est générée par drizzle-kit à partir des schémas ; les règles
métier (triggers, routines) s'écrivent à la main dans `src/db/regles/*.sql`
et se rejouent à chaque `npm run db:migrer`. Une migration appliquée ne se
modifie plus.

## Base de test locale

Les tests de base mettent à l'épreuve ce que seul un vrai moteur vérifie :
- la contrainte anti-double-réservation (trigger) ;
- les gardes d'écriture par centre et par portée client ;
- les triggers et la numérotation.

Ils appliquent eux-mêmes la structure et les règles sur une base **jetable**,
puis vident les tables entre deux suites. Avec le MySQL de `docker compose` :

```bash
docker compose up -d db
export TEST_DB_NAME=centre_affaires_test
export TEST_DB_ADMIN_USER=root TEST_DB_ADMIN_PASSWORD=root
npm test
```

(PowerShell : `$env:TEST_DB_NAME = 'centre_affaires_test'`, etc.) Variables
optionnelles : `TEST_DB_HOST`, `TEST_DB_PORT`, `TEST_DB_USER` et
`TEST_DB_PASSWORD` (identité applicative). Sans `TEST_DB_NAME`, les tests de
base sont ignorés. La CI fait la même chose sur un MySQL 8.4 jetable
(`.github/workflows/ci.yml`).

## Déploiement

Chaque push sur `main` dont la CI est verte est déployé sur le VPS de
production : l'image est construite par GitHub, puis lancée sur le serveur.
La base MySQL est un service du même compose, sur le même serveur. Les
migrations se jouent à la main, sur le serveur, après le déploiement :
`docker compose run --rm migrer`.

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
