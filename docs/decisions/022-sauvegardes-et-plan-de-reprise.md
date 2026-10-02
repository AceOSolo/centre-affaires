# ADR 022 — Sauvegardes et plan de reprise

**Date** : 2026-10-01
**Statut** : accepté

## Contexte

Le cahier des charges demande des sauvegardes testées, une restauration
documentée et un plan de reprise (R30). L'ADR 016 précise : une sauvegarde
nocturne de la base et une copie du stockage objet, chiffrées et hors du
serveur, **sans abonnement payant**.

Ce qui existe :

- **Neon** porte la base, les comptes (`neon_auth`) et le stockage objet
  (bucket `uploads`, courrier numérisé), en `aws-eu-central-1`. Sa
  restauration instantanée couvre une erreur récente. Sur le plan gratuit,
  sa fenêtre est courte. Elle ne protège ni contre la perte du projet ou du
  compte, ni contre une erreur découverte trop tard.
- **Le VPS** (ADR 013) ne détient que le rôle applicatif `app_centre`, soumis à
  la RLS. Le propriétaire de la base n'y figure pas, à dessein.
- **Les secrets** du serveur (`.env`) n'existent que sur lui. Deux d'entre eux
  sont irremplaçables :
  - `SECRETS_ENCRYPTION_KEY` : sans elle, le jeton Google est illisible ;
  - la clé de chiffrement des documents prévue par l'ADR 020 : sans elle, les
    numérisations chiffrées sont perdues.
- **Les numérisations** sont les données les plus sensibles du produit
  (ADR 015). Elles ne doivent pas quitter l'UE ni être lisibles hors de
  l'application.

## Décision

### Deux niveaux de reprise

1. **La restauration instantanée de Neon**, pour une erreur récente : rien à
   déchiffrer, comptes compris.
2. **Un lot nocturne**, sous la responsabilité du centre, pour tout le reste.
   C'est l'objet de cet ADR.

### Le lot nocturne

`infra/serveur/sauvegarde.sh`, lancé par la crontab du compte `deploy` à
3 h 45, produit un lot nommé par son instant UTC :

| Fichier | Contenu |
|---|---|
| `base.dump.age` | `pg_dump --format=custom` de toute la base, par la connexion directe |
| `stockage.tar.age` | copie du bucket `uploads` |
| `configuration.tar.age` | fichiers du serveur, dont le `.env` de l'application |
| `SHA256SUMS` | empreintes des trois fichiers |
| `manifeste.txt` | contenu du lot, envoyé en dernier : il marque le lot comme complet |

Avant d'aller plus loin, le dump est relu (`pg_restore --list`). Le script
vérifie aussi qu'il vient de la bonne base : la table `tenants` et le journal
des migrations doivent y figurer.

**Après la purge de 3 h 15**, pas avant : un lot ne contient pas ce qui vient
d'arriver au terme de sa conservation.

### Un rôle de lecture, pas le propriétaire

`pg_dump` se connecte avec un rôle dédié, `sauvegarde`, qui a deux droits :

- `BYPASSRLS` : sans lui, `pg_dump` refuse de lire les tables sous RLS ;
- `pg_read_all_data` : la lecture de tout, sans aucune écriture.

Le propriétaire reste absent du serveur (ADR 013). Un vol de la configuration
de sauvegarde donne la lecture de la base, pas sa modification ni sa
destruction.

### Chiffré sur le serveur, pour des clés publiques

Les trois fichiers sont chiffrés avec **age**, pour une ou plusieurs clés
publiques. Les clés privées ne sont jamais sur le serveur. Il y en a deux au
moins, chez deux détenteurs, rangées au coffre (plan de reprise). Le script
refuse de tourner s'il trouve une clé privée parmi les destinataires.

Le serveur peut donc chiffrer, jamais déchiffrer. Une intrusion sur le serveur
ne rend pas lisibles les lots déjà envoyés.

### Hors du serveur, en UE, ailleurs que chez Neon

Le lot part par **rclone** vers un stockage S3 privé en UE. Il est ensuite
relu fichier par fichier (`rclone check`). La destination est un choix de
configuration (`SAUVEGARDE_DESTINATION`), avec deux exigences :

- **pas chez Neon** : une sauvegarde chez le même fournisseur, sur le même
  compte, disparaîtrait avec lui ;
- **dans une autre région que le VPS** : l'incendie du centre de données
  OVHcloud de Strasbourg, en 2021, a emporté des serveurs et des sauvegardes
  rangées dans le même site.

Choix recommandé : OVHcloud Object Storage, facturé à l'usage et sans
abonnement, chez un prestataire déjà sous contrat (VPS, DNS).

### Rétention : 7 jours, 4 semaines, 12 mois

On garde le lot le plus récent de chacun des 7 derniers jours, des 4 dernières
semaines ISO et des 12 derniers mois qui en ont un, soit 23 lots au plus. Les
autres lots sont effacés. Les restes d'un passage interrompu (sans manifeste)
le sont aussi. La règle est une fonction du script, testée par
`infra/serveur/sauvegarde.test.sh` en CI.

### Un échec se voit

- un code de sortie non nul ;
- la cause au journal (`~/centre-affaires/sauvegardes.log`) et dans syslog ;
- un appel facultatif à un service de surveillance (`SAUVEGARDE_SIGNAL_URL`,
  suivi de `/fail`) ;
