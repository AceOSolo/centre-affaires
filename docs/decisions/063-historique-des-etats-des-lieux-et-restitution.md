# ADR 063 — États des lieux : historique, une entrée par occupation, ressource occupée jusqu'à la sortie

**Date** : 2026-11-04
**Statut** : accepté — complète l'ADR 039 ; s'appuie sur la décision 3 de
`CLAUDE.md` (anti-double-réservation par la base) ; sans migration de
structure (règles seulement : `80-etats-des-lieux.sql`, `85-restitution.sql`,
deux appels dans `20-reservations.sql`)

## Contexte

Recette du 04/11/2026, lot 7 (`docs/recette/2026-11-04.md`) :

- « États des lieux > historique » : la liste `/etats-des-lieux` ne filtrait
  que par étape et par produit, sans pagination ; la fiche d'une ressource
  montrait une liste à plat, sans dire quelle entrée allait avec quelle
  sortie.
- « Si l'état des lieux d'entrée est effectué > plus disponible ». Décision du
  responsable : **les deux** — le bouton « entrée » disparaît, et la
  ressource devient occupée. Rien n'empêchait d'ouvrir une seconde entrée
  pour la même réservation, et une réservation arrivée à son terme libérait
  la ressource même si le camion n'était pas rendu ou le bureau pas libéré.

La décision 3 interdit de vérifier la disponibilité en code : elle passe par
les réservations et leur trigger. Le piège signalé : prolonger la période à
l'aveugle entrerait en conflit avec la réservation suivante déjà confirmée.

## Décision

### 1. Historique : liste complète avec recherche

`/etats-des-lieux` :

- **filtres** client, ressource, période (du / au, jours du centre, le dernier
  compris), étape (entrée ou sortie), état (en saisie, clos, clos à valider,
  validé par le client) et produit (pastilles, ADR 046) ;
- un formulaire en `GET` : la recherche vit dans l'adresse, se partage et
  revient avec « Précédent ». Les clients et ressources proposés sont ceux
  qui ont au moins un état des lieux ;
- **pagination** par 50, total affiché, une page au-delà de la dernière montre
  la dernière ; vrai `<table>` ; état vide qui dit quoi faire (élargir la
  recherche, ou ouvrir un état des lieux depuis une fiche) ; une période à
  l'envers est dite près des dates, sans être appliquée ;
- `InspectionFilter` gagne `clientId`, `kind`, `from` / `until` et l'état
  `closed`. Le paramètre `etape` garde son sens d'état (`draft`, `to_sign`,
  `signed`) : les tuiles d'« Aujourd'hui » (ADR 050) y renvoient ;
  l'entrée ou la sortie passe par `nature=entree|sortie`.

Règles pures dans `historique.ts`, éprouvées par `historique.test.ts`.

### 2. Chronologie par ressource

