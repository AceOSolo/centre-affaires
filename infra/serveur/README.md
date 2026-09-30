# Mise en production sur le serveur OVH

Le choix et ses raisons : [ADR 013](../../docs/decisions/013-hebergement-serveur-ovh.md).

Chaque push sur `main` dont la CI est verte déclenche le job `deploy` : l'image
est construite par GitHub, puis lancée sur le serveur derrière Caddy, qui gère
HTTPS. Ce document décrit l'installation, à faire une fois. Tant qu'elle n'est
pas terminée (variable `VPS_HOST` absente), le job `deploy` ne s'exécute pas.

## 1. Commander le serveur

Espace client OVH → Bare Metal Cloud → VPS. Ubuntu 24.04, localisation en
France (Gravelines, Roubaix ou Strasbourg). 2 Go de mémoire suffisent : le build
se fait chez GitHub, pas sur le serveur.

Noter l'adresse IPv4 et l'adresse IPv6 du VPS.

## 2. Préparer le serveur

Connecté en SSH avec le compte fourni par OVH :

```bash
sudo apt update && sudo apt upgrade -y
curl -fsSL https://get.docker.com | sudo sh

# Compte dédié au déploiement. Membre du groupe docker, donc équivalent root
# sur cette machine : elle ne doit servir qu'à l'application.
sudo adduser --disabled-password --gecos "" deploy
sudo usermod -aG docker deploy
sudo -u deploy mkdir -p -m 700 /home/deploy/.ssh /home/deploy/centre-affaires

# Pare-feu : SSH, HTTP (pour les certificats et la redirection) et HTTPS.
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443
sudo ufw enable
```

Les mises à jour de sécurité d'Ubuntu s'appliquent seules
(`unattended-upgrades`, installé par défaut). Le reste de l'exploitation — mises
à jour de version, surveillance — revient à l'équipe.

## 3. Clé de déploiement

Sur votre poste, une clé réservée à GitHub :

```bash
ssh-keygen -t ed25519 -N "" -C "deploy centre-affaires" -f deploy_centre_affaires
```

Sur le serveur, autoriser sa partie publique :

```bash
echo "<contenu de deploy_centre_affaires.pub>" | sudo -u deploy tee -a /home/deploy/.ssh/authorized_keys
sudo -u deploy chmod 600 /home/deploy/.ssh/authorized_keys
```

Relever l'empreinte du serveur depuis votre poste, et la comparer à celle
qu'affiche `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` sur le serveur :

```bash
ssh-keyscan -t ed25519 <IPv4 du VPS>
```

## 4. Base de production

Une seule fois (ADR 003, « Reste à faire »). À faire **depuis un clone propre,
sans `.env.local`** : le fichier de dev l'emporterait sur certaines variables,
et le script de provision y écrirait l'URL de production.

```bash
git clone https://github.com/AceOSolo/centre-affaires.git prod && cd prod && npm ci

# URL du rôle propriétaire de la branche `production` (console Neon → Connect).
export DATABASE_URL='<URL avec pooler>'
export DATABASE_URL_UNPOOLED='<URL directe>'
npx drizzle-kit migrate
node infra/provision-role-applicatif.mjs   # affiche APP_DATABASE_URL : la noter

export APP_DATABASE_URL='<valeur affichée>'
node infra/configurer-centre.mjs
node infra/ajouter-membre-staff.mjs <votre adresse> --role admin --nom "Prénom Nom"
```

Par la suite, toute migration se joue de la même façon **avant** de fusionner
sur `main` le code qui en dépend.

Dans la console Neon, Neon Auth de la branche `production` : ajouter
`https://www.handfield.fr` aux domaines de confiance, sinon la connexion est
refusée.

## 5. Secrets du serveur

```bash
sudo -u deploy nano /home/deploy/centre-affaires/.env
sudo -u deploy chmod 600 /home/deploy/centre-affaires/.env
```

Contenu : voir [`.env.example`](.env.example). Ce fichier ne quitte jamais le
serveur.

## 6. Réglages du dépôt GitHub

Settings → Secrets and variables → Actions :

| Type | Nom | Valeur |
| --- | --- | --- |
| Variable | `VPS_HOST` | IPv4 du VPS |
| Variable | `VPS_USER` | `deploy` |
| Secret | `VPS_SSH_KEY` | contenu de `deploy_centre_affaires` (partie privée) |
| Secret | `VPS_KNOWN_HOSTS` | ligne renvoyée par `ssh-keyscan` à l'étape 3 |

Settings → Pages : désactiver GitHub Pages.

Puis Actions → ci → Run workflow sur `main` : premier déploiement. Sur le
serveur, `docker compose ps` doit montrer `app` en `healthy`. Le site ne répond
qu'à ses domaines : il sera joignable une fois le DNS en place.

## 7. DNS chez OVH

Web Cloud → Noms de domaine → `handfield.fr` → Zone DNS.

| Sous-domaine | Type | Cible |
| --- | --- | --- |
| *(vide)* | A | IPv4 du VPS |
| *(vide)* | AAAA | IPv6 du VPS |
| `www` | A | IPv4 du VPS |
| `www` | AAAA | IPv6 du VPS |

Supprimer les anciens enregistrements A, AAAA et CNAME de ces deux noms (ancien
hébergement, GitHub Pages) et vérifier l'onglet « Redirection ». **Ne pas
toucher aux MX, SPF et DKIM** : ils portent les e-mails du domaine.

Dès que le DNS a propagé, Caddy obtient les certificats seul. Vérifier :

```bash
curl -I https://www.handfield.fr   # 200
curl -I https://handfield.fr       # 301 vers https://www.handfield.fr/
```

## Au quotidien

Sur le serveur, dans `/home/deploy/centre-affaires` :

```bash
docker compose ps                 # état des services
docker compose logs -f app        # journaux de l'application
docker compose logs -f caddy      # certificats, requêtes
```

Revenir en arrière : `git revert` du commit fautif sur `main`, qui redéploie la
version précédente.
