# ADR 082 — Médias et référence Dolibarr sur la fiche des ressources, Réglages par service, « Demandes » sans pastilles

**Date** : 2026-11-17
**Statut** : accepté — recette du 17/11, lot 9 (`docs/recette/2026-11-17.md`).
Amende l'ADR 070 § 2 et § 4 et `CLAUDE.md` (« la pastille Tous de la page y
mène ») : les pastilles de « Demandes » disparaissent ; amende l'ADR 048
(« Réglages » rangée par service) et l'ADR 053 (chaque rayon finit sur sa
ligne « Réglages »). Sans migration. Les choix marqués *à confirmer en
recette* ont été faits par défaut, le responsable produit étant absent.

## Contexte

Quatre notes de la recette du 17/11 visent le back-office :

1. « Ajout de photos, vidéos au sein des services (salles, bureaux, camions)
   et de la référence Dolibarr. » Les photos et vidéos existent depuis
   l'ADR 073, mais sur l'annonce, un écran à part (« Annonces du site ») ; la
   référence Dolibarr des prix (`tarif.<type>.<code>.<unité>`, ADR 049) ne se
   lit nulle part à l'écran.
2. « Les pastilles en haut de “Demandes” font doublon avec le menu de
   gauche. » Depuis l'ADR 070, chaque rayon s'ouvre sur sa ligne « Demandes »
   filtrée : la page arrive déjà filtrée, et ses pastilles répètent le menu.
3. « Réglages rangés par catégorie de service. » La page Réglages avait trois
   groupes techniques (catalogue et tarifs, le centre, équipe et
   configuration), sans lien avec les rayons du menu.
4. « Toutes les données paramétrables dans l'admin, rien d'écrit en dur. »

Les lots 1 à 8 de la même recette ajoutent chacun des réglages (questionnaires,
formules, expéditeurs, pièces, options de domiciliation…), en parallèle : la
nouvelle Réglages doit les recevoir sans effort à la fusion.

## Décision

### 1. Photos et vidéos depuis la fiche de la ressource

- La fiche d'une salle, d'un bureau, du camion ou d'un appareil de matériel
  (`/ressources/<id>`) montre et gère **les médias de son annonce** : le bloc
  « Photos et vidéos » de l'ADR 073 (`annonce-medias.tsx`), tel quel — ajout,
  ordre, description, retrait. Aucun second stockage, aucune autre règle.
- **L'annonce se crée au besoin** : une ressource qui n'en a pas montre
  « Ajouter des photos et vidéos », qui crée l'annonce **en brouillon**
  (titre = nom de la ressource, adresse tirée du nom), invisible du public
  tant que personne ne la publie (`ensureListingForResource`). Une annonce
  existante n'est jamais réécrite ; la ligne de la ressource est verrouillée
  le temps de la création, deux clics ne font qu'une annonce.
- Sous le bloc, l'état de l'annonce (publiée, brouillon) et « Modifier
  l'annonce » (titre, texte, publication), qui restent à l'écran des annonces.
- Casiers et boîtes aux lettres n'ont pas le bloc (un casier ne s'annonce pas,
  une boîte aux lettres se vend par la domiciliation), sauf s'ils ont déjà une
  annonce. Une ressource archivée ne l'a pas. *À confirmer en recette.*

### 2. Référence Dolibarr : déduite du code, pas stockée