- un lot à moitié envoyé est effacé, ou l'est au passage suivant.

### Des outils de Debian, aucune dépendance npm

`bash`, `coreutils`, `age`, `rclone` et `flock` sont des paquets Debian.
`pg_dump` 18 vient de l'image `postgres:18-alpine`, car celui de Debian est
trop ancien pour Neon. Le script est déposé par chaque déploiement, comme
`compose.yml`. Sa configuration (`sauvegarde.env`, `chmod 600`) reste sur le
serveur.

### Restauration documentée et éprouvée

`docs/exploitation/restauration.md` décrit la procédure et consigne chaque
exercice. Le premier, le 01/10/2026, est fait en local : sauvegarde complète
puis restauration dans une base neuve. Les données restaurées sont identiques,
table par table, et la suite de tests passe sur la base restaurée.
`docs/exploitation/plan-de-reprise.md` fixe les objectifs, les rôles, l'ordre
des opérations et les secrets à garder hors du serveur.

### Journaux de l'application bornés

`infra/serveur/compose.yml` limite les journaux Docker à cinq fichiers de
10 Mo. Sans limite, ils croissaient jusqu'à saturer le disque, et une erreur
d'envoi de courriel peut y citer une adresse.

## Justification

**Pourquoi age.** Le chiffrement à clé publique est ce qui permet de chiffrer
sur le serveur sans lui confier de quoi déchiffrer. age le fait en une
commande, sans trousseau à gérer ; le paquet Debian suffit.

**Pourquoi un lot complet chaque nuit.** La base et le bucket d'un même lot
sont pris à quelques minutes d'intervalle. Une numérisation référencée par la
base se trouve donc dans le même lot. Au volume d'un centre (quelques
centaines de Mo de numérisations, purgées à 12 mois), copier tout chaque nuit
coûte moins qu'une sauvegarde incrémentale à tenir cohérente.

**Pourquoi joindre le `.env`.** Il porte tous les secrets de l'application. Le
joindre au lot, chiffré, fait d'une clé age la seule chose à sortir du coffre
pour tout reconstruire. Les deux secrets irremplaçables restent aussi au
coffre : sans clé age, le lot est illisible.

## Alternatives écartées

**Un plan Neon payant** pour une restauration instantanée plus longue : écarté
par l'ADR 016. Elle ne couvrirait de toute façon pas la perte du compte.

**Des branches ou des instantanés Neon comme sauvegarde** : même fournisseur,
même compte, et le plan gratuit limite le nombre de branches.

**Le propriétaire de la base sur le serveur** : contraire à l'ADR 013. Une
fuite donnerait le droit de tout détruire, pas seulement de tout lire.

**Un chiffrement symétrique** (`gpg --symmetric`, `openssl enc`, `rclone
crypt`) : la clé qui chiffre est aussi celle qui déchiffre, et elle serait sur
le serveur.

**Un miroir permanent du bucket sur le serveur** : ce serait une copie en clair
du courrier numérisé, durable, sur une machine partagée avec d'autres sites.

**Une sauvegarde tirée par une autre machine** : la meilleure isolation, car le
serveur ne pourrait plus effacer ses sauvegardes. Elle demande une machine
de plus à exploiter. C'est l'évolution naturelle si le risque d'intrusion le
justifie (voir Conséquences).

**Une sauvegarde physique** (`pg_basebackup`, WAL) : Neon ne l'ouvre pas.

## Conséquences

- **RGPD** :
  - une donnée effacée de la base survit jusqu'à 12 mois dans les sauvegardes.
    Le registre et le tableau des durées le disent (`docs/rgpd/`) ;
  - après une restauration, la purge est relancée avant la réouverture, pour
    réappliquer les durées ;
  - les fichiers sont en clair dans `/var/tmp` le temps du passage (droits
    `700`), puis effacés.
- **Le serveur peut effacer ses sauvegardes.** Il en a besoin pour appliquer la
  rétention, si bien qu'une intrusion pourrait les détruire. Deux parades
  possibles :
  - le versionnement, ou le verrouillage des objets, sur le bucket de
    destination, avec une règle de cycle de vie ;
  - une sauvegarde tirée par une autre machine.

  À décider avec le choix de la destination.
- **Coût** : le stockage de destination, facturé à l'usage. Aucun abonnement.
- **Version de PostgreSQL** : l'image de `pg_dump` suit la version majeure de
  Neon (`SAUVEGARDE_IMAGE_PG`). Un passage de Neon à PostgreSQL 19 fera
  échouer la sauvegarde, bruyamment, jusqu'au changement d'image.
- **À éprouver au premier passage en production** :
  - le rôle `sauvegarde` sur Neon (`BYPASSRLS` et `pg_read_all_data`) ;
  - la lecture du schéma `neon_auth`, géré par Neon. À défaut,
    `SAUVEGARDE_PG_DUMP_OPTIONS=--exclude-schema=neon_auth`, et les comptes
    se recréent à la restauration ;
  - la connexion en `verify-full` ;
  - la restauration dans un projet Neon.
- **Un exercice de restauration par trimestre**, consigné dans
  `restauration.md`.
- **Les objectifs de reprise** (24 h de données au plus, une journée ouvrée
  d'interruption pour une perte totale) sont proposés par le plan de reprise.
  Ils restent à valider par l'exploitant.
