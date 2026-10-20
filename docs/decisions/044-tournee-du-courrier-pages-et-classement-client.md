# ADR 044 — Tournée du courrier, pages numérisées facturées, classement côté client

**Date** : 2026-10-20
**Statut** : accepté — précise les ADR 015, 037 et 038 ; choix tranchés par le
centre le 20/10/2026 ; prix et nombre de pages comprises à fixer par le centre ;
facturation passée dans Dolibarr par l'ADR 046 (le compte des pages reste, la
ligne du lot interne est en sommeil avec lui)

## Contexte

Le centre a décrit le parcours du courrier tel qu'il le pratique :

1. l'accueil réceptionne le courrier déposé, pli par pli, côté back-office ;
2. **en fin de lot** (« fin de batch »), les domiciliés sont prévenus — qu'ils
   aient reçu du courrier ou non ;
3. le domicilié choisit de faire ouvrir et numériser un pli, ou non, contre
   une facturation supplémentaire ;
4. le pli est ouvert, numérisé et déposé par l'accueil ; **le nombre de pages
   numérisées compte**, car la facturation en dépend ;
5. le domicilié range son courrier comme dans un espace bancaire : lu,
   traité ou non, étiquettes, documents rangés par catégories.

L'existant (ADR 015, 037, 038) couvrait 1, 3 et le dépôt du 4, mais :

- chaque pli enregistré envoyait **aussitôt** un courriel (`mail_received`) :
  dix plis pour une entreprise, dix courriels, et rien pour celles qui n'ont
  rien reçu ;
- **aucun compte de pages** : l'ouverture se facturait au pli, quel que soit
  son volume ;
- **aucun classement** côté client : seuls des filtres par type, période et
  état.

Choix du centre (20/10/2026), à la question posée :

| Question | Choix |
|---|---|
| Facturation des pages | **N pages comprises dans l'ouverture, puis un prix par page** ; N réglable (0 : prix par page dès la première) |
| Qui est prévenu en fin de tournée | **Tous les domiciliés** : « courrier reçu », ou « pas de courrier aujourd'hui » |
| Qui range dans les catégories | **Le client seul** |
| Lu, traité, étiquettes | **Propres à chaque personne** |

Une autre session (ADR 043) prépare la reprise de la facturation par
Dolibarr, sans l'avoir tranchée : le lot interne doit continuer de marcher, et
le nombre de pages rester une **donnée neutre** qu'un export pourra lire.

## Décision

### 1. La tournée du courrier

Table `mail_batches` : ouverture (date de la base, auteur), fin (date de la
base, auteur). **Au plus une tournée ouverte par centre**
(`mail_batches_open_key`, sur une colonne générée nulle une fois close).

