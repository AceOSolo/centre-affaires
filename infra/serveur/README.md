# Mise en production sur le VPS de production

Le choix et ses raisons : [ADR 013](../../docs/decisions/013-hebergement-vps-de-production.md),
amendé par l'[ADR 051](../../docs/decisions/051-nginx-devant-l-application.md)
(nginx) ; la base : [ADR 042](../../docs/decisions/042-mysql-sur-le-vps.md).

L'application tourne dans un conteneur Docker sur le VPS de production (Debian),
à côté des sites qu'il héberge déjà. Elle n'écoute que sur `127.0.0.1:3100`
(3000 est pris par Open WebUI) ; c'est le nginx en place qui sert le domaine
et HTTPS. La base MySQL 8.4 tourne sur
le même serveur, dans un conteneur du même compose, sans port publié : seuls
l'application et l'outil de migration l'atteignent (ADR 042).

**Il n'y a plus de déploiement automatique.** Le job `deploy` de la CI, qui
construisait l'image et la lançait sur le serveur à chaque push sur `main`, a
été retiré le 15/10/2026 (commit `e469801`, passage à MySQL) et n'est pas
rétabli. Il a tourné jusqu'au 06/10/2026 : c'est la version qui est en ligne,
celle d'avant MySQL. Chaque version se met donc en ligne **à la main**
(section 4). Rétablir le déploiement automatique est une décision en attente
(dernière section).

Ce document décrit l'installation, à faire une fois (sections 1 à 3 et 5 à
9), et la mise en ligne d'une version, à refaire à chaque fois (section 4).

## 1. Docker sur le serveur

S'il n'y est pas déjà (`docker compose version` pour vérifier) :

```bash
curl -fsSL https://get.docker.com | sudo sh
```

Docker ne touche ni à nginx ni aux sites existants : le conteneur n'est
joignable que depuis le serveur lui-même.

## 2. Compte de déploiement

```bash
sudo adduser --disabled-password --gecos "" deploy
sudo usermod -aG docker deploy
sudo -u deploy mkdir -p -m 700 /home/deploy/.ssh /home/deploy/centre-affaires
```

Être membre du groupe `docker` équivaut à être root sur la machine. Le compte
n'a pas de mot de passe : on y passe depuis son propre compte par
`sudo -iu deploy` (section 4). Il possède le dossier
`/home/deploy/centre-affaires`, son `.env` et la crontab des tâches de nuit.

**Clé SSH du déploiement automatique : seulement s'il est rétabli** (dernière
section). Elle ne doit alors exister que dans les secrets GitHub. Tant que le
déploiement automatique est suspendu, ne pas la créer ; si celle du 06/10
existe encore (`/home/deploy/.ssh/authorized_keys`, secret `VPS_SSH_KEY` du
dépôt), elle ne sert à rien et donne un accès équivalent à root : la retirer
des deux est plus sûr.

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

## 3. Secrets du serveur

```bash
sudo -u deploy nano /home/deploy/centre-affaires/.env
sudo -u deploy chmod 600 /home/deploy/centre-affaires/.env
```

Contenu : voir [`.env.example`](.env.example). Ce fichier ne quitte jamais le
serveur, et c'est lui qui configure aussi la base : il y a un seul fichier.

- `DB_ADMIN_PASSWORD` : mot de passe de `root` MySQL, fixé **au premier
  démarrage du volume** `db-data`. `DB_PASSWORD` : celui de l'utilisateur
  applicatif `DB_USER`. Deux mots de passe aléatoires distincts
  (`openssl rand -base64 24`). `DB_HOST` vaut `db` (le compose le force pour
  `app` et `migrer`).
- `AUTH_SECRET` : `openssl rand -base64 32`. `AUTH_SKIP_EMAIL_VERIFICATION`
  reste à `false` ; l'application refuse de démarrer en production avec
  `true`.
- L'application est publiée sur `127.0.0.1:3100`, 3000 étant pris par
  Open WebUI (ADR 051). Si `sudo ss -ltnp | grep ':3100 '` montre que 3100
  est pris par autre chose que l'application, y ajouter
  `PORT_LOCAL=<autre port>` et reporter ce port dans
  `nginx-handfield-https.conf` (`proxy_pass`).
- La clé de chiffrement des documents se crée et se sauvegarde hors du
  serveur comme indiqué à « Chiffrement des documents », plus bas.
- `IMAGE_TAG` (la version en service) et `DOLIBARR_API_TOKEN` : section 4.3.

## 4. Mettre en ligne une version, à la main

À faire pour chaque version, en reprenant ce que faisait l'ancien job
`deploy` : construire l'image, la publier, déposer la configuration sur le
serveur, lancer, migrer, vérifier. Ne mettre en ligne qu'un commit de `main`
dont la CI est verte (onglet Actions du dépôt).

### 4.1 Construire et publier l'image

Sur un poste qui a Docker, **jamais sur le VPS** : `next build` demande plus
de mémoire qu'il n'en a (`Dockerfile`). La construction n'exige aucun
secret. Dans un terminal bash, à la racine d'un clone du dépôt :

