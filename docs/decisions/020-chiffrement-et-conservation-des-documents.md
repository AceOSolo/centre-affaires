# ADR 020 — Chiffrement et conservation des documents

**Date** : 2026-10-01
**Statut** : accepté (modèle de données le 2026-10-01 ; mise en œuvre du
chiffrement, du contrôle de région et de la purge ajoutée ci-dessous)

## Contexte

Les numérisations de courrier (enveloppes et contenus) sont déposées en clair
dans le stockage objet (ADR 015). Cela pose deux problèmes :

- Le cahier des charges demande leur chiffrement au repos (R22).
- Toute branche Neon créée depuis `production` copie le stockage, donc ces
  documents lisibles. `CLAUDE.md` l'interdit : pas de données réelles en
  développement (bloquant B3).

`src/lib/chiffrement.ts` chiffre déjà en AES-256-GCM les secrets confiés par un
tiers, avec une version en tête du chiffré. Il reste à l'étendre au binaire et à
savoir, objet par objet, s'il est chiffré.

Par ailleurs, les coordonnées des demandeurs de la page publique (nom, adresse
électronique, téléphone, ADR 005) sont conservées sans limite. L'ADR 005 en
appelait une durée de conservation et une purge, que le bloquant B4 réclame
encore. Les durées du courrier, elles, sont posées depuis les migrations 0023 et
0024.

Cet ADR fixe le modèle de données. La mise en œuvre du chiffrement (format des
objets, gestion des clés, reprise des objets existants) y sera ajoutée par la
tranche sécurité.

## Décision

### Savoir, objet par objet, s'il est chiffré et avec quelle clé

`mail_scans.encryption_key_version` (`smallint`, contrainte
`mail_scans_encryption_key_version_positive`) :

- **nul** : l'objet a été déposé en clair, avant le chiffrement. Il reste
  lisible tel quel le temps de la reprise ;
- **N > 0** : l'objet a été chiffré avec la clé de version N. C'est cette
  version qui choisit la clé au déchiffrement.

La colonne couvre la photo d'enveloppe comme le contenu numérisé : tous deux
sont des lignes de `mail_scans` (`side`).

`content_type` et `byte_size` décrivent toujours le document **en clair**,
celui que l'application rend à la lecture, pas le chiffré du stockage.

Le format du chiffré (en-tête, vecteur d'initialisation, étiquette
d'authentification) est porté par l'objet lui-même, comme pour `sealSecret`. La
base ne dit que deux choses : s'il faut déchiffrer, et avec quelle clé.

L'index partiel `mail_scans_unencrypted_idx` (`tenant_id, created_at`, objets en
clair non purgés) sert de file d'attente à la reprise. Il se vide à mesure que
les objets sont chiffrés. Une fois vide, une migration pourra exiger la colonne
pour les nouveaux objets. La tranche sécurité en décidera dans cet ADR.

### Conserver les demandes publiques douze mois, puis effacer le demandeur

`tenants.public_request_retention_months` : douze mois par défaut, entre 1 et
120 (contrainte `tenants_public_request_retention_valid`). La durée est réglée
par centre, comme celle du courrier. Elle est inscrite dans
`infra/configurer-centre.mjs` et reste à faire valider par le centre.

Elle court à partir de la fin du créneau demandé. Si la demande a été annulée ou
refusée avant, elle court à partir de l'annulation.

La fonction `anonymize_expired_public_requests()`, en `SECURITY DEFINER`, traite
le centre courant et rend le nombre de demandes traitées. Pour chaque demande
échue, elle :

- efface `requester_name`, `requester_email` et `requester_phone` ;
- pose `requester_anonymized_at`.

Si la demande n'a jamais été rattachée à un client, elle efface aussi les notes
et remplace l'objet par « Demande publique anonymisée ». Ce sont des champs que
le visiteur a saisis librement et qui peuvent le nommer.

Une demande rattachée à un client relève de l'historique de ce client : seules
les coordonnées du demandeur partent.

La réservation, elle, reste : son créneau, son statut et son canal (`public` ou
`client`, ADR 018). On anonymise, on ne supprime pas (décision 6).

C'est le modèle de `purge_expired_mail_scan_views()` (migration 0024) :
l'application déclenche, la fonction seule choisit quoi effacer. L'appel est à
ajouter à la tâche nocturne `/api/maintenance/conservation`, à côté de la purge
du courrier.

## Mise en œuvre

Ajoutée par la tranche sécurité de la vague 1 (R22, R33, fin de B4). Aucune
dépendance : tout vient de `node:crypto`.

### Format d'un objet chiffré

`src/lib/chiffrement-documents.ts`, en AES-256-GCM :

| Octets | Contenu |
| --- | --- |
| 4 | `CAD1` : marque du format, version 1 |
| 2 | version de la clé, entier non signé gros-boutiste |
| 12 | vecteur d'initialisation, tiré au hasard pour chaque objet |
| n | document chiffré |
| 16 | étiquette d'authentification |

