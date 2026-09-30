# Mise en production sur le VPS de production

Le choix et ses raisons : [ADR 013](../../docs/decisions/013-hebergement-vps-de-production.md).

L'application tourne dans un conteneur Docker sur le VPS de production (Debian),
à côté des sites qu'il héberge déjà. Elle n'écoute que sur `127.0.0.1` ; c'est
l'Apache en place qui sert le domaine et HTTPS. La base reste chez Neon.

Chaque push sur `main` dont la CI est verte déclenche le job `deploy` : l'image
est construite par GitHub, puis lancée sur le serveur. Ce document décrit
l'installation, à faire une fois. Tant qu'elle n'est pas terminée (variable
`VPS_HOST` absente), le job `deploy` ne s'exécute pas.

## 1. Docker sur le serveur

S'il n'y est pas déjà (`docker compose version` pour vérifier) :

```bash
curl -fsSL https://get.docker.com | sudo sh
```

Docker ne touche ni à Apache ni aux sites existants : le conteneur n'est
joignable que depuis le serveur lui-même.

## 2. Compte de déploiement

```bash
sudo adduser --disabled-password --gecos "" deploy
sudo usermod -aG docker deploy
sudo -u deploy mkdir -p -m 700 /home/deploy/.ssh /home/deploy/centre-affaires
```

Être membre du groupe `docker` équivaut à être root sur la machine : la clé de
ce compte ne doit exister que dans les secrets GitHub.

Sur votre poste, une clé réservée à GitHub :

```bash
ssh-keygen -t ed25519 -N "" -C "deploy centre-affaires" -f deploy_centre_affaires
```

Sur le serveur, autoriser sa partie publique :

```bash
echo "<contenu de deploy_centre_affaires.pub>" | sudo -u deploy tee -a /home/deploy/.ssh/authorized_keys
sudo -u deploy chmod 600 /home/deploy/.ssh/authorized_keys
```

Relever l'empreinte du serveur depuis votre poste (ajouter `-p <port>` si SSH
n'écoute pas sur 22), et la comparer à celle qu'affiche
`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` sur le serveur :

```bash
ssh-keyscan -t ed25519 <adresse du serveur>
```

## 3. Base de production

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

## 4. Secrets du serveur

```bash
sudo -u deploy nano /home/deploy/centre-affaires/.env
sudo -u deploy chmod 600 /home/deploy/centre-affaires/.env
```

Contenu : voir [`.env.example`](.env.example). Ce fichier ne quitte jamais le
serveur. Si `sudo ss -ltnp | grep ':3000 '` montre que le port 3000 est déjà
pris, y ajouter `PORT_LOCAL=<autre port>`.

## 5. Réglages du dépôt GitHub

Settings → Secrets and variables → Actions :

| Type | Nom | Valeur |
| --- | --- | --- |
| Variable | `VPS_HOST` | adresse du serveur |
| Variable | `VPS_USER` | `deploy` |
| Variable | `VPS_PORT` | port SSH, seulement s'il n'est pas 22 |
| Secret | `VPS_SSH_KEY` | contenu de `deploy_centre_affaires` (partie privée) |
| Secret | `VPS_KNOWN_HOSTS` | ligne renvoyée par `ssh-keyscan` à l'étape 2 |

Settings → Pages : désactiver GitHub Pages.

Puis Actions → ci → Run workflow sur `main` : premier déploiement. Sur le
serveur, dans `/home/deploy/centre-affaires`, `docker compose ps` doit montrer
`app` en `healthy`, et `curl -I http://127.0.0.1:3000/` répondre 200.

## 6. DNS chez OVH

Web Cloud → Noms de domaine → `handfield.fr` → onglet « Zone DNS ». Seules les
lignes dont le sous-domaine est vide ou `www`, de type A, AAAA ou CNAME, sont
concernées.

| Sous-domaine | Type | Cible |
| --- | --- | --- |
| *(vide)* | A | IPv4 du serveur, une seule ligne |
| `www` | CNAME | `handfield.fr.` (point final compris) |

Supprimer toutes les autres lignes A, AAAA et CNAME de ces deux noms (ancien
hébergement, GitHub Pages). Un AAAA oublié envoie les visiteurs en IPv6 vers
l'ancien site. `www` suit le domaine nu : un seul endroit à changer. Vérifier
aussi l'onglet « Redirection ». **Ne pas toucher aux MX, SPF, DKIM et DMARC** :
ils portent les e-mails du domaine.

L'IPv4 du serveur figure dans l'espace client OVH (Bare Metal Cloud → VPS), ou
dans la zone DNS d'un autre domaine déjà hébergé dessus.

## 7. Apache et certificat

Une fois le DNS propagé (`dig +short www.handfield.fr` renvoie l'adresse du
serveur), en root sur le serveur :

```bash
a2enmod proxy proxy_http headers ssl rewrite
mkdir -p /var/www/letsencrypt
cp /home/deploy/centre-affaires/apache-handfield.conf /etc/apache2/sites-available/
a2ensite apache-handfield
apache2ctl configtest && systemctl reload apache2

# Le bloc HTTPS du fichier ne s'active qu'une fois le certificat présent.
apt install certbot   # s'il n'y est pas
certbot certonly --webroot -w /var/www/letsencrypt \
  -d www.handfield.fr -d handfield.fr \
  --deploy-hook "systemctl reload apache2"
systemctl reload apache2
```

Le renouvellement est automatique (minuteur de certbot) et recharge Apache.
Vérifier :

```bash
curl -I https://www.handfield.fr   # 200
curl -I https://handfield.fr       # 301 vers https://www.handfield.fr/
```

Le fichier Apache est redéposé dans `/home/deploy/centre-affaires/` à chaque
déploiement. S'il change dans le dépôt, le recopier dans `sites-available` et
recharger Apache.

## Au quotidien

Sur le serveur, dans `/home/deploy/centre-affaires` :

```bash
docker compose ps             # état de l'application
docker compose logs -f app    # journaux de l'application
```

Journaux Apache du site : `/var/log/apache2/handfield-*.log`.

## Conservation du courrier

Les numérisations de courrier et le journal de leurs consultations ne se
gardent que le temps fixé par le centre (12 mois par défaut, colonnes
`mail_*_retention_months` de `tenants`, voir `infra/configurer-centre.mjs`).
La purge est une route de l'application, appelée chaque nuit ; elle exige
`MAINTENANCE_TOKEN` dans le `.env` du serveur.

Dans la crontab du compte `deploy` (`sudo -u deploy crontab -e`) :

```cron
# Purge du courrier échu, chaque nuit à 3 h 15 (ADR 015).
15 3 * * * cd /home/deploy/centre-affaires && docker compose exec -T app node -e "fetch('http://127.0.0.1:3000/api/maintenance/conservation',{method:'POST',headers:{authorization:'Bearer '+process.env.MAINTENANCE_TOKEN}}).then(async r=>{console.log(r.status,await r.text());process.exit(r.ok?0:1)})"
```

La commande tourne dans le conteneur, qui a déjà le jeton dans son
environnement : il n'est écrit ni dans la crontab ni dans les journaux. Elle
affiche le nombre de numérisations et de consultations purgées.

Revenir en arrière : `git revert` du commit fautif sur `main`, qui redéploie la
version précédente.