```bash
git checkout main && git pull
TAG=$(git rev-parse HEAD)
docker build -t ghcr.io/aceosolo/centre-affaires:$TAG .
docker login ghcr.io -u <compte GitHub>   # mot de passe : un jeton GitHub avec le droit write:packages
docker push ghcr.io/aceosolo/centre-affaires:$TAG
docker logout ghcr.io
echo $TAG                                 # à reporter dans IMAGE_TAG (4.3)
```

Le nom de l'image est celui qu'attend `compose.yml` ; l'étiquette est le
commit, qui dit quelle version tourne et permet d'y revenir. Si le poste n'a
pas la même architecture que le serveur (`uname -m` sur le serveur répond
`x86_64`, un Mac à puce Apple est en `arm64`), ajouter
`--platform linux/amd64` à `docker build`.

### 4.2 Déposer la configuration sur le serveur

`compose.yml`, `sauvegarde.sh` et les deux fichiers nginx suivent le dépôt.
Depuis le poste, à la racine du clone (`scp -P <port>` si SSH n'écoute pas
sur 22) :

```bash
scp infra/serveur/compose.yml infra/serveur/sauvegarde.sh infra/serveur/nginx-handfield-*.conf <vous>@<serveur>:/tmp/
```

Puis sur le serveur, depuis son propre compte :

```bash
sudo install -o deploy -g deploy -m 644 /tmp/compose.yml /tmp/nginx-handfield-http.conf /tmp/nginx-handfield-https.conf /home/deploy/centre-affaires/
sudo install -o deploy -g deploy -m 755 /tmp/sauvegarde.sh /home/deploy/centre-affaires/
rm /tmp/compose.yml /tmp/sauvegarde.sh /tmp/nginx-handfield-*.conf
```

Un fichier nginx qui a changé se réinstalle ensuite comme en section 7
(recopie dans `sites-available`, `nginx -t`, rechargement).

### 4.3 Le `.env`

`sudo -u deploy nano /home/deploy/centre-affaires/.env` (section 3), modèle
[`.env.example`](.env.example) :

- `IMAGE_TAG=<l'étiquette de 4.1>`. `compose.yml` refuse de démarrer sans
  elle : sans étiquette, Docker prendrait `latest`, qui est sur GHCR l'image
  publiée par l'ancien job le 06/10/2026, d'avant MySQL.
- `DOLIBARR_API_TOKEN` : `openssl rand -base64 32`, remis au développeur
  Dolibarr. Sans lui, l'API des devis et le webhook des produits n'existent
  pas (ADR 043, ADR 049, `docs/integrations/dolibarr.md`).
- Toute variable apparue dans le modèle depuis la mise en ligne précédente.

**Première mise en ligne de la version MySQL.** Le `.env` de la version du
06/10 est celui de Neon : il se refait d'après le modèle. Ses variables
`APP_DATABASE_URL`, `NEON_AUTH_*` et `AWS_*` ne sont plus lues : les retirer.
Reprendre telles quelles celles qui existent toujours (`APP_URL`,
`DOCUMENTS_ENCRYPTION_KEY` et sa version, `SECRETS_ENCRYPTION_KEY`,
`MAINTENANCE_TOKEN`, `GOOGLE_*`, `SMTP_*`, `MAIL_FROM`), créer les nouvelles
(`DB_*`, `AUTH_SECRET`, `S3_*`) comme en section 3. `PORT_LOCAL=3100`, s'il y
figure, peut rester : c'est la valeur par défaut. La base MySQL part vide,
rien n'est repris de Neon (ADR 042) : si des données réelles ont été saisies
dans la version du 06/10, les relever avant la bascule.

### 4.4 Lancer la version et migrer la base

Sur le serveur, sous le compte `deploy` :

```bash
sudo -iu deploy
cd ~/centre-affaires
docker login ghcr.io -u <compte GitHub>   # jeton avec le droit read:packages, si le paquet est privé
docker compose pull app                   # l'image IMAGE_TAG ; `migrer` utilise la même
docker logout ghcr.io                     # aucun identifiant ne reste sur le serveur
docker compose run --rm migrer            # démarre `db` au besoin ; structure, règles, droits
docker compose up -d --wait               # recrée `app` sur la nouvelle image, attend qu'il soit sain
```

**`docker compose run --rm migrer` est indispensable à chaque mise en
ligne**, même quand aucune migration n'est annoncée. Il applique les
migrations de structure que la base n'a pas encore (`src/db/migrations/` :
`0000`, puis celles du 20/10/2026 — `0001` devis, `0002` courrier, `0003`
comptes — et toute suivante) et rejoue les règles métier (`src/db/regles/`)
quand elles ont changé. Il se rejoue sans risque. Lancé avant `up`, il fait
démarrer la nouvelle version sur une base déjà à sa structure. Avant une
migration risquée, une sauvegarde à la main (`bash sauvegarde.sh`,
section 9) tient lieu de point de retour.