- La fiche montre, dans « Prix et référence Dolibarr », le modèle de
  référence de la ressource (`tarif.salle.sal-mb.<unité>`) et celui de son
  type, puis **unité par unité** les prix de la grille par défaut en vigueur :
  référence, état — **« Prix reçu »** (prix propre à la ressource) ou **« Pas
  de prix propre »** (le prix du type s'applique, sa référence est dite) — et
  montant HT. Sans aucun prix, « Pas de prix » et ce que le site annonce alors ;
  sans grille par défaut en vigueur, « Pas de prix » et le lien vers les
  grilles.
- **La référence se déduit du code interne de la ressource**, en minuscules :
  c'est la convention que la route des produits lit déjà (ADR 049) et la clé
  par laquelle elle retrouve la ressource (`lower(code)`). Elle se **modifie
  en modifiant le code** (écran « Modifier ») : sous le champ, la référence se
  lit à mesure de la saisie, et un code changé rappelle de renommer les
  produits dans Dolibarr — et les contrats, qui désignent aussi la ressource
  par son code (ADR 066).
- Un code qui contient un point ne peut pas servir de référence (la route la
  couperait en un morceau de trop) : la fiche et le formulaire le disent.
- Règles pures dans `fiche-ressource.ts`, éprouvées contre le lecteur des
  envois de Dolibarr (`readDolibarrProductEvent`) pour chaque type et chaque
  unité.

« Prix reçu » désigne un prix présent dans la grille : la base ne garde pas
son origine, il peut aussi avoir été saisi à l'écran Tarifs (ADR 049, qui le
laisse ouvert). *À confirmer en recette.*

### 3. Réglages rangés par service

- La page Réglages suit les rayons du menu : **Salles, Bureaux,
  Domiciliation, Camion, Matériel** (dans l'ordre de `produits.ts`), puis
  **Tous les services** et **Le centre**. Un groupe vide pour le rôle ne
  paraît pas.
- `reglages/sections.ts` devient **une liste plate de liens, chacun avec son
  `service`** (un produit, `tous` ou `centre`). Ajouter un réglage, c'est
  ajouter une ligne : la page le range, le rayon du menu gagne sa ligne
  « Réglages » et s'allume sur son écran. `reglagesSections` et
  `reglagesPermissions` restent exportés, calculés.
- **Chaque rayon finit sur sa ligne « Réglages »** (`/reglages?produit=…`),
  quand son produit a au moins un réglage : la page n'y montre que ce
  produit, titre « Réglages — Salles », avec « Voir tous les réglages ». La
  ligne s'allume sur chacun de ses écrans ; « Réglages », en bas du menu,
  s'allume sur ceux de « Tous les services » et du « Centre ».
- Rangement de départ :

  | Service | Réglages |
  |---|---|
  | Salles, Bureaux, Domiciliation, Camion, Matériel | le modèle d'état des lieux de chacun de leurs types (ADR 039), tiré de `produits.ts` — bureau et casier sous Bureaux |
  | Tous les services | Offres, Services, Tarifs, Agendas Google (toute ressource, le camion compris, ADR 072) |
  | Le centre | Horaires et fermetures, Indicateurs, Équipe, Configuration, Connexion au CRM |

  *À confirmer en recette*, notamment les Agendas Google sous « Tous les
  services » plutôt que « Salles », et les modèles d'état des lieux, qui
  n'étaient pas dans Réglages (on y arrivait par « États des lieux »).
- Les réglages des lots 1 à 8 se placent à la fusion sous leur service (voir
  Conséquences).

### 4. « Demandes » sans pastilles

- Les pastilles « Tous les produits / Salles / … / Autres » disparaissent de
  la page. Le titre dit le filtre : « Demandes — Salles », « Autres
  demandes », « Toutes les demandes » ; la description suit.
- Un lien discret **« Voir toutes les demandes »** sous le titre d'une page
  filtrée mène à la vue d'ensemble, sans entrée de menu en plus.
- Les adresses filtrées (`?produit=…`), les lignes « Demandes » des rayons, la
  cloche et ses ancres ne changent pas.

**Contradiction assumée** avec l'ADR 070 (§ 2 « ses pastilles par produit
[…] ne changent pas », § 4 « la pastille Tous les produits de la page y
mène ») et `CLAUDE.md` (« la pastille Tous de la page y mène ») : la note de
recette les juge en doublon du menu. La vue d'ensemble reste joignable par le
lien de la page et par la cloche. `CLAUDE.md` est mis à jour. *À confirmer en
recette.*

