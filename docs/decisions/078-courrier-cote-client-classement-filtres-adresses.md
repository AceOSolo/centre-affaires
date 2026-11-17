# ADR 078 — Courrier côté client : classer depuis la liste, filtres, catégories réglables, « Ignorer », carnet d'adresses

**Date** : 2026-11-17
**Statut** : accepté — lot 5 de la recette du 17/11/2026
(`docs/recette/2026-11-17.md`) ; complète les ADR 044 (classement côté
client), 060 (catégories personnelles) et 037 (réexpédition) ; revient sur
deux alternatives écartées (catégories réglables par le centre, ADR 044 ;
adresse de réexpédition gardée, ADR 037) ; une migration de structure ;
règles `src/db/regles/62-courrier-client.sql`, code **`CA024`**. Les choix
marqués *à confirmer en recette* ont été tranchés par défaut, le responsable
produit étant absent au lancement.

## Contexte

Notes de recette du 17/11/2026 sur `/compte/courrier` :

1. « Catégoriser un courrier directement depuis la liste » ;
2. « Filtrer les courriers comme on veut (dates, non lus) » ;
3. « Modifier les catégories de courrier, celles par défaut comme celles
   créées » ;
4. « “Traiter comme lu” aussi visible que l'autre bouton, pouvoir “ignorer”
   un courrier, pas de gros boutons “Demander l'envoi” en permanence » ;
5. « Gérer ses adresses (domiciliation, réexpédition) ».

Et une règle commune à tous les lots : tout ce qui se règle se règle dans
l'admin, par centre, la valeur du code restant la valeur par défaut.

Jusqu'ici : la catégorie d'un pli se choisissait sur sa fiche ou en cochant
des plis puis « Classer » ; les filtres étaient le type, la période et
l'état, le reste passant par les rubriques de gauche ; les dix catégories de
départ ne se modifiaient pas (ADR 044) ; chaque carte portait en gros boutons
« Lire le courrier », « Demander l'ouverture » et « Demander l'envoi », et
aucun « Marquer comme lu » ; l'adresse de réexpédition se resaisissait ou se
reprenait des cinq dernières demandes (ADR 037).

## Décision

### 1. Classer depuis la liste

Chaque carte a sa liste « Catégorie » et son bouton « Classer », sans ouvrir
la fiche : les catégories proposées (sous les noms et dans l'ordre de la
personne, § 3), puis « Mes catégories ». La carte reste à sa place et dit ce
qui a été fait (« Rangé dans « Banque » », zone `aria-live`). Plusieurs plis
d'un coup : la barre de sélection, qui existait (cases à cocher, « Classer »).

Liste et bouton plutôt qu'une liste qui enregistre au changement : un choix
au clavier dans une liste déroulante ne doit pas déclencher d'action (WCAG
3.2.2), et le formulaire marche sans script.

### 2. Filtres combinables, gardés dans l'adresse

Un seul formulaire, en `GET` : **période** (du … au …, jours du centre),
**suivi** (tous sauf ignorés, non lus, à traiter, traités, ignorés),
**catégorie** (proposées, les miennes, non classé), **type de pli**, **état**
(non ouvert, numérisé, demande en cours, réexpédié) et **expéditeur**
(nouveau : le pli dont l'expéditeur contient le texte saisi, sans égard à la
casse, jokers de `LIKE` neutralisés, 100 caractères au plus ; suggestions :
les expéditeurs déjà reçus, du plus récent au plus ancien). Tous se combinent
et restent dans l'adresse (`?du=&au=&suivi=&categorie=&type=&etat=&expediteur=`,
`clientMailQuery`), la page se partage et se recharge. Les rubriques de gauche
restent : ce sont des raccourcis, qui gardent les autres filtres.

### 3. Catégories réglables : par le centre, puis par chaque personne

**Le centre** (Réglages > « Catégories du courrier », `/courrier/categories`,
droit `centre.configurer`) renomme, masque et ordonne les dix catégories
proposées. Il **n'en ajoute pas** : la catégorie d'un pli est une énumération
(ADR 044) ; les clients créent les leurs (ADR 060). Table
`mail_category_defaults` (une ligne au plus par catégorie et par centre ;
sans ligne, le nom et le rang du code).

**La personne** (`/compte/courrier/categories`) a **une seule liste** : les
catégories proposées et les siennes, qu'elle renomme, masque et ordonne pour
elle seule — même portée que le classement (ADR 044 : l'accès d'une personne
à une entreprise). Son associé garde sa liste ; le centre garde la sienne.