À la première mise en service de la base, poursuivre par la section 5.

### 4.5 Vérifier

Sous le compte `deploy`, dans `~/centre-affaires` :

```bash
docker compose ps                   # `db` et `app` en healthy
curl -I http://127.0.0.1:3100/      # l'application répond, sans nginx
curl -I https://www.handfield.fr    # 200, par nginx
```

**nginx**, depuis son propre compte : les fichiers installés doivent être
ceux du dépôt, et la configuration valide.

```bash
sudo grep -Rl handfield /etc/nginx/sites-enabled/ /etc/nginx/conf.d/
sudo diff /home/deploy/centre-affaires/nginx-handfield-http.conf  /etc/nginx/sites-available/nginx-handfield-http.conf
sudo diff /home/deploy/centre-affaires/nginx-handfield-https.conf /etc/nginx/sites-available/nginx-handfield-https.conf
sudo nginx -t
```

La première commande doit citer les deux fichiers `nginx-handfield-*.conf`
et eux seuls, les deux `diff` ne rien afficher. Sinon, réinstaller les
fichiers du dépôt comme en section 7. Le fichier HTTPS doit en particulier
contenir `proxy_pass http://127.0.0.1:3100` et
`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for`.

**Adresse IP des visiteurs.** Se connecter une fois sur
`https://www.handfield.fr/auth/connexion`, puis, sous le compte `deploy` :

```bash
docker compose logs app | grep -i "could not determine a client IP"
```

La commande ne doit rien afficher. Cet avertissement de Better Auth (écrit
une fois par démarrage) signale qu'aucune adresse de visiteur n'est lue :
tous partageraient le même compteur de tentatives de connexion et de
demandes (ADR 047). Contrôle complémentaire, sur la session qui vient
d'être ouverte (mot de passe : `DB_ADMIN_PASSWORD`) :

```bash
docker compose exec db mysql -uroot -p centre_affaires -e "SELECT ip_address, created_at FROM auth_sessions ORDER BY created_at DESC LIMIT 1"
```

(`centre_affaires` : la valeur de `DB_NAME`.)

`ip_address` doit être l'adresse publique du poste qui s'est connecté, et non
celle d'un réseau Docker (souvent en `172.`) ni `127.0.0.1`. Dans les deux
cas d'échec, vérifier la ligne `X-Forwarded-For` du fichier nginx.

**Tâches de nuit** : `sudo -u deploy crontab -l` montre la reconduction
(3 h 05), la purge (3 h 15) et la sauvegarde (3 h 45), et **aucune ligne
`…/api/maintenance/facturation`** : le lot de facturation est arrêté, la
facturation est tenue dans Dolibarr (ADR 046). Si elle y est encore, la
supprimer (`sudo -u deploy crontab -e`) ; la route répond `410`.

### Revenir à la version précédente

Remettre dans le `.env` l'`IMAGE_TAG` de la version précédente, puis, sous le
compte `deploy`, refaire 4.4 sans `migrer`. Si la version fautive a modifié
la base, restaurer d'abord celle-ci depuis le lot de la veille
(`docs/exploitation/restauration.md`) : l'ancienne version ne connaît pas la
nouvelle structure.

### Si le paquet GitHub ne s'ouvre pas

`docker push` et `docker compose pull` demandent un jeton GitHub (classique)
d'un compte qui a accès au paquet `centre-affaires` du compte `aceosolo` sur
GitHub Container Registry : `write:packages` pour publier, `read:packages`
pour tirer. Le jeton se saisit au `docker login` ; `docker logout` l'efface
du poste ou du serveur.

Vérifier aussi, une fois, dans le dépôt GitHub : Settings → Pages, GitHub
Pages désactivé (une première tentative y avait publié le site, ADR 013).

## 5. Base de production : première mise en service

Une seule fois, quand la base MySQL est neuve : à la première mise en ligne
de la version MySQL, après la section 4.4. Sur le serveur, sous le compte
`deploy` (le service `migrer` utilise la même image que `app`, qui contient
`infra/` et `src/db/`) :

```bash
cd /home/deploy/centre-affaires
# `docker compose run --rm migrer` a déjà créé la base et DB_USER, appliqué
# structure et règles, donné les droits (4.4).
docker compose run --rm migrer node infra/configurer-centre.mjs
docker compose run --rm migrer node infra/catalogue.mjs
docker compose run --rm migrer node infra/ajouter-membre-staff.mjs <votre adresse> --role admin --nom "Prénom Nom"
docker compose restart app
```

- `configurer-centre.mjs` pose l'identité du centre et ses horaires
  d'ouverture. `catalogue.mjs` pose le parc réel (deux salles avec leurs
  photos, neuf bureaux, quarante boîtes aux lettres) et la grille tarifaire
  de départ (ADR 009). **Sans le catalogue, la page d'accueil publique ne
  propose ni salle ni bureau**, et la domiciliation n'a pas de prix.