Sur la fiche ressource, la section « États des lieux » devient une
**chronologie par occupation** (`chronologie-ressource.tsx`) : un groupe de
lignes par occupation — l'entrée puis la sortie qui la clôt —, la plus
récente en tête. L'en-tête de chaque groupe dit le client, l'occupation
(réservation et ses dates, ou contrat et sa période) et sa situation : en
saisie, en cours, **non restituée** (depuis quand), sortie en saisie,
restituée, sortie sans entrée. Il porte les actions utiles : terminer
l'entrée, faire la sortie, terminer la sortie, **comparer sortie et entrée**
(la comparaison de l'ADR 039, sur la fiche de la sortie). Les 20 occupations
les plus récentes ; au-delà, un lien vers l'historique filtré sur la
ressource. Groupement pur dans `occupations.ts` (`groupByOccupation`).

### 3. Une entrée par occupation

**Une occupation** est une réservation (`bookings.kind` autre que
`contract`), ou un contrat sur une ressource — qu'il ait déjà son
occupation (`kind = 'contract'`, ADR 018) ou qu'il soit encore en
brouillon : l'entrée faite avant l'activation reste celle de l'occupation
qui suit. Une réservation rattachée à un contrat reste une occupation à
elle. Même définition en TypeScript (`occupationKey`) et en SQL.

- **À l'écran** : le bouton « État des lieux d'entrée » disparaît dès que
  l'occupation a la sienne ; seule la sortie reste proposée, puis plus rien.
  L'écran d'ouverture grise l'occupation qui n'admet pas l'étape choisie et
  dit pourquoi (« Entrée faite : seule la sortie reste à faire »).
- **Au serveur** (`createInspection`) : refus d'une seconde entrée, d'une
  sortie tant que l'entrée est en saisie, d'une seconde sortie. La sortie
  d'une occupation dont l'entrée est close **clôt cette entrée**, sans choix :
  c'est elle qui rend la ressource. Sans entrée dans l'application, la sortie
  reste possible, comme avant.
- **En base** : la garde des états des lieux appelle
  `inspection_assert_single_entry` (`CA011`), à l'insertion et quand un
  brouillon d'entrée change d'occupation. Un brouillon compte (on le reprend
  plutôt que d'en ouvrir un second), un brouillon retiré ne compte plus.
  Elle verrouille l'occupation — le contrat, ou la réservation — avant de
  compter : un formulaire envoyé deux fois n'ouvre qu'une entrée.

### 4. Ressource occupée jusqu'à la sortie : la règle « non restituée »

**Définition.** Une ressource est **non restituée** depuis la fin prévue de
l'occupation quand :

1. l'état des lieux d'entrée de l'occupation est **clos** (« effectué ») ;
2. la fin prévue est passée (bornes `[)` : finie à 12 h, échue à 12 h) — la
   fin de la réservation, ou la plus tardive des occupations du contrat sur
   la ressource ;
3. aucune sortie **close** ne clôt cette entrée.

Une seule fonction le dit, `inspection_unreturned_since()`
(`85-restitution.sql`) : le trigger la lit, les écrans aussi.

**Ce que la base refuse.** Les triggers de `bookings` appellent
`booking_assert_resource_returned`, après le contrôle de chevauchement et
sous le même verrou de la ressource. Ils refusent (`CA000`) toute écriture
qui **prend du temps sur la ressource après cette fin prévue** :

- une nouvelle réservation, demande, indisponibilité ou occupation de contrat
  qui finirait après elle ;
- une réservation existante qu'on avance, qu'on allonge, qu'on déplace sur la
  ressource ou qu'on rétablit.

Restent permis : l'occupation elle-même — la prolonger pour régulariser, sous
le contrôle de chevauchement ordinaire —, raccourcir, confirmer une demande
déjà posée, annuler, changer un titre.

**Les réservations déjà posées** après la fin prévue sont **en conflit** :

- au planning, jour et semaine d'une ressource : bloc à bordure
  `--statut-conflit`, icône et libellé « Conflit — … » ; semaine de toutes
  les ressources : libellé et couleur ; mois, qui ne dessine que les
  occupations de contrat : leur couleur, et le bandeau ci-dessous ; listes :
  pastille « Conflit — ressource non restituée » avec l'icône ;
- sur « Aujourd'hui » : la même pastille dans le planning du jour ;
- partout, un **bandeau d'alerte** en tête (« Aujourd'hui », planning jour,
  semaine, mois, fiche ressource) : la ressource, le client, la fin prévue,
  les réservations en conflit, et « Faire l'état des lieux de sortie ».
  C'est l'alerte à l'équipe : « Aujourd'hui » est sa page d'arrivée
  (ADR 050).

**Ce qui lève le blocage** : la sortie close qui clôt l'entrée ; ou
l'occupation prolongée (sa fin redevient à venir), ou annulée.

**Le message.** `CA000` est le code du créneau occupé : tous les chemins
d'écriture le traduisent déjà — planning, saisie en masse, séries, espace
client, page publique, contrats, avenants, reconductions. L'espace client et
la page publique gardent leur message (« ce créneau vient d'être pris ») :
ils n'apprennent rien d'un autre client. Le planning de l'équipe montre celui
de la base : « Ressource non restituée : « Utilitaire » attend son état des
lieux de sortie. »

### 5. Pourquoi cette règle, et pas une plus étroite

La date de restitution est inconnue tant que la sortie n'est pas faite. Deux
lectures de « la base refuse une nouvelle réservation qui commencerait avant
la restitution » étaient possibles :

- **retenue** : rien ne se pose après la fin prévue tant que la sortie n'est
  pas close — la seule certitude est que la ressource est occupée jusqu'à la
  sortie ;
- écartée : refuser seulement ce qui commence avant maintenant. La base
  accepterait alors une réservation dans une heure sur un camion pas rendu,
  et l'afficherait aussitôt en conflit : elle créerait sciemment le conflit
  qu'elle doit empêcher.

Le blocage dure le temps du retard ; il force l'état des lieux de sortie, qui
conditionne la restitution du dépôt de garantie. C'est la solution la plus
simple qui tient les exigences : **rien n'est écrit** — ni période
prolongée, ni indisponibilité, ni état stocké —, la règle se calcule à
chaque écriture depuis les états des lieux.

### Cas éprouvés (`restitution.db.test.ts`)

- seconde entrée refusée à l'écran et en base, en saisie comme close ; place
  rendue par le retrait du brouillon ; trois envois simultanés, une seule
  entrée ; l'entrée du contrat en brouillon compte pour son occupation ;
- la sortie clôt l'entrée de l'occupation ; refusée tant que l'entrée est en
  saisie ; une seule ;
- réservation refusée après la fin prévue dépassée ; acceptée sur une autre
  ressource, avant l'occupation, après la sortie close ; refusée encore avec
  une sortie en saisie ;
- acceptée tant que la fin prévue n'est pas passée ; ni l'entrée en saisie, ni
  l'occupation annulée ne bloquent ;
- prolonger l'occupation passe, jusqu'à la réservation suivante (décision 3),
  et la rend à nouveau en cours ;
- réservations suivantes en conflit, listées ; raccourcir, confirmer, annuler
  passent, déplacer plus tard est refusé ; la sortie close vide la liste ;
- occupation de contrat : bureau non libéré, nouvelle réservation refusée ;
  le contrat qui prolonge sa propre occupation la lève ;
- le message de la base arrive à l'équipe ; la chronologie range par
  occupation et signale la non restituée.

## Justification

**Pourquoi un trigger plutôt qu'un index unique** pour l'entrée. Un index sur
une colonne générée ne voit pas la nature de la réservation (autre table) :
il laisserait passer l'entrée de l'occupation d'un contrat déjà entré en
brouillon. Il ferait aussi échouer la migration sur des doublons anciens, et
le DDL de MySQL n'est pas transactionnel. Le verrou de l'occupation donne la
même garantie contre le double envoi.

**Pourquoi l'entrée close, et pas en saisie**, pour bloquer : « effectué ».
Un brouillon peut être ouvert par erreur (client absent) ; il se retire, et
la tuile « états des lieux à terminer » le signale déjà.

**Pourquoi la sortie close** pour lever : un brouillon de sortie peut être
préparé à l'avance ; la clôture date la restitution et la fige.

## Alternatives écartées

- **Prolonger la réservation jusqu'à la sortie** : le piège — conflit avec la
  réservation suivante, que le trigger refuserait.
- **Poser une indisponibilité « non restituée »** : même conflit, et un état
  stocké à tenir à jour.
- **Refuser seulement avant maintenant** : voir § 5.
- **Une vérification dans le code** : contraire à la décision 3.
- **Un code d'erreur nouveau** : une dizaine de chemins d'écriture qui savent
  traduire `CA000` auraient remonté une erreur serveur.

## Conséquences

- Pas de migration de structure : `npm run db:migrer` (en production,
  `docker compose run --rm migrer`, `infra/serveur/README.md` § 4) rejoue
  `20-reservations.sql`, `80-etats-des-lieux.sql` et `85-restitution.sql`.
- **Avant la mise en ligne**, une entrée close sans sortie dont l'occupation
  est finie bloque sa ressource dès les règles posées. « Aujourd'hui » et le
  planning les listent ; requête de contrôle :
  `select id, resource_id from inspections where kind = 'entry' and status = 'closed' and deleted_at is null and inspection_unreturned_since(tenant_id, id) is not null;`
- Coût : la garde ne lit que les entrées sans sortie close de la ressource
  (index des sorties par entrée), à chaque écriture qui prend du temps.
- `CLAUDE.md` : pas de contradiction relevée ; la décision 3 est tenue, le
  code ne fait qu'afficher ce que la base refuserait ; le rouge
  `--statut-conflit` sert au seul cas anormal.

## Restes

- **Notification** quand une fin prévue passe sans sortie (cloche du lot 3,
  ADR 059, ou courriel au centre) : l'événement dépend du temps, pas d'une
  écriture — il demande une tâche planifiée. Le bandeau en tient lieu.
- **Espace client et page publique** : le calendrier des créneaux libres
  (moteur commun, `calendar-data.ts`) ne montre pas le blocage ; la base
  refuse avec le message du créneau pris. À reprendre avec le moteur des
  demandes sur plusieurs jours (lot 5, ADR 061).
- *À valider par le centre* : le blocage de toute la suite jusqu'à la sortie
  (et non jusqu'à « maintenant ») ; l'entrée en saisie qui ne bloque pas.