- Réglage d'une catégorie proposée : `mail_member_category_prefs` (nom,
  masquée, rang), **chaque valeur nulle suivant le centre**. On n'enregistre
  que ce qui diffère du centre, et un rang seulement si l'ordre diffère de
  l'ordre de départ (`personCategoriesSave`) : un changement fait ensuite
  par le centre parvient à qui n'y a pas touché.
- Catégorie personnelle : `mail_member_categories.position` et `.hidden`.
  Sans rang, après les proposées, par ordre alphabétique : une catégorie créée
  après un rangement arrive en fin de liste.
- Un seul formulaire, sans script : chaque ligne envoie son nom, sa case
  « Masquer » et sa place ; « Monter » et « Descendre » enregistrent la liste
  en déplaçant la ligne, le focus revient au bouton pressé à sa nouvelle
  place et le rang est annoncé ; « Rétablir « Impôts et taxes » » remet le
  nom du centre. La liste envoyée doit être celle de la base : une catégorie
  créée dans un autre onglet fait recharger la page.
- Noms : non vides, 40 caractères, distincts à la casse près dans la liste,
  jamais « Non classé ». Créer une catégorie compare aux noms des proposées
  **tels que la personne les voit**.
- **Masquer** une catégorie la retire des listes de classement et des
  rubriques tant qu'elle est vide ; un pli déjà rangé y reste, la rubrique
  reparaît avec lui et sa fiche garde son choix.

Le renommage d'une catégorie personnelle passe dans cette liste : l'ancien
formulaire « Renommer » ligne par ligne est retiré.

### 4. Les boutons d'une carte

- **« Marquer comme lu » / « Marquer comme non lu »**, **« Lire le
  courrier »** et **« Ignorer »** ont le même style (bouton secondaire, 44 px),
  sur une même ligne : aucun ne prend le pas sur l'autre. Lu et non lu se
  basculent en place.
- **« Ignorer »** (nouveau, `mail_item_member_states.ignored_at`, par
  personne comme le classement) : le pli **quitte toutes les vues et tous les
  compteurs** (boîte, non lus, à traiter, catégories, étiquettes), sans action
  demandée au centre ; il se retrouve dans la rubrique « Ignorés », combinable
  avec les autres filtres ; « Ne plus ignorer » l'y rend tel qu'il était.
  Ignorer ne touche ni la lecture, ni le suivi, ni le rangement. La page
  revient avec une confirmation qui dit où le retrouver (le focus s'y porte, la
  carte n'étant plus là). En groupe : la barre de sélection. Sur la fiche :
  un bandeau dit que le pli est ignoré.
- **Les demandes au centre** (ouverture et numérisation, nouvelle
  numérisation, envoi) passent dans un **menu replié par pli**, « Demander au
  centre » (`<details>`, natif, au clavier) : l'ouverture s'y demande, avec
  son prix (ADR 037, 044) ; la numérisation et l'envoi mènent à la fiche, qui
  ouvre le formulaire voulu (`?demande=numerisation#numerisation`,
  `?demande=envoi#reexpedition`).

### 5. Mes adresses

Nouvelle page `/compte/courrier/adresses`, liée depuis la boîte aux lettres :

- **Adresse de domiciliation**, pour chaque entreprise ayant un contrat de
  domiciliation en cours : sa raison sociale à l'adresse du centre
  (Configuration, `tenants`), le pays seulement hors de France, et sa boîte
  aux lettres si le contrat en a une. En lecture : c'est l'adresse du centre.
- **Carnet d'adresses de réexpédition** de l'entreprise
  (`mail_forward_addresses`) : partagé par ses personnes, vingt adresses au
  plus, un nom court facultatif (« Siège »), **une par défaut** au plus
  (index unique sur une colonne générée, comme `mail_requests_pending_key`).
  La première ajoutée l'est d'office ; « Utiliser par défaut » la change ;
  celle par défaut retirée, la première restante prend le relais. Même
  validation que la demande de réexpédition (`readForwardAddress`) ; un
  doublon (à la casse et aux espaces près) est refusé.
- **À la demande d'envoi**, le formulaire propose le carnet, l'adresse par
  défaut cochée, puis les adresses déjà utilisées qui n'y sont pas, puis
  « Une autre adresse », avec la case « Ajouter cette adresse à mon carnet
  d'adresses » (décochée). L'adresse choisie est relue en base et **recopiée
  dans la demande, qui la fige** (ADR 037) : modifier ou retirer une adresse
  du carnet ne change aucune demande déposée. Côté équipe, rien ne change :
  la demande porte toujours son adresse (aucun ajout au lot 6).

### 6. « Plis à traiter », pour la pastille du lot 4

`countMailToHandle(accounts)` (`courrier/classement.ts`) rend
`{ unread, toHandle }` de la personne connectée : plis non lus, et plis non
marqués traités, **ni retirés ni ignorés**, en une requête. C'est la fonction
à brancher sur la pastille « Courrier » et l'accueil de l'espace (lot 4).
`mailFolderCounts().unread`, que l'accueil lit déjà, exclut aussi les plis
ignorés : les deux disent le même nombre.

### 7. Ce que la base tient (`62-courrier-client.sql`, `CA024`)

- portée client (42501) sur les réglages de la personne et le carnet ; le
  réglage du centre ne s'écrit jamais sous portée client ;
- un réglage de catégorie reste celui de sa personne et de sa catégorie ;
  une adresse du carnet reste celle de son entreprise (`CA024`) ;
- **RGPD** : le carnet s'efface avec l'entreprise anonymisée ; les noms donnés
  aux catégories proposées — du texte libre — s'effacent avec la personne ou
  l'entreprise anonymisée (le masquage et le rang restent, comme le
  classement). Par deux triggers `AFTER UPDATE` sur `clients` et
  `client_members`, qui suivent `anonymized_at` : `90-rgpd.sql` n'est pas
  retouché.

