# ADR 013 — Hébergement sur un serveur OVH, déployé depuis GitHub

**Date** : 2026-09-30
**Statut** : accepté — remplace la partie « hébergement applicatif » de l'ADR 001

## Contexte

L'ADR 001 retenait Vercel pour l'application et prévoyait une sortie : « vers
un conteneur Docker autohébergé, à documenter si la question se pose ». La
question se pose : le domaine `handfield.fr` est chez OVH, le code sur un dépôt
GitHub public, et la décision est de ne pas passer par Vercel.

Une première tentative a fait pointer `www.handfield.fr` sur GitHub Pages. Elle
a produit une boucle de redirection : Pages renvoyait vers `handfield.fr`
(domaine déclaré dans son fichier `CNAME`), qui, resté sur l'ancien site OVH,
renvoyait vers `www`. Surtout, GitHub Pages ne sert que des fichiers statiques
— ici le README du dépôt. L'application a besoin d'un serveur : actions
serveur, connexion, lecture des disponibilités en direct. Pages ne peut pas
l'héberger.

## Décision

**Un VPS OVH en France fait tourner l'application dans un conteneur Docker.**
Le code reste sur GitHub ; le domaine, chez OVH, pointe sur ce serveur.

**La CI construit l'image, le serveur ne fait que la lancer.**
Sur `main`, après une CI verte, le job `deploy` de `.github/workflows/ci.yml` :

1. construit l'image (`Dockerfile`, sortie `standalone` de Next.js) et la
   publie sur GitHub Container Registry, étiquetée du commit ;
2. recopie `infra/serveur/compose.yml` et `infra/serveur/Caddyfile` sur le
   serveur, qui suit ainsi le dépôt ;
3. tire l'image et relance le service, en attendant qu'il soit sain.

**Caddy termine HTTPS** devant l'application, avec des certificats Let's
Encrypt obtenus et renouvelés seuls. Une adresse est canonique
(`www.handfield.fr`), l'autre y redirige.

**Neon reste la base, sans changement** (ADR 003). Le serveur ne détient que
`APP_DATABASE_URL` (`app_centre`, soumis à la RLS) et les secrets de Neon Auth,
dans un `.env` qui n'existe que sur lui. Le rôle propriétaire n'y figure pas.

**Les migrations restent manuelles**, jouées sur la branche `production` avant
de fusionner le code qui en dépend. L'automatiser demanderait de confier à
GitHub l'URL du propriétaire, qui contourne la RLS.

La mise en place — VPS, DNS, secrets — est décrite dans
`infra/serveur/README.md`.

## Justification

Construire l'image en CI plutôt que sur le serveur : `next build` demande plus
de mémoire qu'un petit VPS n'en a, et une image construite une fois est celle
qui tourne, à l'octet près.

Le build n'exige aucun secret : l'authentification et la base ne sont ouvertes
qu'à la première requête. L'image est donc publiable sans rien contenir de
sensible, et le même `Dockerfile` sert partout.

Le jeton qui permet au serveur de tirer l'image est celui du job, qui expire
avec lui : aucun identifiant GitHub durable ne reste sur le serveur.

Un VPS en France respecte la contrainte d'hébergement EU du CLAUDE.md.

## Alternatives écartées

**Vercel** : écarté par choix du propriétaire du produit. Restait la solution
la moins coûteuse en exploitation.

**GitHub Pages** : n'héberge que du statique. Il aurait fallu figer le site
public au build, renoncer au formulaire de demande de réservation et mettre la
connexion et le back-office ailleurs.

**Construire sur le serveur (`git pull` puis `docker compose build`)** : plus
simple à écrire, mais le build sature la mémoire d'un petit VPS et le serveur
aurait besoin d'un accès au dépôt.

## Conséquences

Positives : un domaine, un serveur, un déploiement automatique depuis `main`,
sans fournisseur supplémentaire. Le serveur est en France.

Négatives : l'exploitation du serveur revient à l'équipe — mises à jour du
système et de Docker, surveillance, pare-feu. Un seul serveur : s'il tombe, le
site tombe. Plus de déploiement de prévisualisation par pull request, que
Vercel offrait. Une migration oubliée sur `production` casse la mise en ligne
du code qui en dépend.
