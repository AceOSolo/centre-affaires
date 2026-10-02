# ADR 039 — États des lieux : modèles versionnés par type, état clos figé, photos chiffrées

**Date** : 2026-10-02
**Statut** : accepté — met en œuvre la décision D8 de l'ADR 016, sauf la
compression par `sharp`, remplacée par une compression dans le navigateur ;
les choix marqués « à valider » attendent le centre

## Contexte

R06 demande des états des lieux d'entrée et de sortie, avec des champs
configurables par type de ressource, en base, des photos compressées, et un
lien vers la ressource et la réservation. R33 demande la compression et la
purge des photos stockées.

L'ADR 016 (D8) a retenu des modèles de champs en JSONB, versionnés, et une
compression avec `sharp`. La vague 3 s'interdit toute nouvelle dépendance :
la compression se fait dans le navigateur (canvas) avant l'envoi, le serveur
vérifie le type et la taille.

Les photos d'un local occupé sont des documents sensibles au même titre que
les scans de courrier : chiffrées au repos (ADR 020), consultation
journalisée.

## Décision

### Un modèle par type de ressource, en versions figées

- `inspection_templates` : un modèle vivant par type de ressource
  (`inspection_templates_type_key`), avec un nom ;
- `inspection_template_versions` : ses versions, numérotées (`version`, la
  précédente + 1, posée par le code ; l'unicité tranche entre deux
  publications simultanées). Une version publiée **ne change plus** : le
  rôle applicatif n'a ni `UPDATE` ni `DELETE`. Modifier un modèle, c'est
  publier une version.

Les champs (`fields`, JSONB) sont une liste d'objets, validée par la base
(`inspection_fields_error()`, contrainte) :