Les données associées (authentifiées, non chiffrées) sont l'en-tête et la clé
de l'objet dans le stockage (`storage_key`). Conséquences :

- un chiffré recopié sous la clé d'un autre document est refusé : qui peut
  écrire dans le stockage ne peut pas faire lire à un client le courrier d'un
  autre ;
- modifier la version inscrite dans l'en-tête fait échouer l'authentification.

Aucun PDF, JPEG ou PNG ne commence par `CAD1`. C'est ce qui permet de
reconnaître un objet chiffré à son contenu, et non seulement à la base.

L'objet est déposé en `application/octet-stream`. `content_type` et
`byte_size` décrivent le document en clair (voir plus haut).

**Pourquoi pas `sealSecret`.** Il encode en base64, ce qui ajoute un tiers au
poids de chaque scan, et sa clé est celle des jetons de tiers. Deux clés
séparées ont deux avantages : la fuite de l'une n'ouvre pas l'autre, et chacune
tourne à son rythme.

### Clés

Trois variables, distinctes de `SECRETS_ENCRYPTION_KEY` :

- `DOCUMENTS_ENCRYPTION_KEY` : 32 octets en base64, la clé courante. Elle
  chiffre tout nouveau dépôt.
- `DOCUMENTS_ENCRYPTION_KEY_VERSION` : son numéro, inscrit sur l'objet et dans
  `encryption_key_version`.
- `DOCUMENTS_ENCRYPTION_KEY_<N>` : les clés précédentes, présentes le temps
  d'une rotation.

Le trousseau est relu à chaque usage. Deux clés différentes sous un même numéro
le rendent invalide : c'est l'oubli typique d'une rotation.

Comportement selon la configuration :

- **sans clé, aucun dépôt** : jamais de repli en clair ; l'accueil voit un
  message qui le dit ;
- **objet hérité en clair** (version nulle) : il se relit sans clé.

Chaque environnement a sa propre clé. Une branche créée depuis la production
copie donc des objets qu'elle ne peut pas lire : c'est ce qui lève B3, une fois
la reprise faite.

La clé de production est sauvegardée hors du serveur et jamais à côté des
sauvegardes du stockage (`infra/serveur/README.md`, « Chiffrement des
documents »). La perdre, c'est perdre les documents.

### Écriture et lecture

**Au dépôt.** `store()` (`courrier/queries.ts`) chiffre chaque fichier avant
`putObject` et inscrit la version sur la ligne. Le chiffrement a lieu avant le
premier envoi : sans clé, rien ne part.

**À la lecture.** `serveScan()` (`courrier/servir.ts`) suit cet ordre :

1. lire l'objet entier (`readObjectBytes`) ;
2. le déchiffrer ;
3. inscrire la consultation au journal ;
4. envoyer le document.

Il n'y a plus de flux, car GCM n'authentifie qu'à la dernière étiquette :
servir au fil de l'eau rendrait des octets avant d'avoir vérifié leur
intégrité. Un scan pèse au plus 10 Mo.

Un document qui échoue à la vérification n'est ni envoyé ni journalisé.
L'application rend une erreur 500 en texte, qui dit que le document est
refusé, et écrit l'identifiant et la cause dans les journaux du serveur. Cela
couvre quatre cas :

- un document altéré ;
- un document chiffré avec une autre clé ;
- une version de clé absente de l'environnement ;
- un objet en clair là où la base attend un chiffré. L'accepter permettrait de
  substituer un document en écrivant dans le stockage.

Un cas reste lisible : une ligne de version nulle dont l'objet porte
l'en-tête. C'est une reprise interrompue entre l'écriture du chiffré et celle
de la base. L'objet est déchiffré, et authentifié, avec la version de son
en-tête.

### Reprise des objets existants et rotation

Le script `infra/chiffrer-documents.ts` s'appuie sur
`courrier/reprise-chiffrement.ts`. Il fonctionne en essai à blanc par défaut,
et applique avec `--appliquer`. Il sélectionne les numérisations actives non
chiffrées avec la clé courante : les objets en clair, et ceux d'une clé
précédente après une rotation. Pour chacune :

1. Il verrouille la ligne (`for update skip locked`, une transaction par
   objet).
2. Il lit l'objet et le déchiffre s'il y a lieu.
3. Il vérifie que la taille correspond à `byte_size`.
4. Il rechiffre l'objet avec la clé courante et le réécrit **à la même clé de
   stockage**.
5. Il enregistre la version.

Réécrire à la même clé de stockage évite qu'une copie en clair survive à côté
de la version chiffrée, et la ligne garde sa `storage_key`. Le script se rejoue
sans risque. Un objet déjà chiffré avec la clé courante, laissé par une reprise
interrompue, est authentifié puis enregistré sans être réécrit.

Certains objets ne sont pas touchés, mais signalés pour qu'une personne les
examine :

- un objet absent du stockage ;
- un objet de taille inattendue ;
- un objet qui échoue à l'authentification.

Le script tourne sur le serveur, dans un conteneur Node jetable qui lit le
`.env` de production : la clé ne quitte pas le serveur. Il se connecte avec
`app_centre`, sous la RLS, pour un centre à la fois (`--centre`, par défaut le
centre unique).

