# ADR 070 — La cloche montre les demandes à traiter, « Demandes » quitte le menu

**Date** : 2026-11-05
**Statut** : accepté — amende l'ADR 059 § 1 (la cloche ne lit plus ses
notifications, lues membre par membre, mais les files de « Demandes ») et
les ADR 048 et 053 (« Demandes » reste la seule boîte de réception, mais n'est
plus une entrée du menu, chaque rayon a sa ligne « Demandes » filtrée, § 4) ;
sans migration

## Contexte

Après la recette du 04/11, le responsable produit trouve que la cloche de
l'équipe (ADR 059) et l'entrée « Demandes » du menu (ADR 048, ADR 053) font
doublon : deux compteurs en haut du back-office annoncent les mêmes demandes.
La cloche avait en outre ses limites :

- elle disait « une demande est arrivée », pas « une demande attend » : une
  notification lue restait, alors qu'une demande lue puis oubliée n'était plus
  signalée nulle part ;
- le « lu » était propre à chaque membre : une demande déjà validée par une
  collègue restait « non lue » pour les autres ;
- elle ne voyait que ce que ses déclencheurs avaient posé : ni les devis de
  l'accueil à compléter, ni, au premier déploiement, les demandes déjà en
  attente.

Trois façons de supprimer le doublon lui ont été présentées : la cloche seule,
« Demandes » seule, ou une « Demandes » par rayon (le menu de l'ADR 046, jugé
répétitif le 20/10). Il a choisi **la cloche seule**.

## Décision

### 1. La cloche est la liste de ce qui reste à traiter

- **Ses lignes sont lues dans les files de « Demandes »**, au moment de
  l'affichage (`inboxFeed`, `cloche-queries.ts`) : réservations en attente
  (`listPendingRequests`), devis à compléter (`listProposals`,
  `awaitsReception`), offres demandées (`listOfferRequests`), demandes de
  courrier déposées ou prises en charge (`listMailRequests`). Les mêmes
  fonctions que la page, donc les mêmes règles, et le filtre `tenant_id` de
  chacune (décision 1).
- **Son nombre est celui de « Demandes » et d'« Aujourd'hui »** (`inboxCount`) :
  chaque demande une fois, le devis né avec une demande en attente n'étant pas
  compté à part. La coque le calcule déjà pour le premier affichage ; la
  cloche le relit toutes les minutes et à chaque navigation, comme avant, et
  aussi quand la coque recompte après une action sur la même page.
- **Une demande en sort dès qu'elle est traitée** — validée, refusée, faite,
  annulée —, par n'importe quel membre. Une demande de courrier **prise en
  charge** reste, marquée « Prise en charge », jusqu'à ce qu'elle soit faite :
  c'est la règle de « Demandes » (ADR 057), et son compteur la compte.
- **Plus de « lu / non lu »** : la pastille dit ce qui reste à faire, pas ce
  qu'un membre a vu. « Tout marquer comme lu » et la coche de chaque ligne
  disparaissent, avec leurs actions (`cloche-actions.ts`).