| Propriété | Règle |
|---|---|
| `id` | `^[a-z][a-z0-9_]{0,62}$`, unique dans la version : la clé de la valeur |
| `label` | libellé visible, non vide, 200 caractères au plus |
| `type` | `text`, `number`, `choice`, `checkbox` ou `condition` (note d'état) |
| `required` | booléen, exigé à la clôture |
| `unit` | nombre seulement (« kWh », « clés ») |
| `options` | choix seulement, 2 à 50 libellés distincts |
| `help` | aide sous le champ, facultative |

La note d'état suit une échelle commune, du meilleur au pire : `neuf`, `bon`,
`usage`, `mauvais` (`inspection_condition_levels()`, *à valider*).

Modèles et versions n'ont pas de client : ils se lisent depuis l'espace
client (les libellés s'y affichent), mais ne s'écrivent que depuis le
back-office (politiques restrictives d'écriture).

### Un état des lieux garde sa version

`inspections` : nature (`entry`, `exit`), ressource, client, réservation
et/ou contrat (au moins l'un, du même client — clés étrangères composites),
date (`performed_at`), valeurs (`values`, JSONB par identifiant de champ),
observations, auteur. Une sortie désigne l'entrée qu'elle clôt
(`entry_inspection_id`) : même ressource, même client (clé étrangère),
entrée close, une sortie par entrée.

`template_version_id` est la version avec laquelle il est saisi, et ne
change jamais : un modèle qui évolue ne réécrit pas un état des lieux passé.
La version est celle du **type** de la ressource.

### Brouillon, clôture, validation par le client

| Statut | Ce qui se passe |
|---|---|
| `draft` | Saisie au centre ; valeurs vérifiées contre la version (clés connues, types, options, échelle) ; un champ obligatoire peut attendre ; photos ajoutées, légendées, retirées ; le brouillon se retire (`deleted_at`). Invisible du client. |
| `closed` | Clôture par l'équipe (`closed_by`, `closed_at` posé par la base), refusée tant qu'un champ obligatoire est vide. **Figé** : ni valeurs, ni observations, ni photos, ni date. |
| validé | Le client valide depuis son espace, une fois : `signed_by_member_id` (une personne de l'entreprise), `client_remarks` (ses réserves), `signed_at` posé par la base. |

Garde `inspections_guard` (migration 0042) : `CA011` pour une saisie non
conforme, `CA010` pour un état figé. Un état des lieux ne se supprime pas.

La validation dans l'espace client tient lieu de signature. Une signature
électronique au sens du règlement eIDAS, ou la signature sur papier
numérisée, n'est pas couverte (*à valider*).

### Photos : compressées dans le navigateur, chiffrées, journalisées

`inspection_photos` : clé de stockage, **version de la clé de chiffrement
obligatoire** (pas d'objet hérité en clair : `sealDocument`, ADR 020), type
déterminé par le contenu (`image/jpeg`, `image/webp`, `image/png`), taille
en clair (10 Mio au plus), dimensions (pour réserver la place à
l'affichage), légende, champ illustré (un champ de la version), ordre,
auteur, `deleted_at`.

Le navigateur réduit et recompresse la photo (canvas, JPEG ou WebP) avant
l'envoi ; le serveur vérifie les premiers octets et la taille, chiffre,
dépose, puis écrit la ligne. Une photo se dépose sur un brouillon seulement
(`CA010` ensuite) et ne change jamais de fichier.

`inspection_photo_views` : journal des consultations, comme
`mail_scan_views` — ajout seul, lecture par le centre ou par le client
(portée), purge au terme de `inspection_access_log_retention_months`
(12 mois, *à valider*) par `purge_expired_inspection_photo_views()`.

### Conservation des photos

`tenants.inspection_photo_retention_months` : 36 mois par défaut (*à
valider* ; la preuve de l'état des locaux sert jusqu'au règlement du dépôt de
garantie et des litiges). Le délai court depuis **la clôture de la sortie** :
pour une sortie, la sienne ; pour une entrée, celle de la sortie qui la
désigne (`inspection_photo_retention_start()`). Une entrée sans sortie close
ne se purge pas : l'occupation dure, ou la sortie reste à faire.

La purge suit le modèle du courrier : le code lit
`expired_inspection_photos(limite)`, efface le fichier du stockage, puis
`mark_inspection_photo_purged(id)` marque la ligne (`deleted_at`) en
revérifiant l'échéance — seul chemin pour retirer une photo d'un état clos.

### Portée client

Sous portée client (ADR 019), une entreprise ne voit que ses états des lieux
**clos** et non retirés, leurs photos et leurs consultations. Elle ne saisit
rien : seule la validation passe.

## Justification

**Pourquoi le navigateur plutôt que `sharp`.** `sharp` embarque une
bibliothèque native : une dépendance lourde, à mettre à jour, pour un travail
que le canvas fait avant l'envoi. Le serveur n'a plus qu'à vérifier, et la
bande passante d'un téléphone sur place est épargnée.

**Pourquoi une validation en base.** Les écrans de saisie seront construits
par d'autres mains, et un état des lieux est une pièce probante : une valeur
hors du modèle, ou une clôture incomplète, ne doit pas pouvoir s'écrire.

**Pourquoi des versions plutôt qu'un modèle modifiable.** Un état des lieux
de 2026 relu en 2029 doit montrer les champs de 2026.

**Pourquoi la sortie fait partir le délai.** L'entrée est la référence de la
sortie : la purger avant serait perdre la comparaison qui fonde une retenue
sur le dépôt de garantie.

## Alternatives écartées

**Une table de champs et une table de valeurs.** Plus de jointures pour la
même garantie, que la fonction de validation donne sur du JSONB (D8).

**Un modèle par ressource.** Le cahier des charges dit « par type ».

**Garder les photos sans limite.** Contraire à R33 et au registre RGPD.

## Conséquences

- Le module `src/modules/etats-des-lieux/` porte le schéma ; la tranche
  états des lieux construit les modèles (`etats-des-lieux.modeles`,
  exploitant), la saisie, la clôture et les photos
  (`etats-des-lieux.gerer`, accueil et exploitant), la validation dans
  l'espace client, le service des photos (déchiffrement, journal) et la
  purge nocturne.
- Erreurs à traduire : `CA011` (le message dit quoi corriger), `CA010`
  (figé), `23505` (une sortie par entrée, un modèle par type, une version en
  double), `23503` (réservation ou contrat d'un autre client).
- Les événements `inspection_to_sign` et `inspection_signed` (ADR 038)
  préviennent le client puis le centre.
- *À valider par le centre* : l'échelle de note d'état, la durée des photos
  et du journal, la valeur de la validation en ligne comme signature.

## Mise en œuvre

Ajoutée le 2026-10-02 par la tranche « états des lieux » de la dernière
vague, sans changer la décision : elle dit comment les écrans et le code
l'appliquent, et les choix par défaut qu'ils ont dû faire. Code :
`src/modules/etats-des-lieux/`.

### Écrans et droits

- **`/etats-des-lieux`** (`etats-des-lieux.gerer`, accueil et exploitant) :
  tous les états des lieux, filtrables par étape — en saisie, à valider par
  le client, validés. Un brouillon retiré sort de la liste.
- **Fiches ressource, réservation et contrat** : une section « États des
  lieux » liste ceux de la fiche et ouvre une entrée ou une sortie. Une
  réservation sans client, ou annulée, et une ressource ou un contrat
  archivés disent pourquoi rien ne s'ouvre.
- **`/etats-des-lieux/nouveau`** : l'occupation se choisit parmi celles que
  le serveur propose — la réservation ; les occupations du contrat (une par
  ressource, avenants compris), ou sa ressource prévue s'il est en
  brouillon ; depuis une ressource, les réservations d'un client de
  120 jours avant à 60 jours après, et les contrats en brouillon. Le
  formulaire ne transporte qu'une clé : ressource et client sont retrouvés
  au serveur, jamais crus. Une sortie choisit l'entrée close sans sortie du
  même client et de la même ressource, ou « aucune » (entrée faite hors de
  l'application : pas de comparaison).
- **`/etats-des-lieux/[id]`** : en brouillon, le formulaire généré depuis la
  version du modèle, les photos de chaque champ et d'ensemble, la clôture,
  le retrait du brouillon ; clos, la lecture, la validation du client et,
  pour une sortie, la comparaison avec l'entrée. **Vue imprimable** :
  `/etats-des-lieux/[id]/document`, hors de la coque, que le navigateur
  imprime ou enregistre en PDF.
- **`/etats-des-lieux/modeles`** et **`/etats-des-lieux/modeles/[type]`**
  (`etats-des-lieux.modeles`, exploitant) : un modèle par type, son éditeur
  (ajout, ordre par « Monter » / « Descendre », libellé, type, obligatoire,
  unité, options, aide, retrait), l'historique des versions, chacune
  consultable.
- **Espace client** : rubrique « États des lieux »
  (`/compte/etats-des-lieux`), sous la portée client (`inClientSpace`) en
  plus des filtres : les états clos des entreprises du compte, leur relevé,
  leurs photos, la comparaison d'une sortie, et la validation — la personne
  connectée, au titre de l'entreprise de l'état des lieux, avec ses
  réserves ; la base pose la date. Cartes et boutons pleine largeur, 44 px.

### Modèles

- **Modèles de départ** (`modeles-defaut.ts`, *à valider*) : véhicule —
  kilométrage (km), niveau de carburant (vide, 1/4, 1/2, 3/4, plein),
  propreté intérieure et extérieure, carrosserie, dommages, clés, papiers à
  bord ; bureau, salle, casier, boîte aux lettres — état général,
  équipements (ou serrure), clés et badges remis, propreté ou case propre au
  type. Les observations ne sont pas un champ : chaque état des lieux a les
  siennes.
- **Publication** : une version n'est créée que si les champs changent ; un
  nom seul se renomme sans version. Un type sans modèle reçoit son modèle de
  départ, publié tel quel en version 1 **à la première saisie** (auteur : la
  personne qui saisit), pour que l'accueil ne soit jamais bloqué.
- **Identifiants de champ** : tirés du libellé à l'ajout (sans accents, `_`,
  suffixe en cas de doublon), puis **jamais modifiés** par l'éditeur. C'est
  par eux que la comparaison rapproche une sortie de son entrée saisies avec
  deux versions différentes.
- **Validation** : `champs.ts` est le miroir des fonctions SQL
  (`inspection_fields_error`, `inspection_values_error`), mot pour mot ; il
  relève toutes les erreurs, chacune à côté de son champ et dans le résumé.
  `etats-des-lieux-ecrans.db.test.ts` éprouve l'accord du code et de la base.

### Saisie et clôture

- Note d'état, oui / non et choix de six options au plus : boutons radio
  (plus : liste déroulante). **Oui / non non coché vaut « non renseigné »**,
  pas « non » : un état des lieux dit ce qui a été constaté. Nombre saisi à
  la française (« 12 345,5 »).
- **Clôture** : une case de confirmation, puis « Enregistrer et clore », dans
  le même envoi que la saisie. Une clôture refusée (champ obligatoire vide,
  date à venir, case non cochée) **enregistre quand même le brouillon** et
  liste ce qui manque. La date d'un état des lieux se saisit dans le fuseau
  du centre, en UTC en base.
- Retirer un brouillon retire d'abord ses photos — la base les fige dès que
  l'état des lieux est retiré —, puis efface leurs fichiers.

### Photos

- **Navigateur** (`compression.ts`) : décodage avec l'orientation EXIF, plus
  grand côté ramené à **1 920 px**, réencodage **JPEG qualité 0,8** sur fond
  blanc ; les métadonnées (dont la position GPS) ne partent pas. Une photo
  par requête : une connexion qui flanche ne perd que la photo en cours. Un
  format que le navigateur ne décode pas (HEIC sur ordinateur) est refusé
  avec un message.
- **Serveur** (`photos.ts`) : type et dimensions lus dans les octets (JPEG,
  PNG, WebP), 10 Mio et 10 000 px au plus, puis `sealDocument`, dépôt sous
  une clé sans rien de lisible (`etats-des-lieux/<centre>/<uuid>.jpg`),
  inscription ; un fichier sans ligne est effacé aussitôt.
- **Lecture** (`servir.ts`) : routes `/etats-des-lieux/photos/[id]`
  (équipe) et `/compte/etats-des-lieux/photos/[id]` (client), déchiffrement
  authentifié, journal écrit avant l'envoi, aucune mise en cache. Chaque
  vignette affichée est une consultation journalisée.
- Retirer une photo d'un brouillon efface son fichier : elle ne prouve plus
  rien. Les photos purgées d'un état clos sont comptées et signalées à
  l'écran.

### Conservation et clés

- `/api/maintenance/conservation` purge, chacun dans sa transaction, le
  journal des consultations (`purge_expired_inspection_photo_views`), puis
  les photos échues (`expired_inspection_photos` → effacement du fichier →
  `mark_inspection_photo_purged`). La réponse donne
  `inspectionPhotoViews` et `inspectionPhotos`.
- **Rotation de clé** : une photo ne se rechiffre pas — la garde
  `inspection_photos_guard` fige sa version de clé, et rien ne la laisse
  changer. `infra/chiffrer-documents.ts` compte donc les photos encore
  chiffrées avec une clé précédente, pour qu'on garde
  `DOCUMENTS_ENCRYPTION_KEY_<N>` jusqu'à leur purge. Manque de schéma
  relevé pour l'intégration.

### Comparaison (`comparaison.ts`)

Ordre du modèle de la sortie, puis les champs que seule l'entrée
connaissait. Chaque ligne dit son écart en toutes lettres : « Identique »,
« Dégradé : Bon état → État d'usage », « Amélioré : … », « Écart : +480 km »,
« Changé : Plein → 1/2 », « Renseigné à la sortie seulement », « Champ
absent du modèle de l'entrée ». Les lignes en écart portent en plus une
marque « Écart » ou « Dégradation », et un résumé compte les écarts.

### Restes

- **Notifications** : `inspection_to_sign` (à la clôture) et
  `inspection_signed` (à la validation) ne sont pas envoyés par cette
  tranche : le moteur de l'ADR 038 se construit en parallèle. Points
  d'appel : la branche « clore » de `saveInspectionAction` (`actions.ts`) et
  `signInspectionAction` (`compte-actions.ts`), après la réponse (`after`).
- *À valider par le centre*, en plus de ce qui précède : les modèles de
  départ, la taille et la qualité de compression, la fenêtre des
  occupations proposées depuis une ressource.
