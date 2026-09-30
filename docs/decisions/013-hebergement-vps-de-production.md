# ADR 013 — Hébergement sur le VPS de production, déployé depuis GitHub

**Date** : 2026-09-30
**Statut** : accepté — remplace la partie « hébergement applicatif » de l'ADR 001

## Contexte

L'ADR 001 retenait Vercel pour l'application et prévoyait une sortie : « vers
un conteneur Docker autohébergé, à documenter si la question se pose ». La
question se pose : l'équipe dispose déjà d'un VPS de production (Debian,
Apache) qui héberge ses autres sites, le domaine `handfield.fr` est chez OVH,
le code sur un dépôt GitHub public, et la décision est de réutiliser cette
infrastructure plutôt que d'ajouter Vercel.

Une première tentative a fait pointer `www.handfield.fr` sur GitHub Pages, comme
pour le site statique ma-prevention. Elle a produit une boucle de redirection
avec l'ancien site, et surtout GitHub Pages ne sert que des fichiers statiques :
il aurait publié le README du dépôt. L'application a besoin d'un serveur —
actions serveur, connexion, disponibilités lues en direct.

## Décision

**L'application tourne dans un conteneur Docker sur le VPS de production**, à
côté des sites existants. Le conteneur n'est publié que sur `127.0.0.1`.

**L'Apache en place sert le domaine et HTTPS** (`infra/serveur/apache-handfield.conf`),
en proxy vers le conteneur, avec un certificat Let's Encrypt obtenu par
certbot. `www.handfield.fr` est l'adresse canonique, le domaine nu y renvoie.

**La CI construit l'image, le serveur ne fait que la lancer.** Sur `main`, après
une CI verte, le job `deploy` de `.github/workflows/ci.yml` construit l'image
(`Dockerfile`, sortie `standalone` de Next.js), la publie sur GitHub Container
Registry étiquetée du commit, recopie `infra/serveur/compose.yml` sur le
serveur, puis tire l'image et relance le service en attendant qu'il soit sain.

**Neon reste la base, sans changement** (ADR 003). Le serveur ne détient que
`APP_DATABASE_URL` (`app_centre`, soumis à la RLS) et les secrets de Neon Auth,
dans un `.env` qui n'existe que sur lui. Le rôle propriétaire n'y figure pas.

**Les migrations restent manuelles**, jouées sur la branche `production` avant
de fusionner le code qui en dépend. Les automatiser demanderait de confier à
GitHub l'URL du propriétaire, qui contourne la RLS.

La mise en place est décrite dans `infra/serveur/README.md`.

## Justification

Un conteneur plutôt que Node installé sur le serveur : la version de Node et
les dépendances natives voyagent avec l'image, sans rien imposer aux autres
sites du VPS.

Construire l'image en CI plutôt que sur le serveur : `next build` est gourmand
en mémoire et ne doit pas disputer le VPS de production aux sites qu'il sert.
L'image construite une fois est celle qui tourne.

Le build n'exige aucun secret : l'authentification et la base ne sont ouvertes
qu'à la première requête. L'image est publiable sans rien contenir de sensible.

Le jeton qui permet au serveur de tirer l'image est celui du job, qui expire
avec lui : aucun identifiant GitHub durable ne reste sur le serveur.

## Alternatives écartées

**Vercel** : écarté au profit de l'infrastructure existante.

**GitHub Pages** : n'héberge que du statique. Il aurait fallu figer le site
public au build, renoncer au formulaire de demande de réservation et mettre la
connexion et le back-office ailleurs.

**Un VPS dédié, avec Caddy pour HTTPS** : fonctionnel, mais une machine de
plus à exploiter alors que le VPS de production et son Apache existent.

**MySQL, déjà présent sur le VPS, à la place de PostgreSQL** : écarté. Deux
décisions non négociables du CLAUDE.md reposent sur des fonctions que MySQL n'a
pas — la contrainte d'exclusion qui rend la double réservation impossible
(décision 3) et la Row Level Security qui isole les centres (décision 1). Les
remplacer par du code est précisément ce que ces décisions interdisent. Le
portage aurait aussi touché les 18 migrations, les requêtes SQL écrites à la
main et l'authentification, qui vit dans la base Neon.

## Conséquences

Positives : aucun fournisseur supplémentaire, un déploiement automatique depuis
`main`, un serveur que l'équipe connaît et exploite déjà.

Négatives : l'application partage le VPS de production avec les autres sites —
une charge anormale de l'un se ressent sur les autres. Le compte de
déploiement, membre du groupe `docker`, équivaut à root sur ce serveur : sa clé
ne vit que dans les secrets GitHub. Plus de déploiement de prévisualisation par
pull request, que Vercel offrait. Une migration oubliée sur `production` casse
la mise en ligne du code qui en dépend.
