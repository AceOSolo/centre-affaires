# ADR 020 — Chiffrement et conservation des documents

**Date** : 2026-10-01
**Statut** : accepté (partie données ; la mise en œuvre du chiffrement sera
ajoutée à cet ADR)

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
