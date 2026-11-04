# ADR 061 — Demandes et réservations sur plusieurs jours

**Date** : 2026-11-04
**Statut** : accepté — complète les ADR 005, 023 et 036 ; remplace la limite
de huit heures de la page publique ; migration 0009. Règle tarifaire et
valeurs par défaut **à valider par l'exploitation**.

## Contexte

Recette du 04/11/2026, lot 5 : le camion, les salles, les bureaux et le
matériel (lot 6) doivent pouvoir être demandés sur plusieurs jours d'affilée.

Jusqu'ici, tous les formulaires prenaient **une seule date** et deux heures :

- la page publique (`public-booking-form.tsx`), plafonnée à huit heures
  (`MAX_REQUEST_MINUTES` de `requests.ts`), une défense contre une demande
  anonyme qui bloquerait une salle toute une journée ;
- l'espace client (`portail-booking-form.tsx`), jusqu'à la fin de la plage
  libre du jour (`PORTAL_MAX_MINUTES = 24 h`) ;
- le back-office, création et déplacement : une date, deux heures.

La base, elle, acceptait déjà toute période : le trigger anti-chevauchement
compare des instants (décision 3), les occupations de contrat couvrent des
mois (ADR 018), et `quote()` compte la durée en heure murale du centre, ce qui
garde trois jours pour trois jours à travers le changement d'heure (ADR 023).
Mais une période de plusieurs jours s'y chiffrait aussi à l'heure ou à la
demi-journée, nuits comprises : le cas tarifaire `semaine-grille-reelle`
facturait un poste de bureau du lundi au samedi trente demi-journées, et
posait la question à l'exploitation.

## Décision

### 1. Une période continue, une seule réservation

Une demande sur plusieurs jours a un **début** (jour et heure) et une **fin**
(jour et heure). C'est une seule ligne de `bookings`, un seul devis figé, une
seule ligne de devis Dolibarr. Le trigger anti-chevauchement la garde comme un
créneau d'une heure, bornes `[)` : il reste le garde final (décision 3), et le
code ne fait qu'annoncer et refuser avant l'écriture ce que le demandeur peut
corriger.

Le cas d'un seul jour reste celui d'avant : sans choix d'un autre jour, le
jour de fin est celui du début, et la règle du jour même ne change pas.

### 2. La nuit appartient à la période

Une période de plusieurs jours est **tenue jour et nuit** : personne d'autre
ne peut prendre la ressource entre son début et sa fin.

- Le **camion** reste au client la nuit : c'est la location elle-même.
- Une **salle** ou un **bureau** ne s'occupe pas la nuit — le client n'y entre
  qu'aux heures d'ouverture — mais la nuit lui reste réservée : il y laisse son
  matériel, et le centre, fermé, ne l'aurait vendue à personne.

Règles qui en découlent, pour les demandes en ligne (page publique et espace
client) :

- **le début et la fin tombent dans les heures d'ouverture** de la ressource
  (ADR 010, horaires portés par la ressource, ADR 012) : on prend et on rend
  la ressource quand le centre est ouvert. Une fin à l'heure d'ouverture
  compte : le camion pris lundi 9 h se rend mardi 9 h ;
- les **nuits, les pauses et les jours habituellement fermés** compris dans la
  période sont enjambés : du vendredi au lundi, le week-end est au client ;
- une **fermeture exceptionnelle** (`closures`) comprise dans la période la
  rend indisponible en ligne, comme une réservation. L'équipe peut toujours la
  poser au back-office, qui ne contrôle pas l'ouverture (ADR 010) ;
- le jour même, le créneau tient toujours dans une seule plage libre, sans
  enjamber la pause de midi : rien ne change.

Le prix en tire la conséquence (§ 4) : jamais l'heure ni la demi-journée sur
plusieurs jours, qui feraient payer ces nuits heure par heure.

### 3. Un moteur commun, sans base

`reservations/periode.ts` (pur, `periode.test.ts`) :

- `periodAvailability` : les plages d'ouverture de chaque jour et les plages
  **libres en continu** sur toute l'étendue, réservations et fermetures
  exceptionnelles retirées. Rien de ce qui occupe n'y figure ;
- `periodRejection` : la première raison de refuser une période — durée
  minimale, durée maximale du produit, début ou fin hors ouverture, créneau
  pris ;
- `periodEndDates` et `periodEnds` : les jours puis les heures de fin que le
  formulaire propose pour un départ, jusqu'à la réservation suivante et dans
  la durée maximale ;
