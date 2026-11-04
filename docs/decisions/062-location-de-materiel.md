# ADR 062 — Location de matériel : seul, ou en option d'une salle

**Date** : 2026-11-04
**Statut** : accepté — lot 6 de la recette du 04/11 ; complète les ADR 043
(un produit de devis de plus), 049 (`tarif.materiel.<unité>`), 053 (un rayon
de plus), 061 (le matériel se demande sur plusieurs jours) et 063 (une option
est une occupation comme une autre) ; tient les décisions 2 et 3 de
`CLAUDE.md`. Migration de structure 0010 (numéro à reprendre à la fusion).
Prix, durée maximale, questionnaire et modèle d'état des lieux **à valider
par l'exploitation**.

## Contexte

Recette du 04/11/2026 : « catégorie matériel en location : TV, clim ». Le
responsable produit a tranché : le matériel se loue **seul** (comme le
camion, avec son planning) **ou en option d'une réservation de salle**.
Chaque appareil a son planning : jamais loué deux fois.

## Décision

### 1. Un type de ressource `materiel`, un appareil = une ressource

`materiel` rejoint l'enum `resource_type` (décision 2 : **jamais une table à
part**). Il est ajouté **en fin de liste** : MySQL allonge l'enum sans
réécrire les tables. La même liste sert aux cinq colonnes qui portent un type
de ressource (`resources`, `rate_plan_items`, `offer_items`,
`contract_lines`, `inspection_templates`) : la migration 0010 les modifie
toutes.

Ses attributs (`attributes`, validés par `ressources/attributs.ts`) :
**nature** (obligatoire : télévision, climatisation, vidéoprojecteur…),
**marque**, **modèle**, **numéro de série**, **accessoires fournis** (liste).
Un appareil n'a pas de capacité (elle compte des personnes). Les `Record`
exhaustifs suivent : libellés, champs, modèle d'état des lieux de départ
(état général, fonctionnement vérifié, accessoires remis et complets,
dommages), mode de réservation depuis l'espace client (« accord de
l'accueil » par défaut, réglable par appareil, ADR 036).

### 2. Un produit « Matériel », un rayon au menu