### 5. Rien d'écrit en dur de plus

Ce lot n'ajoute ni liste, ni seuil, ni libellé métier : les médias suivent les
règles de l'ADR 073, les prix viennent de la grille (Dolibarr), le rangement
des réglages suit `produits.ts`. Il rend joignables par service les réglages
qui existent et ceux que les lots 1 à 8 ajoutent.

## Justification

**Les médias de l'annonce plutôt que des médias de la ressource.** L'ADR 073 a
mis la vitrine sur l'annonce et a écarté les photos sur la ressource ; la note
demande de les gérer « au sein des services », pas un second jeu. Montrer le
bloc de l'annonce sur la fiche donne l'accès demandé sans doublon de stockage
ni de règles, et l'annonce en brouillon ne publie rien.

**Déduire plutôt que stocker la référence.** Le code est déjà la clé de
Dolibarr pour les prix (ADR 049) et pour les contrats (ADR 066). Stocker une
référence à part ferait deux clés à tenir d'accord, demanderait une migration
et de changer la route des produits ; l'ADR 049 avait écarté une table de
correspondance pour la même raison. Le prix : changer la référence oblige à
changer le code, ce que l'écran dit.

**Une liste plate où chaque lien porte son service.** Les lots 1 à 8 ajoutent
leurs liens en parallèle dans l'ancienne structure : à la fusion, chaque lien
devient une ligne de plus avec son `service`, sans toucher au rangement.

**Une ligne « Réglages » par rayon.** Sur le modèle de « Demandes »
(ADR 070) : chaque ligne est un filtre distinct, le rayon dit où se règle son
produit, et le menu ne répète aucune adresse (`menu.test.ts`).

## Alternatives écartées

- **Colonne `dolibarr_ref` sur la ressource, ou table unité par unité** :
  migration, deux sources de vérité (le code sert aux contrats), route des
  produits à changer.
- **Table `resource_media`** ou photos sur `resources.photo_path` : doublon de
  la vitrine de l'ADR 073, qui l'avait écarté.
- **Créer l'annonce à l'ouverture de la fiche** : une lecture qui écrit, et une
  annonce pour chaque ressource ouverte.
- **Garder les pastilles en ne retirant que celle du produit courant** : le
  doublon reste pour les autres.
- **Pas de ligne « Réglages » dans les rayons** : le rangement par service
  n'aurait été visible que dans la page.

## Conséquences

- Le menu passe de 27 à 32 entrées (une ligne « Réglages » par rayon), dans
  des rayons pliés tant qu'on ne les ouvre pas (ADR 067). `menu.test.ts` :
  plafond à 32, ligne « Réglages » en fin de rayon, chaque réglage allume une
  seule entrée, pages à segment dynamique (`[type]`) reconnues.
- `menu.test.ts`, `reglages/sections.test.ts`, `fiche-ressource.test.ts`,
  `fiche-ressource.db.test.ts` (brouillon créé, annonce existante intacte,
  deux clics, homonyme, archivée, autre centre).
- Sans migration ni règle en base : le fichier `12-ressources-medias.sql` et le
  code `CA028` réservés au lot restent libres.
- Formulaire de la ressource : astérisque des champs obligatoires, `required`
  et `aria-required`, phrase en tête. Marque locale, à remplacer par le
  composant commun du lot 1 à la fusion.
- **À la fusion**, un lien ajouté par un autre lot dans l'ancienne structure
  de `sections.ts` devient une entrée de `reglagesLinks` avec son `service` :
  `{ service: 'domiciliation', href, label, description, permission }`.
- Reste : les consommations envoyées à Dolibarr (ADR 066) citent la référence
  du type (`tarif.salle.journee`), même quand la ressource a un prix propre ;
  à revoir avec le développeur Dolibarr.