### Exiger la version pour les nouveaux objets

Une migration ultérieure, hors de la vague 1 dont le schéma est figé, ajoutera
la contrainte suivante, une fois que la reprise en production ne trouve plus
rien :

```sql
check (encryption_key_version is not null or deleted_at is not null)
```

Les lignes purgées gardent une version nulle : leur objet n'existe plus. À ce
moment, la lecture d'un objet en clair pourra être retirée de
`openDocument()`.

### Région du stockage (R33)

`src/lib/stockage.ts` refuse de créer son client si `AWS_REGION` n'est pas une
région de l'Union européenne. L'erreur nomme la région reçue et la liste des
régions acceptées. Le contrôle a lieu avant toute connexion : une région hors
de l'Union ne reçoit jamais un octet.

La liste est fermée, au nommage AWS, celui de Neon (`eu-central-1`, Francfort,
pour ce projet). Un préfixe `eu-` laisserait passer Londres (`eu-west-2`) et
Zurich (`eu-central-2`), qui sont hors de l'Union. Changer de fournisseur S3
demande d'ajouter ses régions à la liste, avec leur test.

### Purge des demandes publiques (fin de B4)

`/api/maintenance/conservation` appelle
`anonymize_expired_public_requests()` (`reservations/conservation.ts`) dans sa
propre transaction, avant la purge du courrier. Une panne du stockage
n'empêche donc pas l'effacement des coordonnées. La réponse ajoute
`publicRequests`, le nombre de demandes anonymisées.

La durée se règle avec celles du courrier, dans `infra/configurer-centre.mjs`.
La fiche d'une réservation anonymisée indique la date d'effacement des
coordonnées.

### Tests

- `src/lib/chiffrement-documents.test.ts` : aller-retour, altération (contenu,
  étiquette, vecteur, troncature, déplacement), objet hérité en clair,
  mauvaise version de clé, lecture du trousseau.
- `src/lib/stockage.test.ts` : régions acceptées et refusées, refus avant toute
  connexion.
- `src/modules/courrier/chiffrement.db.test.ts` : reprise (essai à blanc,
  idempotence, interruption, rotation, objets absents ou altérés) et lecture
  (déchiffrement, journal non écrit en cas de refus).
- `src/app/api/maintenance/conservation/conservation.db.test.ts` : la route
  anonymise les demandes échues, suit la durée du centre et reste introuvable
  sans jeton.

## Justification

**Pourquoi une version de clé plutôt qu'un simple drapeau.** Un booléen
supposerait une clé unique pour toujours. Avec une version par objet, une clé
compromise ou arrivée à échéance se remplace sans rendre illisibles les objets
déjà chiffrés : ils sont rechiffrés à leur rythme, et les deux clés coexistent
pendant la transition.

**Pourquoi le chiffré porte son format.** Un objet copié sans sa ligne (une
sauvegarde du stockage, une branche) ne doit pas devenir lisible ailleurs. Un
objet dont les paramètres de chiffrement seraient éparpillés en base deviendrait
illisible au premier décalage entre les deux. Le format autoportant de
`sealSecret` a fait ses preuves dans le projet.

**Pourquoi anonymiser plutôt que supprimer.** Ce sont les coordonnées qui sont
une donnée personnelle, pas l'occupation d'une salle un mardi matin. Supprimer
la ligne effacerait aussi l'historique du planning et les statistiques
d'occupation (R31), contre la décision 6.

## Conséquences

- Pour une demande anonymisée, la fiche et la file des demandes affichent
  « coordonnées effacées le … » (`requester_anonymized_at`) au lieu de champs
  vides inexpliqués.
- Le registre des traitements (D9, R29) reprend ces durées :
  - numérisations : douze mois ;
  - journal d'accès : douze mois ;
  - demandes publiques : douze mois.

  Les contacts des clients (`client_contacts`, R07) sont des données de tiers.
  Leur durée suit celle de la fiche client, à fixer au registre.
- Tant que la reprise n'a pas vidé `mail_scans_unencrypted_idx`, une branche
  créée depuis la production contient encore des documents lisibles (B3). La
  reprise est donc un préalable à toute nouvelle branche de développement
  depuis `production`.

## Alternatives écartées

**Un booléen `encrypted` et une clé unique.** Il n'y aurait aucune rotation
possible sans tout rechiffrer d'un coup, ni aucun moyen de distinguer deux
générations de clés.

**Le chiffrement côté serveur du fournisseur de stockage (SSE).** Le
fournisseur tient la clé, et une branche Neon copie des objets que quiconque
détient les identifiants de la branche lit en clair. B3 n'est pas résolu.

**Supprimer les demandes échues.** C'est contraire à la décision 6, et cela
fait perdre l'historique du planning.

**Une durée unique codée en dur.** Elle doit figurer au contrat et peut
différer d'un centre à l'autre : elle est réglée par centre, comme celle du
courrier (migration 0023).
