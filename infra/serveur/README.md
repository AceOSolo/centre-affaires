# Mise en production sur le VPS de production

Le choix et ses raisons : [ADR 013](../../docs/decisions/013-hebergement-vps-de-production.md).

L'application tourne dans un conteneur Docker sur le VPS de production (Debian),
à côté des sites qu'il héberge déjà. Elle n'écoute que sur `127.0.0.1` ; c'est
l'Apache en place qui sert le domaine et HTTPS. La base MySQL 8.4 tourne sur
le même serveur, dans un conteneur du même compose, sans port publié : seuls
l'application et l'outil de migration l'atteignent (ADR 042).

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
- Si `sudo ss -ltnp | grep ':3000 '` montre que le port 3000 est déjà pris,
  y ajouter `PORT_LOCAL=<autre port>`.
- La clé de chiffrement des documents se crée et se sauvegarde hors du
  serveur comme indiqué à « Chiffrement des documents », plus bas.

## 4. Réglages du dépôt GitHub

Settings → Secrets and variables → Actions :

| Type | Nom | Valeur |
| --- | --- | --- |
| Variable | `VPS_HOST` | adresse du serveur |
| Variable | `VPS_USER` | `deploy` |
| Variable | `VPS_PORT` | port SSH, seulement s'il n'est pas 22 |
| Secret | `VPS_SSH_KEY` | contenu de `deploy_centre_affaires` (partie privée) |
| Secret | `VPS_KNOWN_HOSTS` | ligne renvoyée par `ssh-keyscan` à l'étape 2 |

Settings → Pages : désactiver GitHub Pages.

Puis Actions → ci → Run workflow sur `main` : premier déploiement. Il copie le
compose, tire l'image et démarre `db` puis `app`. Sur le serveur, dans
`/home/deploy/centre-affaires`, `docker compose ps` doit montrer `db` et
`app` en `healthy`, et `curl -I http://127.0.0.1:3000/` répondre.
L'application n'a pas encore de structure : l'étape suivante la crée.

## 5. Base de production

Sur le serveur, dans `/home/deploy/centre-affaires`, une fois l'image tirée par
le premier déploiement (le service `migrer` utilise la même image que `app`,
qui contient `infra/` et `src/db/`) :

```bash
cd /home/deploy/centre-affaires
docker compose run --rm migrer     # crée la base et DB_USER, applique structure et règles, donne les droits
docker compose run --rm migrer node infra/configurer-centre.mjs
docker compose run --rm migrer node infra/ajouter-membre-staff.mjs <votre adresse> --role admin --nom "Prénom Nom"
docker compose restart app
```

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

Par la suite, chaque version qui change la base se migre **sur le serveur,
après le déploiement** de l'image qui la porte : `docker compose run --rm
migrer`. Les migrations ne sont jamais jouées par la CI. Avant une migration
risquée, une sauvegarde à la main (`bash sauvegarde.sh`, section 9) tient lieu
de point de retour.

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
dernières semaines et des 12 derniers mois. Le script est déposé par chaque
déploiement, comme `compose.yml`.

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

Journaux Apache du site : `/var/log/apache2/handfield-*.log`.

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

## Reconduction tacite et lot de facturation planifiés

Deux tâches de la facturation (R10, R13,
[ADR 033](../../docs/decisions/033-taches-planifiees-de-la-facturation.md)),
appelées comme la purge, avec le même `MAINTENANCE_TOKEN` :

- **Chaque nuit**, la reconduction tacite des contrats : un contrat dont le
  préavis ne peut plus mettre fin au contrat à son terme est prolongé d'une
  période, et la prolongation est inscrite à son journal (fiche du contrat).
  Avant la sauvegarde de 3 h 45, pour qu'elle contienne les nouveaux termes.
- **Le 1er de chaque mois**, le lot de facturation du mois : les factures
  brouillons de chaque client, comme le bouton « Préparer » de
  `/factures/preparer`, au journal des lots sous « Tâche planifiée ». Rien
  n'est émis : l'équipe relit, puis émet. Après la reconduction de la nuit,
  pour que les contrats reconduits soient facturés.

Dans la crontab du compte `deploy` (`sudo -u deploy crontab -e`) :

```cron
# Reconduction tacite des contrats, chaque nuit à 3 h 05 (ADR 033).
5 3 * * * cd /home/deploy/centre-affaires && docker compose exec -T app node -e "fetch('http://127.0.0.1:3000/api/maintenance/contrats',{method:'POST',headers:{authorization:'Bearer '+process.env.MAINTENANCE_TOKEN}}).then(async r=>{console.log(r.status,await r.text());process.exit(r.ok?0:1)})"
# Lot de facturation du mois, le 1er à 6 h 00 (ADR 033).
0 6 1 * * cd /home/deploy/centre-affaires && docker compose exec -T app node -e "fetch('http://127.0.0.1:3000/api/maintenance/facturation',{method:'POST',headers:{authorization:'Bearer '+process.env.MAINTENANCE_TOKEN}}).then(async r=>{console.log(r.status,await r.text());process.exit(r.ok?0:1)})"
```

La reconduction répond `{"renewed":[…],"failures":[…]}` : un contrat dont la
ressource est déjà prise après le terme n'est pas prolongé, et figure dans
`failures` avec la cause, chaque nuit, jusqu'à ce que l'équipe libère la
ressource ou résilie le contrat. Le lot répond son bilan (brouillons créés,
complétés, lignes, avertissements), ou `409` si un lot tourne déjà : le
relancer à la main une fois l'autre terminé. Pour rejouer un autre mois :
`…/api/maintenance/facturation?mois=2026-10`.

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

Une fois, sur le serveur, avant le premier déploiement qui chiffre :

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

Revenir en arrière : `git revert` du commit fautif sur `main`, qui redéploie la
version précédente. Si une migration de base a été jouée entre-temps, la
restaurer d'abord depuis le lot de la veille (`docs/exploitation/restauration.md`).