- Le premier pli enregistré ouvre la tournée ; les suivants y entrent
  (`mail_items.batch_id`, posé à l'insertion, jamais changé). Les plis
  antérieurs ont `batch_id` nul.
- **Rien ne part à l'enregistrement.** L'écran « Tournée du courrier »
  (`/courrier/tournee`) montre les plis de la tournée et, avant le geste, qui
  recevra quoi. « Terminer la tournée et prévenir les domiciliés » la clôt.
- Sans tournée ouverte, « Signaler qu'aucun courrier n'est arrivé » ouvre et
  termine une tournée vide : c'est ainsi que les domiciliés apprennent qu'il
  n'y a rien.
- Un bandeau en tête des écrans du courrier dit si une tournée est en cours.

Garanties de la base (`60-courrier.sql`, nouveau code **`CA017`**) : un pli
n'entre que dans une tournée ouverte (verrou partagé sur la tournée, que la
fin verrouille en écriture : un pli en cours d'enregistrement finit d'entrer,
ou entre dans la suivante — le code rejoue alors l'enregistrement une fois) ;
il ne change pas de tournée ; une tournée terminée ne se rouvre pas, ne se
supprime pas, ne s'écrit jamais sous portée client. L'écran passe
l'identifiant de la tournée qu'il montrait : on ne termine pas à la place d'un
collègue une tournée qu'on n'a pas vue.

### 2. Les messages de fin de tournée

Deux événements (ADR 038) :

- `mail_batch_received` — un message **par entreprise** qui a reçu au moins
  un pli dans la tournée : leur nombre, leur nature (« 2 lettres et
  1 recommandé »), ceux déjà ouverts par l'accueil ; **jamais l'expéditeur**
  (ADR 015). Catégorie de préférence `mail`.
- `mail_none` — « pas de courrier aujourd'hui », aux **domiciliés** sans pli :
  entreprises non archivées ayant un contrat `domiciliation` en cours le jour
  du centre. Envoyé à la **première tournée terminée de la journée**
  seulement : une seconde distribution l'après-midi ne le redit pas.
  Catégorie de préférence propre, **`mail_none`** : une personne peut refuser
  cet avis quotidien sans renoncer au courrier reçu.

Les messages partent après la réponse (`after()`), relus depuis la tournée
terminée ; le journal des envois (`related_type = 'mail_batch'`) dit ce qui
est parti. `mail_received` n'est plus déclenché par l'enregistrement ; il
reste au catalogue pour l'historique.

### 3. Le nombre de pages

`mail_scans.page_count` : pages du contenu numérisé ; nul pour l'enveloppe et
pour les contenus antérieurs. Au dépôt (enregistrement avec contenu,
ouverture, numérisation demandée), il est **lu dans le PDF** — catalogue de
la dernière remorque, puis arbre des pages, flux d'objets compressés
décompressés avec zlib, sans dépendance nouvelle — ou vaut 1 pour une image.
Le champ « Nombre de pages » est facultatif : la saisie de l'accueil
l'emporte (pages blanches retirées) ; elle est exigée quand le fichier ne se
lit pas. Jamais d'estimation.

L'accueil **corrige** un compte faux depuis la fiche du pli, tant qu'aucune
facture ne tient la numérisation (`CA017` ensuite). Le compte ne se pose ni ne
s'efface après le dépôt, ni depuis l'espace client. Il survit à la purge du
fichier : la facture reste justifiée.

### 4. La facturation des pages

`tenants.mail_opening_included_pages` (0 à 1000, défaut 0), réglé à l'écran
Configuration, section Facturation. Service attendu **`courrier.page`**
(« Page numérisée au-delà de l'ouverture », par unité ; prix fixé par le
centre, jamais inventé).

Le lot ajoute, après les ouvertures, **une ligne par pli ouvert** dont le
contenu d'ouverture dépasse les pages comprises : `act`, service
`courrier.page`, quantité = pages au-delà (`billablePages`), source
**`invoice_lines.mail_scan_id`** (la numérisation). Prix : forfait du client
à ce service en vigueur le jour de l'ouverture, sinon catalogue — la règle des
actes (`priceActs`) **sans ses inclus** : les pages comprises se règlent par
pli, au réglage du centre, pas par forfait mensuel. Sans service au
catalogue, rien n'est valorisé et le lot le signale.

La garde des lignes (`50-facturation.sql`, `CA003`) exige : une numérisation
de contenu d'ouverture (d'office ou sur demande d'ouverture), comptée, d'un
pli du client, ouvert et non retiré ; le service `courrier.page` ; pas plus
de pages que comptées. Au plus une ligne vivante par numérisation
(`invoice_lines_mail_scan_key`), libérée par un avoir.

Les **numérisations demandées ensuite** (`scan`, ADR 037) comptent leurs
pages mais se facturent toujours par leur demande, pas à la page.

Le client voit le prix avant de demander l'ouverture : « Comprend 5 pages
numérisées ; au-delà, 0,20 € HT la page ».

### 5. Le classement côté client

Table `mail_item_member_states` : une ligne par pli et par **personne**
(accès à l'entreprise du pli) — `read_at`, `handled_at`, `category`, `tags`
(JSON, dix au plus, 30 caractères). Sans ligne : non lu, à traiter, non
classé. **Jamais lue par le centre.**

- « Lu » se pose à l'ouverture de la fiche du pli ou de son contenu ;
  « Marquer comme non lu » ramène à la boîte aux lettres. Marquer traité
  marque lu.
- Catégories, liste fixe : impôts et taxes, URSSAF et organismes sociaux,
  banque et finances, assurances, fournisseurs et factures, clients,
  juridique, autres administrations, publicité, autre ; et « non classé ».
- La boîte aux lettres devient un espace à **rubriques** : suivi (tout, non
  lus, à traiter, traités), catégories, étiquettes, chacune avec son nombre ;
  cases à cocher et **actions groupées** (lu, non lu, traité, à traiter,
  classer, étiqueter) ; la fiche d'un pli a son panneau « Mon classement ».

Portée client tenue par des triggers (insertion, mise à jour, suppression),
clés étrangères vers le pli et la personne de la même entreprise. Les
étiquettes, texte libre, sont **vidées** à l'anonymisation de la personne ou
de l'entreprise (`90-rgpd.sql`) ; lu, traité et catégorie restent.

## Justification

**Pourquoi une table de tournées plutôt qu'un drapeau « prévenu » sur le
pli.** Il faut savoir qu'une tournée a été terminée — même vide — pour dire
« pas de courrier », et ne le dire qu'une fois par jour. Une ligne datée et
signée le permet et laisse une trace.

**Pourquoi la première tournée du jour seulement pour « pas de courrier ».**
Le centre reçoit parfois deux distributions. Redire « rien » l'après-midi à
qui a déjà été prévenu le matin serait du bruit ; qui reçoit un pli l'après-
midi est prévenu par « courrier reçu ».

**Pourquoi la source de la ligne est la numérisation, pas le pli.** Le pli
tient déjà sa ligne d'ouverture (`invoice_lines_mail_item_key`, ADR 015) ; les
pages sont celles d'un fichier précis, et c'est lui que la garde compare.
Le compte de pages reste une colonne du courrier, lisible par un export vers
un autre outil de facturation sans rien de la logique du lot.

**Pourquoi pas les inclus du forfait pour les pages.** `priceActs` compte les
actes un par un ; une ligne de pages en porte plusieurs. Le centre a choisi
« N pages comprises par ouverture » : c'est ce réglage qui fait l'inclus.

**Pourquoi un classement par personne.** Choix du centre : deux associés
n'ont pas le même suivi. Les étiquettes sont personnelles, d'où leur
effacement avec la personne.

**Pourquoi lire le PDF sans bibliothèque.** CLAUDE.md demande de ne pas
ajouter de dépendance sans justification ; compter les pages ne demande que
l'arbre des pages, et zlib est dans Node. Ce qui ne se lit pas est saisi.

## Alternatives écartées

**Un courriel par pli, groupé par le serveur de messagerie.** Le centre veut
« fin de batch » ; et rien ne disait « pas de courrier ».

**Clore automatiquement une tournée oubliée la nuit.** « Pas de courrier
aujourd'hui » envoyé à deux heures du matin le lendemain serait faux. Le
bandeau rappelle la tournée en cours ; le centre pourra demander une clôture
planifiée.

**Un compteur dans la navigation.** Il aurait fallu toucher la coque du
back-office, modifiée en même temps par d'autres travaux ; le bandeau des
écrans du courrier suffit.

**Catégories proposées par l'accueil, ou modifiables par le centre.** Écarté
par le centre : le client range seul. La liste fixe peut devenir une table
par centre plus tard sans reprise (la colonne est une énumération).

**Facturer les pages des numérisations demandées.** Elles ont leur prix
propre (`courrier.numerisation`, ADR 037) ; les facturer aussi à la page
ferait deux prix pour un même geste.

## Conséquences

- Migration de structure **0002** (`mail_batches`, `mail_items.batch_id`,
  `mail_scans.page_count`, `tenants.mail_opening_included_pages`,
  `invoice_lines.mail_scan_id`, `mail_item_member_states`, événements,
  catégorie et type lié des notifications). Règles : `50`, `60`, `70`, `90`.
- Code d'erreur **`CA017`** (`DB_MAIL_REFUSED`) : règle du courrier refusée.
- **À faire par le centre** : fixer le prix du service `courrier.page`
  (écran Services ou `infra/configurer-centre.mjs`) et le nombre de pages
  comprises (Configuration) ; relire les textes par défaut des deux nouveaux
  messages (Notifications).
- **Facturation dans Dolibarr** (ADR 046, arrivé le même jour) : le lot
  interne est arrêté, avec sa ligne de pages. La passerelle reprend les pages
  comme consommations facturables : `mail_scans.page_count`,
  `tenants.mail_opening_included_pages`, `billablePages()`. Le prix d'une page
  vit alors dans Dolibarr ; l'annonce au client lit encore le catalogue du
  site tant que la seconde tranche de l'ADR 046 n'est pas faite.
- Pas de constat à l'écran à 375 px dans cette tranche (aucun navigateur dans
  la CI) : la boîte aux lettres à rubriques est à vérifier au téléphone
  (R25).