`produits.ts` gagne le produit `materiel` (« Matériel »), dernier rayon, après
le camion. Le rayon (ADR 053) a deux entrées : **Planning du matériel**
(`/reservations/semaine?type=materiel`, la semaine d'abord comme le camion,
le jour l'allume aussi) et **Appareils** (`/ressources?type=materiel`). Il
arrive plié (ADR 067). Les états des lieux du matériel se trouvent par la
pastille « Matériel » de l'historique, comme ceux des salles : deux entrées
suffisent, le menu passe de 19 à 21 (`menu.test.ts`).

Durée maximale d'une demande en ligne (ADR 061) : **7 jours** par défaut,
réglable dans Disponibilités, où le réglage apparaît seul.

### 3. Seul : un produit de devis à lui

Le matériel loué seul passe par **son propre produit de devis**,
`materiel` (`proposals.product`, migration 0010), et non par « espace » ou
« véhicule » : leurs questions (participants, permis B) n'ont pas de sens
pour une télévision, et Dolibarr doit pouvoir le ranger à part. Ses
questions (`questionnaires.ts`, à valider) : où il sert (dans le centre ou
à l'extérieur), livraison ou installation souhaitée, usage. Il **passe par
l'accueil** (`autoValidate: false`), comme le camion : un appareil qui
quitte le centre se remet en main propre.

Il se demande partout où le camion se demande, sans écran nouveau : page
publique (un bloc « Matériel » et le produit dans la fenêtre de
réservation), espace client, back-office ; sur plusieurs jours (ADR 061).
Les annonces publiques (`/annonces`) le montrent sans rien de plus : elles
sont génériques par type.

### 4. En option d'une salle : une réservation liée

Chaque appareil ajouté à une salle est **une réservation à part entière**,
liée à celle de la salle par une colonne de `bookings` :
`parent_booking_id`, clé étrangère composite `(tenant_id,
parent_booking_id)` vers `bookings (tenant_id, id)` (`ON DELETE RESTRICT`),
index `bookings_parent_idx`, contrainte `bookings_parent_consistent`.

- **Le trigger anti-chevauchement la garde** comme toute réservation
  (décision 3) : deux salles au même moment ne prennent pas la même
  télévision, quelle que soit la concurrence. Le code ne fait qu'**annoncer**
  les appareils libres (`listFreeEquipment`, bornes `[)`) ; la base tranche.
- **Son prix est figé sur elle** (R11), à la grille du matériel, et **s'ajoute
  au devis de la salle** : une ligne de plus, repère de l'appareil.
- Elle **suit la salle** : même période, même client, même objet ; validée,
  refusée, déplacée, changée de client et annulée avec elle.
- Une option est aussi une occupation comme une autre pour l'ADR 063 : son
  état des lieux se fait sur sa fiche, et un appareil non restitué bloque la
  suite.

La base tient ce qui fait d'elle une option (`src/db/regles/
25-reservations-liees.sql`, appelé par les triggers de `bookings`, SQLSTATE
**`CA018`**) :

- seule une ressource `materiel` se réserve en option, et une option est une
  réservation (ni indisponibilité, ni occupation de contrat) ;
- la principale est une réservation qui n'est ni du matériel ni elle-même une
  option : **un seul niveau** ;
- une option **ne change jamais de principale** ;
- vivante, elle est **au nom du client de la principale** et **dans sa
  période** ; elle ne se rattache pas à une principale annulée et ne se
  confirme pas avant elle ; posée sur une demande en attente, la base la
  ramène à `pending` — même un appareil réglé en confirmation immédiate ;
- **la principale ne s'annule pas tant qu'une option vit.**

**La cascade se fait dans la même transaction, par le code**
(`reservations/options-cascade.ts`) : MySQL interdit à un trigger d'écrire
dans la table qui le déclenche (erreur 1442). La base garantit seulement
qu'elle n'est jamais oubliée — tout chemin qui annulerait une salle sans son
matériel est refusé. Les chemins tenus : annulation et refus au back-office,
validation d'une demande, déplacement (l'appareil pris sur la nouvelle
période fait refuser le tout), changement de client, annulation des
occurrences d'une série, annulation d'une demande par le client.

L'option n'est proposée que sur une **réservation de salle**
(`options.ts`, `typesWithEquipmentOptions`) : la recette le demande. La base
accepte toute réservation qui n'est pas du matériel ; l'ouvrir aux bureaux ne
demande que d'ajouter le type à cette liste.

### 5. Les écrans

- **Fiche d'une réservation de salle** (back-office) : section « Matériel en
  option » — les appareils réservés avec leur état et leur prix, le total
  salle et matériel, puis « Ajouter du matériel » : des cases à cocher parmi
  les appareils libres sur la même période, chiffrés. L'ajout rend un état
  (ajouté, ou la raison du refus, annoncés) ; tout ou rien.
- **Fiche d'une option** : « En option de … », lien vers la salle ; ni
  déplacement, ni client, ni devis à elle (ils sont ceux de la salle) ; elle
  s'annule seule (sa ligne quitte alors le devis de la salle).
- **Espace client**, réservation d'une salle : une fois le créneau choisi, le
  montant annoncé liste les appareils libres, chiffrés ; les cochés sont
  réservés avec la salle, dans la même transaction et le même devis ; le
  total « avec le matériel » s'affiche. Cases de 44 px de haut. « Mes
  réservations » dit « en option de votre réservation de salle » ; une
  option ne s'annule pas seule depuis l'espace, elle part avec la salle.
- **« Demandes »** : le matériel d'une demande en attente n'est pas une
  demande de plus — il figure sur sa carte (appareils, prix, total) et se
  valide ou se refuse avec elle ; le compteur ne le compte pas. Un appareil
  en attente d'une salle déjà confirmée (espace client, appareil soumis à
  l'accord de l'accueil) se traite seul, sa carte renvoie à la salle.
- La page publique ne propose pas l'option : l'espace client et l'accueil le
  font.

### 6. Le devis

- À sa création — espace client, ou « Établir le devis » au back-office —
  le devis de la salle porte une ligne par option vivante et chiffrée.
- Un appareil ajouté ou annulé ensuite au back-office remet le devis à jour
  tant que Dolibarr ne l'a pas repris : en brouillon, la ligne s'ajoute ou se
  retire ; **prêt, il repasse brouillon le temps de l'écriture puis est
  revalidé au nom du membre de l'équipe**, qui a changé le matériel.
  Transmis, il ne change plus (ADR 043) : l'écran le dit, l'accueil l'annule
  et le refait.
- Une option n'a pas de devis à elle : « Établir le devis » ne la propose
  pas, et la refuse si on la désigne.

### 7. Dolibarr

Les prix arrivent par `tarif.materiel.<unité>` (ADR 049), `tarif.materiel.<code>.<unité>`
pour un appareil plus cher que les autres. Sur plusieurs jours, seuls la
journée et la semaine chiffrent (ADR 061) : il faut au moins
`tarif.materiel.journee`. Le devis transmis dit `produit: "materiel"` pour le
matériel loué seul ; l'option d'une salle est une ligne du devis `espace` de
la salle. `docs/integrations/dolibarr.md` et `dolibarr-produits.md` le
disent au développeur Dolibarr. Les consommations facturables du matériel
relèvent de la seconde tranche (lot 10).

## Justification

**Pourquoi une réservation liée et non une liste d'appareils sur la
réservation de la salle.** Seule une ligne de `bookings` est gardée par le
trigger anti-chevauchement (décision 3) : un appareil rangé dans un champ
JSON de la salle pourrait être loué deux fois. La recette le demande en ces
termes.

**Pourquoi la cascade dans le code, gardée par la base.** MySQL refuse qu'un
trigger de `bookings` écrive dans `bookings` ; une clé étrangère `ON UPDATE
CASCADE` ne propage que des clés, et ses écritures ne déclenchent pas les
triggers. Le code annule donc les options d'abord, dans la transaction ; la
base refuse l'annulation d'une principale qui en garde une vivante, si bien
qu'un chemin oublié échoue au lieu de laisser une télévision bloquée.

**Pourquoi un produit de devis à lui.** Ni les questions d'une salle ni
celles du camion ne valent pour une climatisation ; Dolibarr range ses
propositions par produit.

**Pourquoi l'option sur la salle seulement.** La recette le demande ; le
code ne la ferme que par une liste d'un élément.

## Alternatives écartées

- **Une table `equipment_bookings`** : contraire à la décision 2 et hors du
  trigger anti-chevauchement.
- **La cascade par un trigger `AFTER UPDATE`** : interdite par MySQL
  (erreur 1442).
- **Une option attachée à une option, ou à un camion** : un seul niveau, sur
  une salle ; rien ne le demande.
- **L'option sur la page publique** : la demande anonyme bloque déjà la
  salle ; y ajouter des appareils laisserait un formulaire anonyme bloquer
  le parc. L'accueil les ajoute à la demande.
- **Une option déplaçable seule** : elle sortirait de la période de sa salle.
  Pour changer d'appareil, on annule l'option et on en ajoute une autre.

## Conséquences

- **Migration 0010** (structure, drizzle-kit) : l'enum des types de ressource
  (cinq colonnes) et celui des produits de devis s'allongent ;
  `bookings.parent_booking_id`, sa clé étrangère, son index et sa
  contrainte. Éprouvée sur une base neuve et sur une base migrée avec des
  données. **Règles** : `25-reservations-liees.sql` (nouveau) et
  `20-reservations.sql` (les triggers l'appellent), rejouées par
  `npm run db:migrer`.
- **Code d'erreur `CA018`** (`DB_OPTION_REFUSED`) : le suivant libre au
  moment du lot ; à renuméroter si un lot parallèle l'a pris.
- **À valider par l'exploitation** : prix du matériel (cas tarifaires R10 :
  aucun prix dans la grille réelle ; hypothèses 30 € la journée, 120 € la
  semaine) ; durée maximale de 7 jours ; questionnaire ; modèle d'état des
  lieux ; passage par l'accueil du matériel seul ; l'option ouverte aux
  seules salles ; la revalidation d'un devis prêt au nom de qui ajoute le
  matériel.
- **Hors du lot** : l'option à la création d'une réservation au
  back-office (elle s'ajoute depuis la fiche, une fois la salle posée) ; les
  consommations facturables du matériel vers Dolibarr (lot 10).
