# ADR 017 — Planning : semaine toutes ressources, vue mois et filtres

**Date** : 2026-10-01
**Statut** : accepté — amende l'ADR 011 (« La vue semaine suit une ressource,
pas le centre »)

## Contexte

Le cahier des charges (slide 15, exigence R03) demande un planning où l'on
voit toutes les ressources sur une même semaine, où l'on crée une réservation
directement dans une case, où l'on repère d'un coup d'œil les créneaux
occupés, avec des filtres par type de ressource et par client, et une bascule
jour / semaine / mois.

Ce qui existait :

- la vue jour, une colonne par ressource ;
- la vue semaine d'**une** ressource, sept colonnes graduées heure par heure.
  L'ADR 011 avait écarté la semaine toutes ressources : « la grille deviendrait
  illisible dès la dizaine de ressources, et le centre en compte une
  cinquantaine avec les boîtes aux lettres » ;
- aucun filtre, aucune vue mois.

L'ADR 016 (décision D2) a tranché : semaine multi-ressources **filtrée par
type**, et vue mois en taux d'occupation par jour, pas en créneaux.

Depuis l'ADR 018, les bureaux et les boîtes aux lettres loués portent une
occupation de contrat : une ligne de `bookings` qui couvre des journées
entières, parfois sans terme. Le planning doit les montrer sans les confondre
avec une réservation.

## Décision

### Trois échelles, un seul état dans l'URL

Jour (`/reservations`), semaine (`/reservations/semaine`) et mois
(`/reservations/mois`) partagent une barre : bascule d'échelle, période
précédente et suivante, saut à une date, filtres.

Tout l'état tient dans l'URL : `date`, `type`, `client`, et `ressource` pour la
semaine détaillée. Chaque lien de bascule garde la date et les filtres : on
change d'échelle sans refaire son tri. Une valeur inconnue est ignorée plutôt
que de faire échouer la page, et un client archivé ou d'un autre centre n'est
pas retenu. Les filtres sont un formulaire GET : ils marchent sans JavaScript
et l'adresse obtenue se partage.

### La semaine met les ressources en lignes

C'est la réponse à l'objection de l'ADR 011. La grille qu'elle redoutait mettait
les ressources en colonnes : cinquante colonnes de sept jours. Ici, une
ressource est une **ligne** et un jour une **colonne** : sept colonnes, quel que
soit le nombre de ressources. La grille s'allonge au lieu de s'élargir.

Le filtre par type ramène la liste à ce qu'on cherche — les salles, les
bureaux. Sans filtre, les lignes sont regroupées par type, avec un titre par
groupe.

Chaque case (une ressource, un jour) montre :

- une **barre d'occupation** sur l'amplitude murale commune de la semaine,
  heures d'ouverture en blanc, réservations en bleu ; deux barres désignent les
  mêmes heures, la comparaison se fait d'un coup d'œil ;
- les réservations **en toutes lettres** — horaire, objet, état — trois au
  plus, puis un renvoi à la vue jour ;
- « Libre », « Fermé » ou « Complet » quand il n'y a rien à lister.

Cliquer dans la case ouvre le formulaire de réservation pré-rempli : la
ressource, le jour, le **premier quart d'heure libre** dans l'ouverture et le
client filtré. Au clavier, ce lien est le premier arrêt de la case ; les
réservations listées sont des liens à part, posés au-dessus. Une case complète
ne propose rien.

La semaine graduée d'une seule ressource (ADR 011) reste : on y arrive en
cliquant le nom d'une ligne (`ressource=`). Les deux répondent à des questions
différentes — « qu'est-ce qui est libre mardi » contre « à quelle heure cette
salle est libre ».

### Le mois se lit en taux d'occupation

Une ligne par ressource, une colonne par jour, une colonne « Mois ». Chaque
case écrit le taux : le temps occupé **dans les heures d'ouverture** de la
ressource, rapporté à ces heures. Les réservations de toutes natures comptent,
occupations de contrat comprises ; les annulées non.

- Un jour fermé n'a pas de taux : « – ». Un jour fermé où une réservation est
  posée quand même : « hors ».
- L'arrondi ne ment pas : 0 seulement si rien n'est pris, 100 seulement si tout
  l'est. Un quart d'heure sur onze heures donne 1, une salle presque pleine 99.
- Le taux du mois additionne les minutes, jours fermés exclus.
- La teinte (blanc, bleu clair à deux intensités, bleu foncé) redouble le
  nombre, elle ne le remplace pas.

Cliquer une case ouvre la vue jour, filtres conservés. Au clavier, ce sont les
**en-têtes de colonne** qui y mènent : une case par ressource et par jour ferait
des centaines d'arrêts de tabulation pour trente et une destinations. Les cases
gardent leur lien pour la souris, hors de la tabulation.