- Les prix des services du courrier (ouverture, numérisation, réexpédition,
  page) ne sont posés par aucun script : ils arrivent de Dolibarr par son
  webhook (ADR 049, `docs/integrations/dolibarr-produits.md`), ou se
  saisissent à l'écran Services. Tant qu'ils manquent, la page d'accueil
  n'affiche pas la rubrique « À la demande » de la domiciliation.
- **Jamais `seed-demo.mjs` en production** : ses clients, réservations et
  prix sont inventés pour le développement.
- Aucune annonce (`/annonces`) n'est créée : elles se rédigent à l'écran
  Annonces du back-office.

- Le migrateur se connecte avec `DB_ADMIN_USER` (root), qui seul peut définir
  la structure, et donne à `DB_USER` les droits de lecture et d'écriture, sans
  jamais `CREATE`, `ALTER` ni `DROP`. Il se rejoue sans risque : les règles
  métier (triggers, routines) sont rejouées, la structure ne l'est qu'une fois.
- Le service `migrer` est du profil `outils` : `docker compose up` ne le
  démarre pas, `docker compose run --rm migrer` si.
- Le serveur MySQL n'écoute sur aucun port de l'hôte. Pour inspecter la base :
  `docker compose exec db mysql -uroot -p` (le mot de passe est
  `DB_ADMIN_PASSWORD`).

Ce premier exploitant inscrit ensuite le reste de l'équipe depuis l'écran
Équipe du back-office (`/equipe`).

Par la suite, chaque version se migre **sur le serveur**, une fois son image
tirée : `docker compose run --rm migrer` (section 4.4). Les migrations ne
sont jamais jouées par la CI. Avant une migration risquée, une sauvegarde à
la main (`bash sauvegarde.sh`, section 9) tient lieu de point de retour.

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
ils portent les e-mails du domaine. Les enregistrements de Brevo s'y
ajoutent, sans les remplacer (étape 8).

L'IPv4 du serveur figure dans l'espace client OVH (Bare Metal Cloud → VPS), ou
dans la zone DNS d'un autre domaine déjà hébergé dessus.

## 7. nginx et certificat