### 8. Astérisques

Les champs obligatoires des écrans du lot (carnet, réexpédition, nouvelle
catégorie, listes de catégories) portent l'astérisque, `required` et
`aria-required`, et la phrase « Les champs marqués * sont obligatoires ». Le
composant commun du lot 1 étant mené en parallèle, le lot pose les siens
(`courrier/champs-obligatoires.tsx`), à remplacer par le composant commun à
la fusion.

## Choix par défaut, à confirmer en recette

| Point | Choix |
|---|---|
| « Gestion des adresses de domiciliation » | La consultation de l'adresse de domiciliation au centre, et un carnet d'adresses de réexpédition ; pas d'autre adresse du client (siège ailleurs, adresse de facturation : Dolibarr) |
| Carnet par entreprise ou par personne | Par entreprise, partagé par ses personnes : c'est son courrier qu'on réexpédie |
| Ajouter au carnet une adresse saisie à l'envoi | Case décochée par défaut (protection des données dès la conception) |
| Adresse par défaut retirée | La première restante le devient |
| « Ignorer » | Par personne ; hors de toutes les vues et compteurs, sauf « Ignorés » ; ne marque ni lu ni traité |
| « Traiter comme lu » | Compris comme « Marquer comme lu » ; « Marquer traité » reste dans la barre de sélection et sur la fiche |
| Catégories réglables par le centre | Renommer, masquer, ordonner les dix catégories proposées ; pas d'ajout (énumération) ; droit `centre.configurer` |
| Masquer une catégorie | Plus proposée au classement, rubrique cachée tant qu'elle est vide ; les plis rangés y restent |
| Filtre « non lus » | Une valeur du filtre « Suivi », avec à traiter, traités, ignorés |
| Filtre expéditeur | « Contient », sans égard à la casse ; suggestions des expéditeurs reçus |
| Menu des demandes | Replié par pli ; l'ouverture se demande dans le menu, avec son prix ; numérisation et envoi sur la fiche |
| Compte à plusieurs entreprises | Les noms et l'ordre des catégories proposées de la première entreprise dans les rubriques et filtres ; ceux de l'entreprise du pli sur sa carte et sa fiche |

## Contradictions relevées