- **Chaque ligne** : la nature (« Demande de réservation », « Demande de
  devis », « Demande de domiciliation », « Devis à compléter », « Offre
  demandée », « Demande de courrier »), qui (la fiche du client, sinon le
  demandeur de la page publique, « Visiteur du site » à défaut — une
  anonymisation vaut donc ici sans rien de plus), un résumé (ressource et
  créneau, numéro du devis, offre, nature de la demande et du pli — jamais
  l'expéditeur, ADR 015), l'heure d'arrivée, et le lien vers la demande dans
  « Demandes », à son ancre. Les 20 plus récentes ; « Voir toutes les
  demandes » mène à la page.
- **Droits** : la route reste gardée par `notifications.consulter` ; chaque
  file se borne ensuite aux droits du rôle — `demandes.traiter` pour les
  réservations, devis et offres, `courrier.gerer` pour le courrier —, ceux
  des sections de la page.
- **L'état des lieux signé par le client n'y figure plus** : ce n'est pas une
  demande, rien n'attend l'équipe. Le courriel au centre (`inspection_signed`)
  part toujours.

### 2. « Demandes » quitte le menu, la page reste

- L'entrée « Demandes » et son compteur sortent de `menu.ts`. La page
  `/demandes` reste la seule boîte de réception (ADR 048) : on y arrive par la
  cloche, par la tuile d'« Aujourd'hui », et par les liens des courriels au
  centre. Ses pastilles par produit et ses adresses filtrées
  (`?produit=salles`) ne changent pas.
- **Aucune « Demandes » par rayon** : la règle de l'ADR 053 tient.
- L'historique des demandes de courrier (`/courrier/demandes`) allume
  désormais « Courrier », dans le rayon Domiciliation, dont le compteur reste.
- `menu.test.ts` vérifie qu'aucune entrée ne mène à « Demandes ».

### 3. Les courriels ne changent pas

Chaque demande envoie toujours son courriel à l'adresse du centre (ADR 038) :
c'est l'« e-mail à l'admin » de la recette.

### 4. Chaque rayon a sa ligne « Demandes », comptée

Complément du 05/11, en deux temps, après essai :

1. la cloche disait 8, le rayon Domiciliation 7 (ses demandes de courrier),
   et rien ne disait où était la huitième — une demande de salle de la page
   publique ;
2. un nombre posé sur le titre du rayon Salles ne menait nulle part : déplié,
   aucune ligne ne montrait la demande.

D'où, au choix du responsable produit — c'était son idée de départ :

- **Chaque rayon de produit s'ouvre sur une ligne « Demandes »**, qui mène à
  « Demandes » filtrée sur ce produit (`/demandes?produit=salles`) et porte le
  nombre de ses demandes à traiter (`inboxCountsByShelf`, `journee.ts`) : les
  réservations en attente du produit de leur ressource, les devis à compléter
  rangés comme dans les pastilles de la page (`proposalProductKey`), et, pour
  Domiciliation, les demandes de courrier. Plié, le rayon garde ce nombre à
  son titre.
- **« Tous les services » s'ouvre sur « Autres demandes »**
  (`/demandes?produit=autres`) : ce qui ne relève d'aucun produit, offres
  groupées et devis sans ressource. La page « Demandes » reçoit ce filtre et
  sa pastille « Autres ».
- **La somme des lignes est le nombre de la cloche** : chaque demande dans une
  seule ligne, et `menu.test.ts` vérifie que chaque rayon est compté une fois.
- **Chaque ligne de la cloche mène à « Demandes » filtrée sur son rayon** : le
  menu ouvre ce rayon et allume sa ligne « Demandes ».
- **Le compteur de l'entrée « Courrier » disparaît** : la ligne « Demandes » de
  Domiciliation le reprend ; garder les deux referait le doublon.
- **Toujours pas de « Demandes » générale au menu** : la cloche et la pastille
  « Tous les produits » de la page y mènent.

**Écart assumé avec l'ADR 053** (« pas de Demandes par rayon ») : la règle
visait la répétition de l'ADR 046, cinq « Demandes » plus une vue d'ensemble.
Ici chaque ligne est un filtre distinct, sans vue d'ensemble au menu, et c'est
le seul moyen de dire dans le rayon où se trouve ce qu'il compte. Le menu passe
de 21 à 27 entrées, dans des rayons pliés tant qu'on ne les ouvre pas
(ADR 067).

## Justification

**Une liste de travail plutôt qu'un fil d'événements.** Ce dont l'accueil a
besoin, c'est de savoir ce qui attend, pas ce qui est arrivé : lire la cloche
dans les files supprime les trois limites du contexte d'un coup, et rend son
nombre identique à celui de la page.

**La cloche plutôt que l'entrée du menu.** Elle est visible sur téléphone sans
ouvrir le menu (bandeau du haut), elle se met à jour seule chaque minute, et
elle montre les demandes sans changer de page. L'entrée du menu ne faisait que
compter.

## Alternatives écartées

- **Garder « Demandes » au menu et retirer la cloche** : on perdait l'alerte
  visible sur téléphone et la liste sans changer de page.
- **Une « Demandes » par rayon** : le menu de l'ADR 046, écarté le 20/10 pour
  ses répétitions (cinq « Demandes ») ; les pastilles de la page font la même
  chose.
- **Garder les notifications de l'ADR 059 en ne montrant que celles dont la
  demande attend encore** : le nombre de la cloche n'aurait pas été celui de la
  page (devis de l'accueil, demandes antérieures au déploiement), écart que
  rien n'expliquerait à l'écran.

## Conséquences

- `signalStaff()` et ses appels dans les déclencheurs sont retirés ; plus rien
  n'écrit dans `staff_notifications` ni `staff_notification_reads`. **Les
  tables restent, en sommeil** (une migration appliquée ne se réécrit pas) ; la
  tâche de nuit continue de les purger au terme du journal des messages.
  Une migration pourra les supprimer plus tard.
- La coque ne lit plus de notifications : elle passe à la cloche le nombre
  qu'elle calculait déjà pour « Demandes ».
- `listMailRequests` accepte `newestFirst`, pour que la cloche lise les
  demandes de courrier les plus récentes.
- Tests : `cloche.test.ts` (libellés, ancres, nombre égal à `inboxCount`,
  ordre, visiteur, prise en charge, pas d'expéditeur, borne de la liste),
  `cloche.db.test.ts` (chaque sorte de demande, sortie après traitement,
  droits, autre centre), `menu.test.ts` (une ligne « Demandes » par rayon,
  « Autres demandes », aucune « Demandes » générale, chaque rayon compté une
  fois), `journee.test.ts` (répartition par rayon, même total
  qu'`inboxCount`) et `nav-plie.test.ts`.