Le serveur web du VPS est nginx, pas Apache
([ADR 051](../../docs/decisions/051-nginx-devant-l-application.md)). Deux
fichiers du dépôt lui confient le domaine : `nginx-handfield-http.conf`
(port 80 : validation Let's Encrypt et redirection vers HTTPS), puis
`nginx-handfield-https.conf` (port 443 : proxy vers `127.0.0.1:3100`), activé
une fois le certificat obtenu.

**Déjà en place depuis l'installation du 06/10/2026** : `www.handfield.fr`
est servi par nginx. À chaque mise en ligne, il suffit de vérifier que la
configuration installée est celle du dépôt (section 4.5). La suite de cette
section sert à une installation neuve ou à une réparation.

Une fois le DNS modifié (section 6), en root sur le serveur. Aucun autre site
nginx ne doit déjà déclarer le domaine : la première commande ne doit rien
afficher. Si elle cite un fichier (ancien site), supprimer son lien dans
`sites-enabled`.

```bash
grep -Rl handfield /etc/nginx/sites-enabled/ /etc/nginx/conf.d/

mkdir -p /var/www/letsencrypt/.well-known/acme-challenge
cp /home/deploy/centre-affaires/nginx-handfield-*.conf /etc/nginx/sites-available/
ln -s /etc/nginx/sites-available/nginx-handfield-http.conf /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

echo ok > /var/www/letsencrypt/.well-known/acme-challenge/test
for d in handfield.fr www.handfield.fr; do echo "$d -> $(getent ahosts $d | awk '{print $1}' | sort -u | xargs) | test : $(curl -s http://$d/.well-known/acme-challenge/test)"; done
```

Les deux lignes doivent montrer l'IPv4 du serveur, seule, et `test : ok`.
Toute autre adresse, IPv6 comprise (Let's Encrypt essaie l'IPv6 en premier),
est une ligne à supprimer dans la zone DNS (section 6). Tant que ce n'est pas
le cas, ne pas lancer certbot : Let's Encrypt bloque après cinq échecs par
heure. Relancer la boucle après chaque modification du DNS.

Puis, d'un seul tenant : le bloc HTTPS ne s'active que si certbot a réussi.
Sans certificat, nginx refuserait de démarrer, et avec lui tous les sites du
serveur.

```bash
apt install certbot   # s'il n'y est pas
certbot certonly --webroot -w /var/www/letsencrypt \
  -d www.handfield.fr -d handfield.fr \
  --deploy-hook "systemctl reload nginx" \
  && ln -sf /etc/nginx/sites-available/nginx-handfield-https.conf /etc/nginx/sites-enabled/ \
  && nginx -t && systemctl reload nginx
```

Si `nginx -t` échoue un jour avec le bloc HTTPS actif, retirer son lien
aussitôt (`rm /etc/nginx/sites-enabled/nginx-handfield-https.conf`) : nginx
continue de servir sa configuration précédente, mais ne redémarrerait pas.

Le renouvellement est automatique (minuteur de certbot) et recharge nginx.
Vérifier :

```bash
curl -I https://www.handfield.fr   # 200
curl -I https://handfield.fr       # 301 vers https://www.handfield.fr/
```

Les deux fichiers nginx sont redéposés dans `/home/deploy/centre-affaires/` à
chaque mise en ligne (section 4.2). S'ils changent dans le dépôt, les
recopier dans `sites-available` puis `nginx -t && systemctl reload nginx`.

## 8. Courriels avec Brevo

L'application prévient les clients à l'arrivée et à la numérisation de leur
courrier, et le centre à chaque demande d'ouverture (ADR 015). L'envoi passe
par le SMTP de Brevo, prestataire français hébergé en Europe.

**Authentifier le domaine expéditeur**, sans quoi les messages finissent en
indésirables. Dans Brevo : Expéditeurs, domaines et IP dédiées → Domaines →
ajouter `handfield.fr`. Brevo affiche les enregistrements à créer (code de
vérification, DKIM, DMARC) : les ajouter dans la zone DNS OVH (étape 6),
**sans modifier ni supprimer ceux qui existent** — ils portent les e-mails
actuels du domaine. S'il existe déjà un enregistrement SPF (`v=spf1 …`), y
ajouter `include:spf.brevo.com` dans la même ligne : un domaine n'a qu'un seul
SPF. Attendre que Brevo affiche le domaine comme authentifié.

**Créer la clé SMTP** : SMTP & API → onglet SMTP → générer une clé. Dans le
`.env` du serveur : `SMTP_USER` reçoit l'identifiant affiché par Brevo (il
contient un `@`, c'est normal), `SMTP_PASSWORD` la clé SMTP — pas la clé
d'API. `MAIL_FROM` utilise une adresse du domaine authentifié.

**Désactiver le suivi** des ouvertures et des clics dans les réglages des
e-mails transactionnels : il ajouterait un pixel espion aux messages et
ferait passer les liens vers l'espace client par un domaine de Brevo.

**RGPD** : Brevo est sous-traitant des adresses des clients. Accepter son
accord de traitement des données (DPA, dans les paramètres du compte) et
l'inscrire au registre des traitements du centre.

Vérifier : relancer l'application (`docker compose up -d`), puis sur la fiche
d'un client de test, donner l'accès à sa propre adresse — le courriel
d'invitation doit arriver.

## 9. Sauvegardes

Le choix et ses raisons : [ADR 022](../../docs/decisions/022-sauvegardes-et-plan-de-reprise.md).
Restauration : [`docs/exploitation/restauration.md`](../../docs/exploitation/restauration.md).
Plan de reprise : [`docs/exploitation/plan-de-reprise.md`](../../docs/exploitation/plan-de-reprise.md).

Chaque nuit, `sauvegarde.sh` produit un lot : le dump de la base
(`mysqldump --single-transaction --routines --triggers --events`, compressé),
la copie du bucket `uploads` et les fichiers de configuration du serveur. Le lot est
chiffré sur le serveur pour des clés publiques, envoyé hors du serveur, puis
relu. Sont gardés le dernier lot de chacun des 7 derniers jours, des 4
dernières semaines et des 12 derniers mois. Le script se dépose à chaque
mise en ligne, comme `compose.yml` (section 4.2). La version du 06/10 était
celle de Neon (`pg_dump`) : si la sauvegarde était déjà installée, refaire
`sauvegarde.env` d'après le modèle MySQL et créer l'utilisateur `sauvegarde`
(étapes 3 et 5 ci-dessous).

**1. Outils**, en root :

```bash
apt install age rclone
```

`mysqldump` est celui du conteneur `db` (`docker compose exec`) : rien à
installer pour lui, et sa version est celle du serveur.

**2. Clés de chiffrement, sur un poste et non sur le serveur.** Chaque détenteur
(deux au moins, plan de reprise) crée sa paire de clés :

```bash
age-keygen -o identite-sauvegarde-<prenom>.txt   # affiche la clé publique age1…
```

La clé privée va au coffre (plan de reprise, « Secrets »), jamais sur le
serveur : le script refuse de tourner s'il en trouve une. Sur le serveur, les
seules clés publiques, une par ligne :

```bash
sudo -u deploy nano /home/deploy/centre-affaires/sauvegarde-destinataires.txt
```

**3. Utilisateur de lecture sur la base.** Sur le serveur, avec `root` :

```bash
cd /home/deploy/centre-affaires
docker compose exec db mysql -uroot -p
```

```sql
CREATE USER 'sauvegarde'@'%' IDENTIFIED BY '<openssl rand -base64 24>';
GRANT SELECT, SHOW VIEW, TRIGGER, EVENT ON centre_affaires.* TO 'sauvegarde'@'%';
GRANT SHOW_ROUTINE ON *.* TO 'sauvegarde'@'%';
```

Le mot de passe va dans `MYSQL_PWD` de `sauvegarde.env`. Ces droits donnent la
lecture de toutes les tables, des triggers, des routines et des événements,
sans aucune écriture. Le dump (`--single-transaction`) ne verrouille pas les
tables : l'application continue d'écrire pendant la sauvegarde. À éprouver au
premier exercice (restauration, « Exercices ») : si `mysqldump` réclame un
droit de plus, le noter ici.

**4. Destination hors du serveur.** Un bucket S3 privé, en UE, dans une autre
région que le VPS (par exemple OVHcloud Object Storage), avec un utilisateur
dont les clés ne servent qu'à lui.

**5. Configuration**, d'après [`sauvegarde.env.example`](sauvegarde.env.example) :

```bash
sudo -u deploy nano /home/deploy/centre-affaires/sauvegarde.env
sudo -u deploy chmod 600 /home/deploy/centre-affaires/sauvegarde.env
```

**6. Premier passage, à la main**, puis une restauration d'essai
(`docs/exploitation/restauration.md`) : une sauvegarde jamais relue n'est pas
une sauvegarde.

```bash
sudo -u deploy bash /home/deploy/centre-affaires/sauvegarde.sh
tail /home/deploy/centre-affaires/sauvegardes.log
```

**7. Crontab du compte `deploy`**, à côté de la purge du courrier :

```cron
# Sauvegarde nocturne chiffrée, hors serveur (ADR 022). Après la purge de
# 3 h 15 : un lot ne contient pas ce qui vient d'arriver à échéance.
45 3 * * * /bin/bash /home/deploy/centre-affaires/sauvegarde.sh >/dev/null 2>&1
```

Le script écrit lui-même son journal, `~/centre-affaires/sauvegardes.log`
(autre chemin : `SAUVEGARDE_JOURNAL` devant la commande). En cas d'échec, il
sort avec un code non nul, écrit la cause au journal et dans syslog
(`journalctl -t centre-affaires-sauvegarde`), et appelle
`SAUVEGARDE_SIGNAL_URL` suivi de `/fail` s'il est réglé. Un lot à moitié
envoyé est effacé, ou l'est au passage suivant.

La base et ses sauvegardes sont sur le même serveur : **le lot hors serveur
est la seule protection contre la perte du VPS**. La surveiller comme telle.
Le volume Docker `db-data` n'est pas une sauvegarde.

**Surveillance.** Lire la fin du journal chaque semaine. Faire un exercice de
restauration chaque trimestre et le consigner dans `restauration.md`. Sans
service de surveillance (`SAUVEGARDE_SIGNAL_URL`), une crontab effacée ou un
serveur arrêté ne se voient qu'à la lecture du journal.

## Au quotidien

Sur le serveur, dans `/home/deploy/centre-affaires` :

```bash
docker compose ps             # état de l'application
docker compose logs -f app    # journaux de l'application
docker compose logs -f db     # journaux de MySQL
tail sauvegardes.log          # dernières sauvegardes (section 9)
```

Journaux nginx du site : `/var/log/nginx/handfield-*.log`.

## Conservation du courrier

Les numérisations de courrier et le journal de leurs consultations ne se
gardent que le temps fixé par le centre (12 mois par défaut, colonnes
`mail_*_retention_months` de `tenants`).
Les coordonnées des personnes qui ont déposé une demande sur la page publique
(nom, adresse, téléphone) sont effacées au même rythme : 12 mois par défaut
après la fin du créneau demandé, ou après l'annulation si elle précède
(`public_request_retention_months`, ADR 020). La réservation reste,
anonymisée.
Les prospects sans suite, les clients partis et les traces des accès et des
membres retirés sont anonymisés au terme de leur durée (R29, ADR 040), sauf
exclusion (facture non soldée, contrat vivant…) ; les factures émises ne sont
jamais touchées.
Le journal des messages envoyés (ADR 038) est purgé au terme de sa durée
(12 mois par défaut, `notification_log_retention_months`), les photos
d'états des lieux et le journal de leurs consultations au terme des leurs
(ADR 039) : le fichier est effacé du stockage, la ligne reste, marquée.
Chaque purge et chaque anonymisation a sa propre transaction et son propre
filet : l'échec de l'une (une panne du stockage, par exemple) n'en retient
aucune autre, et ce qui ne dépend que de la base passe avant le stockage
(ADR 041). Une étape en échec est nommée dans la réponse (`failed`), qui est
alors un `500` : la tâche sort en erreur, et la nuit suivante la rejoue.
Toutes ces durées se règlent à l'écran **Configuration du centre**
(`/configuration`, exploitant), et non plus dans `infra/configurer-centre.mjs`.
La purge est une route de l'application, appelée chaque nuit ; elle exige
`MAINTENANCE_TOKEN` dans le `.env` du serveur.

Dans la crontab du compte `deploy` (`sudo -u deploy crontab -e`) :

```cron
# Purge du courrier échu, des coordonnées des demandes publiques échues, du
# journal des messages et des photos d'états des lieux échues, et
# anonymisation RGPD, chaque nuit à 3 h 15 (ADR 015, 020, 038, 039, 040).
15 3 * * * cd /home/deploy/centre-affaires && docker compose exec -T app node -e "fetch('http://127.0.0.1:3000/api/maintenance/conservation',{method:'POST',headers:{authorization:'Bearer '+process.env.MAINTENANCE_TOKEN}}).then(async r=>{console.log(r.status,await r.text());process.exit(r.ok?0:1)})"
```

La commande tourne dans le conteneur, qui a déjà le jeton dans son
environnement : il n'est écrit ni dans la crontab ni dans les journaux. Elle
affiche le nombre de numérisations et de consultations purgées, de demandes
anonymisées, d'entreprises anonymisées (avec leurs contacts, accès et plis),
de personnes retirées anonymisées, de messages effacés du journal, de photos
d'états des lieux et de consultations de ces photos purgées — des nombres,
jamais un nom :
`{"publicRequests":0,"anonymizedClients":{"clients":0,"contacts":0,"accesses":0,"mailSenders":0},"anonymizedMembers":{"accesses":0,"staff":0},"notificationDeliveries":0,"views":0,"inspectionPhotoViews":0,"scans":0,"inspectionPhotos":0,"failed":[]}`.
Une étape en échec vaut `null` et figure dans `failed` (`"scans":null,
"failed":["scans"]`) : les autres ont eu lieu.
Le journal de l'application (`docker compose logs app`) en garde une ligne
« Conservation (RGPD) : … » par nuit, et une ligne « Conservation : l'étape
« … » a échoué » par étape à reprendre.

## Reconduction tacite des contrats

Tâche de la facturation (R10,
[ADR 033](../../docs/decisions/033-taches-planifiees-de-la-facturation.md)),
appelée comme la purge, avec le même `MAINTENANCE_TOKEN` : **chaque nuit**,
la reconduction tacite des contrats. Un contrat dont le préavis ne peut plus
mettre fin au contrat à son terme est prolongé d'une période, et la
prolongation est inscrite à son journal (fiche du contrat). Avant la
sauvegarde de 3 h 45, pour qu'elle contienne les nouveaux termes.

**Le lot de facturation du 1er du mois est arrêté** : la facturation est
tenue dans Dolibarr ([ADR 046](../../docs/decisions/046-dolibarr-commercial-et-facturation-admin-par-produit.md)).
Si la crontab porte encore sa ligne (`…/api/maintenance/facturation`),
la retirer : la route répond `410` et ne prépare plus rien.

Dans la crontab du compte `deploy` (`sudo -u deploy crontab -e`) :

```cron
# Reconduction tacite des contrats, chaque nuit à 3 h 05 (ADR 033).
5 3 * * * cd /home/deploy/centre-affaires && docker compose exec -T app node -e "fetch('http://127.0.0.1:3000/api/maintenance/contrats',{method:'POST',headers:{authorization:'Bearer '+process.env.MAINTENANCE_TOKEN}}).then(async r=>{console.log(r.status,await r.text());process.exit(r.ok?0:1)})"
```

La reconduction répond `{"renewed":[…],"failures":[…]}` : un contrat dont la
ressource est déjà prise après le terme n'est pas prolongé, et figure dans
`failures` avec la cause, chaque nuit, jusqu'à ce que l'équipe libère la
ressource ou résilie le contrat.

## Chiffrement des documents

Les scans de courrier, les photos d'enveloppe et les photos d'états des lieux
sont chiffrés par l'application avant d'être déposés dans le stockage
(AES-256-GCM, R22, R33,
[ADR 020](../../docs/decisions/020-chiffrement-et-conservation-des-documents.md)).
Le stockage, et toute copie de la base ou du stockage, ne contiennent que
du chiffré.
Sans clé, l'application refuse de déposer un document plutôt que de le
stocker en clair.

### Créer la clé

Une fois, sur le serveur, avant la première mise en ligne qui chiffre :

```bash
openssl rand -base64 32
```

Dans `/home/deploy/centre-affaires/.env` :

```dotenv
DOCUMENTS_ENCRYPTION_KEY=<valeur affichée>
DOCUMENTS_ENCRYPTION_KEY_VERSION=1
```

Puis `docker compose up -d` pour que l'application la lise.

### Sauvegarder la clé hors du serveur

**Perdre cette clé, c'est perdre tous les documents chiffrés avec elle**, sans
aucun recours : personne ne peut les déchiffrer. La copie du
stockage (R30) ne sert à rien sans elle.

- La recopier, avec son numéro de version, dans le coffre-fort de mots de
  passe du centre, au nom de l'application et de l'environnement
  (« Handfield production — documents, clé 1 »). Une seconde copie hors ligne
  (papier sous enveloppe au coffre, ou clé USB chiffrée) protège contre la
  perte du coffre-fort.
- Jamais dans le dépôt, ni dans les secrets GitHub, ni à côté des sauvegardes
  du stockage : qui obtient les deux lit tout.
- Une clé par environnement. La clé de production ne sert jamais en
  développement ; c'est ce qui rend illisibles les documents d'une copie de la
  production restaurée en développement.

### Chiffrer les documents déposés avant le chiffrement

Les documents déposés avant cette mise en place restent lisibles en clair
(`mail_scans.encryption_key_version` nul). Le script
`infra/chiffrer-documents.ts` les chiffre, à leur place dans le stockage. Il
se lance **sur le serveur**, pour que la clé n'en sorte pas, dans le conteneur
d'outillage, qui lit le `.env` de production :

```bash
cd /home/deploy/centre-affaires
docker compose run --rm migrer node infra/chiffrer-documents.ts
```

Ce premier passage est un essai à blanc : il compte les documents à chiffrer
et vérifie la clé, sans rien modifier. Pour chiffrer, relancer la même
commande avec `--appliquer` à la fin. Puis relancer l'essai à blanc : il doit
répondre « Aucune numérisation à chiffrer ».

Le script se rejoue sans risque : un document déjà chiffré n'est plus repris,
une interruption se termine au passage suivant. Un document absent du
stockage, ou dont la taille ne correspond pas au dépôt, est signalé et laissé
tel quel : à examiner avant de relancer. Ne pas le lancer pendant la purge de
3 h 15.

Ensuite :

- si le stockage conserve les versions précédentes des objets (versionnement
  du bucket), les supprimer : les versions en clair y resteraient ;
- détruire les sauvegardes du stockage antérieures à la reprise : elles
  contiennent les documents en clair (B3). La sauvegarde nocturne suivante en
  produit de chiffrées.

### Changer de clé (rotation)

En cas de doute sur la clé (fuite, départ d'une personne qui y avait accès),
ou à intervalle fixé par le centre :

1. Générer une nouvelle clé (`openssl rand -base64 32`) et la sauvegarder hors
   du serveur, avec son numéro (2 si la courante est la 1).
2. Dans le `.env`, garder l'ancienne sous son numéro et poser la nouvelle :

   ```dotenv
   DOCUMENTS_ENCRYPTION_KEY=<nouvelle clé>
   DOCUMENTS_ENCRYPTION_KEY_VERSION=2
   DOCUMENTS_ENCRYPTION_KEY_1=<ancienne clé>
   ```

   puis `docker compose up -d`. Les nouveaux dépôts partent avec la clé 2 ;
   les anciens se lisent encore avec la clé 1. Si deux clés différentes
   portent le même numéro, l'application refuse de chiffrer comme de
   déchiffrer, plutôt que de se tromper de clé.
3. Lancer le script comme ci-dessus, essai à blanc puis `--appliquer` : il
   rechiffre avec la clé 2 tout ce qui l'était avec la clé 1 — les
   numérisations et les photos d'états des lieux dans le stockage (ADR 041),
   et les IBAN des mandats SEPA en base (ADR 034).
4. Quand l'essai à blanc ne trouve plus rien (ni numérisation, ni photo
   d'état des lieux, ni IBAN de mandat), retirer
   `DOCUMENTS_ENCRYPTION_KEY_1` du `.env` et relancer l'application.
5. Garder l'ancienne clé dans le coffre-fort tant qu'existent des sauvegardes
   du stockage ou de la base antérieures à la rotation : elles ne se lisent
   qu'avec elle (les IBAN des mandats y sont chiffrés avec elle). Après une
   fuite, ces sauvegardes sont à détruire.

## Déploiement automatique (suspendu)

Le job `deploy` de `.github/workflows/ci.yml` faisait, à chaque push sur
`main` dont la CI était verte, ce que la section 4 fait à la main (dernière
exécution le 06/10/2026) : construire l'image et la publier sur GHCR, étiquetée du commit et
`latest` ; recopier `compose.yml`, le fichier du serveur web et
`sauvegarde.sh` ; tirer l'image et relancer `app` (`docker compose up -d
--wait`). Il ne jouait pas les migrations. Il a été retiré le 15/10/2026
(commit `e469801`) ; son texte reste lisible dans l'historique
(`git show e469801^:.github/workflows/ci.yml`).

Le rétablir est **une décision en attente**. Il faudrait alors l'adapter à
nginx (les deux fichiers `nginx-handfield-*.conf`) et à `IMAGE_TAG` exigé
par `compose.yml`, trancher s'il joue `migrer`, recréer la clé SSH
(section 2) et reposer ou vérifier les réglages du dépôt (Settings → Secrets
and variables → Actions) :

| Type | Nom | Valeur |
| --- | --- | --- |
| Variable | `VPS_HOST` | adresse du serveur |
| Variable | `VPS_USER` | `deploy` |
| Variable | `VPS_PORT` | port SSH, seulement s'il n'est pas 22 |
| Secret | `VPS_SSH_KEY` | contenu de `deploy_centre_affaires` (partie privée) |
| Secret | `VPS_KNOWN_HOSTS` | ligne renvoyée par `ssh-keyscan` à l'étape 2 |