- **ADR 044, alternatives écartées** : « Catégories proposées par l'accueil,
  ou modifiables par le centre. Écarté par le centre : le client range
  seul. » La règle commune de la recette du 17/11 (« tout ce qui se règle se
  règle dans l'admin ») l'emporte, a minima : le centre règle les noms,
  l'ordre et le masquage des catégories qu'il propose ; il ne range toujours
  rien et ne voit jamais le classement de ses clients.
- **ADR 037** : « il n'y a pas d'adresse de réexpédition sur la fiche
  client » (une donnée personnelle de plus à tenir et à anonymiser). Le carnet
  la garde, mais **côté client seulement** : l'équipe ne le voit pas, la
  demande continue de figer son adresse, et le carnet s'efface avec
  l'entreprise anonymisée (§ 7).
- **`CLAUDE.md`, décision 6** (pas de suppression physique) : une adresse
  retirée du carnet et un réglage de catégorie revenu à celui du centre sont
  effacés, comme une catégorie personnelle (ADR 060) : ce sont des réglages,
  sans valeur de preuve — la demande d'envoi garde son adresse figée.

## Justification

**Pourquoi des réglages en surcouche plutôt qu'une copie des catégories par
personne.** Le classement vise une catégorie de départ par sa clé (ADR 044) :
copier les dix catégories pour chaque personne aurait demandé de migrer tout
le classement existant vers des identifiants, pour un gain nul. Une ligne de
réglage, nulle par défaut, ne change rien tant que personne n'y touche — la
règle commune de la recette.

**Pourquoi « Ignorer » à part de « Traité ».** « Traité » dit qu'on a fait ce
qu'il fallait ; « Ignoré », qu'il n'y avait rien à faire. Le confondre
mélangerait les deux rubriques, et rendre un pli à la liste devrait deviner
s'il était traité avant.

**Pourquoi un carnet par entreprise.** Le courrier réexpédié est celui de
l'entreprise ; deux associés envoient au même siège. Les catégories, elles,
restent par personne (ADR 060), comme le suivi qu'elles servent.

**Pourquoi des triggers sur `clients` et `client_members` pour le RGPD.**
Toutes les anonymisations (fiche, accès retiré, tâche de nuit) posent
`anonymized_at` ; suivre ce passage garde le nouveau fichier de règles
indépendant de `90-rgpd.sql`, que d'autres lots de la recette peuvent toucher.

## Alternatives écartées

- **Enregistrer la catégorie au changement de la liste** : déclenche une
  action à la sélection (WCAG 3.2.2), et ne marche pas sans script.
- **Un menu d'actions en `role="menu"`** : demande la gestion des flèches au
  clavier ; le `<details>` natif suffit pour trois liens et un bouton.
- **Permettre au centre d'ajouter des catégories** : la colonne est une
  énumération ; ajouter des valeurs demanderait une migration à chaque fois,
  ou une table qui remplacerait l'énumération et le classement existant.
- **Glisser-déposer pour ordonner** : inaccessible au clavier sans un second
  mécanisme ; « Monter » et « Descendre » suffisent pour une vingtaine de
  lignes.
- **Carnet d'adresses montré à l'équipe** : sans usage, la demande porte
  l'adresse ; une donnée personnelle de plus côté back-office (ADR 037).

## Conséquences

- Migration de structure (sortie en `0017_courrier_client`, à renuméroter à
  la fusion) : tables `mail_category_defaults`, `mail_member_category_prefs`,
  `mail_forward_addresses` ; colonnes `mail_item_member_states.ignored_at`,
  `mail_member_categories.position` et `.hidden`. Règles :
  `62-courrier-client.sql` (nouveau). Code `CA024`
  (`DB_CLIENT_MAIL_REFUSED`).
- Réglages : lien « Catégories du courrier » (service **Domiciliation**),
  droit `centre.configurer` — aucun droit nouveau.
- Aucun événement de notification nouveau.
- Lot 4 : brancher `countMailToHandle` sur la pastille « Courrier » et
  l'accueil.
- Durées de conservation : le carnet suit la fiche de l'entreprise
  (`docs/rgpd/durees-de-conservation.md`).
- Tests : `classement-regles.test.ts` (ignorer), `classement-filtres.test.ts`
  (filtres combinés), `categories-reglages-regles.test.ts` (listes du centre
  et de la personne, rangs, noms, formulaire), `carnet-adresses-regles.test.ts`
  (carnet, choix d'adresse, domiciliation) ; contre la base :
  `classement.db.test.ts` (ignorés, plis à traiter, expéditeur),
  `categories-reglages.db.test.ts` (réglages, portée, `CA024`, anonymisation),
  `carnet-adresses.db.test.ts` (adresse par défaut, portée, `CA024`, adresse
  figée, anonymisation).
- À vérifier au téléphone, à 375 px : la carte d'un pli et ses gestes, le
  menu « Demander au centre », la liste des catégories, le carnet (aucun
  navigateur dans la CI).