### Le filtre client met en avant, il ne masque pas

Filtrer sur un client :

- met ses réservations en avant ;
- réduit celles des autres à « Occupé », en gris, sans les retirer. Un créneau
  pris par un autre reste pris, et le masquer le ferait passer pour libre ;
- pré-remplit ce client dans toute réservation créée depuis le planning ;
- restreint à ce client la liste des réservations sous la vue jour ;
- en vue mois, marque d'un point les jours où il occupe la ressource, avec le
  texte correspondant pour les lecteurs d'écran.

### Les occupations de contrat se lisent sur la durée

- Elles s'affichent « Occupé — contrat CT-2026-0001 », avec leur période (« du
  1 mars 2026 au 30 juin 2026 », « depuis le 1 mars 2026, sans terme »), jamais
  « 00:00 – 00:00 » ni « jusqu'au 31/12/9999 ».
- En semaine et en mois, les jours consécutifs couverts par un même contrat
  sont **fusionnés en une seule case**. La ligne d'un bureau loué trois ans dit
  le contrat une fois au lieu de le répéter sept ou trente et une fois.
- Leur lien mène au contrat, pas à la réservation : l'occupation s'y gère, et
  la base refuse qu'on l'annule ou la déplace directement (`CA001`). La fiche de
  réservation d'une occupation n'offre plus ni déplacement ni annulation.
- Elles n'étirent pas l'amplitude de la vue jour (minuit à minuit) : elles sont
  rognées sur les heures affichées, comme le reste.

### États sur les jetons de la charte, toujours écrits

Les blocs et les barres utilisent les jetons `--statut-*` de `globals.css` :
bleu clair pour « à valider », bleu foncé pour « confirmée » et « sous
contrat », gris pour « indisponible », « fermé » et les réservations des autres
clients. Chaque état est aussi écrit en toutes lettres, et une légende explique
chaque teinte.

## Justification

**Pourquoi les ressources en lignes.** C'est la disposition des plannings de
ressources éprouvés (hôtellerie, location de salles) : la dimension qui varie
— le nombre de ressources — va dans le sens qui défile naturellement. La
dimension fixe — sept jours — tient dans la largeur d'un écran de bureau.

**Pourquoi un taux plutôt que des créneaux au mois.** À trente et un jours de
large, une case fait trente pixels : un créneau d'une heure y fait trois
pixels. Ce qui se lit à cette échelle, c'est « quels jours cette salle est
pleine » et « quels bureaux sont loués ».

**Pourquoi le premier quart d'heure libre.** C'est la question que le clic pose :
« quand puis-je la réserver ce jour-là ». Le quart d'heure est le pas du
formulaire ; une heure non alignée serait refusée par le champ.

## Alternatives écartées

**Ressources × jours en colonnes** : la grille de l'ADR 011, cinquante fois sept
colonnes. Rien ne la sauve, filtre ou pas.

**Le filtre client qui retire les réservations des autres** : plus net, mais un
créneau pris par un autre client paraîtrait libre, et le clic proposerait une
réservation que la contrainte d'exclusion refuserait.

**Une vue mois en créneaux** : illisible, voir plus haut. Une vue mois en
« occupé / libre » binaire : perd la différence entre une salle prise une heure
et une salle prise toute la journée.

**Calculer le taux en SQL** : un agrégat par ressource et par jour serait plus
court à transférer, mais devrait refaire en SQL la résolution des horaires
(règles propres, fermetures, changements d'heure) que `openingWindows` fait déjà.
Le mois d'un centre fait quelques centaines de réservations : on les lit, et le
calcul reste dans une fonction pure, testée.

## Conséquences

Positives : le staff voit la semaine de tout le parc sans cliquer sept fois,
réserve depuis la case, repère les bureaux loués sur la durée, et passe d'une
échelle à l'autre sans perdre ses filtres. Les fonctions de grille
(`semaine-ressources.ts`, `mois.ts`, `filtres.ts`, `affichage.ts`) sont pures et
testées, changements d'heure compris.

Négatives : la vue mois charge toutes les réservations du mois, occupations
comprises ; à l'échelle d'un centre c'est sans effet, en multi-centres la
requête reste filtrée par centre. Le taux ne pondère pas par le prix : une
salle pleine à 50 % n'est pas forcément la moitié de son chiffre — ce sera
l'objet des indicateurs (R31), qui pourront réutiliser `dayOccupancy`.

**Reste à faire** :

- ~~le numéro de casier (R01) n'est unique que par vérification applicative~~ :
  fait, l'index unique partiel `resources_tenant_locker_numero_key` sur
  `lower(attributes ->> 'numero')` des casiers vivants (migration 0028) remplace
  la vérification en code ;
- un réglage pour masquer les ressources hors service de la vue mois, si la
  liste devient longue.