- `periodLabel`, `periodDuration` : « du mardi 3 novembre 2026 à 09:00 au
  jeudi 5 novembre 2026 à 18:00 », « 2 jours 9 h ».

`periode-queries.ts` lit dans la transaction de l'appelant — `withTenant()`
pour la page publique, la portée client pour l'espace client — les horaires de
la ressource (et ceux du centre en repli), les fermetures de la période et les
créneaux occupés, leurs heures seulement (`listBusyRanges`). Les lectures
portent leur filtre `tenant_id`.

Les formulaires calculent les fins avec ces fonctions ; les actions serveur
relisent la période en base et appliquent `periodRejection` avant d'écrire ;
le préavis et l'horizon du centre se vérifient sur le début, comme avant.

### 4. Le prix : des journées de 24 heures entamées, plafonnées à la semaine

`quoteBooking()` (`facturation/devis.ts`) garde ses règles (ADR 023) et en
ajoute une :

- **une période qui déborde de son premier jour** (la fin est exclue : une
  réservation qui finit à minuit pile reste sur sa journée) **ne se chiffre
  qu'à la journée ou à la semaine** ;
- la quantité reste celle de l'ADR 023 : chaque tranche de **24 heures
  d'heure murale entamée** au-delà de la tolérance du centre est une journée
  due ; une semaine entamée est due (R08) ;
- l'unité retenue reste **la moins chère** : les journées sont donc
  **plafonnées au prix de la semaine** dès qu'elles la dépassent ;
- une grille qui n'a ni prix à la journée ni prix à la semaine pour la
  ressource **ne chiffre pas** la période (`aucun-tarif`) : l'accueil la
  chiffre, et une ressource à confirmation immédiate passe en demande
  (ADR 036).

Jeu de cas tarifaires (R10, `cas-tarifaires.ts`), **à valider par
l'exploitation** : trois journées du lundi 9 h au mercredi 18 h ; une journée
du lundi 14 h au mardi 12 h ; la semaine qui plafonne cinq journées ; neuf
jours de camion ; les deux changements d'heure (samedi 24 → lundi 26 octobre
2026, samedi 27 → lundi 29 mars 2027 : deux journées chacun, pour 49 et
47 heures réelles). Le cas `semaine-grille-reelle` change : le poste de bureau
du lundi au samedi n'est plus chiffré trente demi-journées (210 € HT) mais
laissé à l'accueil, faute de prix à la journée ou à la semaine.

### 5. Une durée maximale par produit, réglable

La limite de huit heures de la page publique est retirée. Elle est remplacée
par une **durée maximale d'une demande en ligne, par produit**, comptée en
**jours du centre touchés** par la période (1 : le jour même seulement ; 3 : du
lundi au mercredi). Elle vaut pour la page publique et pour l'espace client ;
l'équipe n'en a pas au back-office.

- Réglage par centre : `tenants.booking_max_days`, un objet JSON par clé de
  produit (`{ "vehicules": 7 }`), saisi dans **Disponibilités**, à côté du
  préavis et de l'horizon. Un objet plutôt qu'une colonne par produit : un
  produit nouveau n'appelle pas de migration.
- Valeurs par défaut (`reservations/durees.ts`), **à valider par
  l'exploitation** : salles 5 jours, bureaux 5 jours, camion 7 jours ; la
  domiciliation ne se réserve pas sur une période. Un réglage illisible en
  base reprend la valeur par défaut ; la saisie est bornée de 1 à 90 jours.

La défense reste : une demande en attente bloque désormais jusqu'à la durée
maximale de son produit, mais elle passe par les mêmes garde-fous (ALTCHA,
plafonds par adresse IP et par adresse électronique, ADR 047), et le camion
passe toujours par l'accueil (ADR 043).

### 6. Les écrans

- **Page publique** : après l'arrivée, un « Jour du départ » (le même jour par
  défaut), puis l'heure du départ ; seuls les jours et les heures possibles
  sont proposés. Un produit réglé sur un jour garde le formulaire d'une seule
  journée, sans le plafond de huit heures : jusqu'à la fin de la plage libre.
- **Espace client** : de même, « Jour de fin » entre l'heure de début et
  l'heure de fin. Une colonne au téléphone, trois au-delà ; listes de 44 px
  de haut (`min-h-11`). Le contrôle à l'écran à 375 px reste à faire, le
  serveur de développement n'ayant pas été lancé pour ce lot.
- **Back-office** : création et déplacement prennent un jour de fin ; le
  verdict dit « Période libre … nuits comprises » ou nomme la réservation qui
  bloque, sur la semaine affichée et les quatre suivantes — au-delà, la base
  tranche à l'enregistrement.
- **Affichage** : la fiche d'une réservation dit sa période ; le planning du
  jour, « dès 09:00 » ou « jusqu'à 18:00 » ; « Demandes » et l'espace client,
  « 09:00 → 5 nov. 18:00 » (`formatBookingHours`, déplacé dans
  `reservations/affichage.ts`).

### 7. Devis Dolibarr

Rien ne change pour le développeur Dolibarr : le devis transmis
(`GET /api/dolibarr/devis`) portait déjà `reservation.debut` et
`reservation.fin` en instants, et la ligne d'une réservation sur plusieurs
jours se lit « Salle Mont Blanc — du lundi 9 novembre 2026 09:00 au mardi
10 novembre 2026 18:00 », unité `journée`, quantité 2. La notice
`docs/integrations/dolibarr.md` en donne l'exemple.

### 8. Ce que le matériel (lot 6) reprend

Le parcours est générique par produit et par type de ressource ; aucune liste
de types n'y est écrite. Pour le matériel :

- ajouter le produit à `ressources/produits.ts` : `defaultMaxRequestDays`
  (`durees.ts`) est un `Record` exhaustif, la compilation exige d'y dire sa
  durée par défaut ; le réglage apparaît alors seul dans Disponibilités ;
- rattacher le type à un produit de devis dans
  `questionnaires.ts` (`productForResourceType`) ;
- lui donner des prix à la journée ou à la semaine dans la grille : sans eux,
  une période de plusieurs jours n'est pas chiffrée.

## Justification

**Pourquoi une seule réservation et non une par jour.** La recette le
demande, et c'est la seule forme que le trigger protège de bout en bout : une
série de journées laisserait les nuits sans garde, ferait plusieurs devis et
plusieurs lignes Dolibarr, et le camion n'est pas rendu chaque soir.

**Pourquoi des journées de 24 heures et non des jours du calendrier.** C'est
la règle déjà écrite de l'ADR 023 (unité entamée, durée en heure murale),
celle d'une location de véhicule, et elle reste une seule règle pour tous les
produits. Elle a un coût pour une salle, dit dans les cas tarifaires : du
lundi 14 h au mardi 12 h coûte une journée, alors que deux demi-journées de
deux jours différents sont occupées. À trancher par l'exploitation.

**Pourquoi refuser une fermeture exceptionnelle en ligne.** Une fermeture est
posée pour une raison (entretien du camion, jour férié, inventaire) que le
demandeur ne voit pas. Mieux vaut un refus clair et un appel à l'accueil
qu'une location engagée sur un jour où le centre ne peut pas la tenir.

**Pourquoi des jours et non des heures pour la durée maximale.** Le centre
pense « jusqu'à une semaine », et le compte en jours touchés est celui que le
formulaire montre (jour du début, jour de fin).

## Alternatives écartées

- **Une semaine et des journées, sur deux lignes** (neuf jours = une semaine +
  deux journées) : une réservation fige un seul devis (`bookings.quote_*`) et
  une seule ligne part dans Dolibarr. Au-delà de sept jours, la semaine
  entamée est due (R08) ou les journées, la moins chère : la question est
  posée dans les cas tarifaires.
- **Chiffrer à l'heure les seules heures d'ouverture** : demanderait les
  horaires dans `quote()`, et une salle tenue la nuit n'en serait pas moins
  bloquée.
- **Une table des durées par produit** : une table de plus avec sa garde de
  centre, pour un réglage que seul le code lit.
- **Plafonner aussi le back-office** : l'équipe réserve librement, y compris
  hors des heures (ADR 010).

## Conséquences

- **Migration 0009** : `tenants.booking_max_days`, JSON, `{}` par défaut. Sans
  réglage, les valeurs par défaut s'appliquent.
- Une salle demandée du vendredi au lundi paie le week-end (quatre journées,
  ou la semaine si elle est moins chère). Le client qui n'en veut pas fait deux
  demandes d'un jour.
- **À valider par l'exploitation** : les valeurs par défaut (5, 5, 7 jours) ;
  la journée de 24 heures pour les salles ; le prix au-delà de sept jours ; le
  refus en ligne d'une période qui contient une fermeture exceptionnelle ; le
  début et la fin dans les heures d'ouverture.
