# ADR 018 — Occupation des ressources sous contrat, canal et contrat des réservations

**Date** : 2026-10-01
**Statut** : accepté

## Contexte

Un contrat désigne la ressource qu'il loue (`contracts.resource_id`) : le bureau
d'un locataire, la boîte aux lettres d'une entreprise domiciliée. Jusqu'ici, ce
lien ne bloquait rien.

- Le bureau loué paraissait libre dans le planning, la vue semaine et la page
  publique (R02).
- Deux contrats pouvaient louer le même bureau, et une salle louée au mois
  pouvait être réservée à l'heure (R04).
- La contrainte d'exclusion `bookings_no_overlap` (décision 3) ne voit que
  `bookings`. Les contrats lui échappent.

L'ADR 016 (décision D6) retient de matérialiser la période d'un contrat en
réservation. Cet ADR en fixe les règles.

Le cahier des charges demande aussi qu'une réservation porte son canal (client
ou accueil) et son contrat (R05). `client_id` existe depuis la migration 0023.

## Décision

### L'occupation d'un contrat est une ligne de `bookings`

Un contrat qui loue une ressource la fait occuper par **une** ligne de
`bookings` :

- `kind = 'contract'` (nouvelle valeur, à côté de `booking` et
  `unavailability`) ;
- `contract_id` et `client_id` du contrat ;
- `channel = 'staff'` ;
- `status = 'confirmed'` ;
- titre `Contrat <référence>`.

L'index unique partiel `bookings_contract_occupation_key` garantit une seule
occupation par contrat. Le trigger `contracts_sync_occupation` (`AFTER INSERT OR
UPDATE` sur `contracts`) la tient à jour à chaque écriture du contrat, par la
fonction `apply_contract_occupation(contracts)`. Celle-ci est idempotente : elle
ne réécrit la ligne que si elle diffère.

La contrainte d'exclusion existante protège alors tout, sans code
supplémentaire :

- un second contrat sur la même ressource ;
- une réservation horaire pendant un contrat ;
- l'activation d'un contrat sur un créneau déjà réservé.

Toute ressource désignée par un contrat est occupée en exclusivité. C'est
cohérent avec le catalogue (`infra/catalogue.mjs`) : une ressource correspond à
une chose réservable seule, et chaque boîte aux lettres est une ressource.

### Quand un contrat occupe sa ressource

Un contrat occupe sa ressource s'il remplit **toutes** ces conditions :

- il n'est pas archivé (`deleted_at` nul) ;
- il est `active` ou `terminated` ;
- il désigne une ressource ;
- son dernier jour n'est pas antérieur au premier.

Le dernier jour est le plus proche de `ends_on` et `terminated_on`.

| Événement sur le contrat | Effet sur l'occupation |
|---|---|
| Brouillon (`draft`) | Aucune occupation : un brouillon n'engage rien. |
| Activation | L'occupation est créée. Un chevauchement fait échouer l'activation elle-même (SQLSTATE `23P01`) : le contrat reste en brouillon. |
| Résiliation (contrat actif seulement) | L'occupation s'arrête au soir de `terminated_on`. La ressource est libre le lendemain, et la période passée reste occupée dans l'historique. |
| Résiliation antérieure au début, archivage, retrait de la ressource | L'occupation est annulée (`cancelled`, avec un motif). La ligne reste. |
| Désarchivage | L'occupation est rétablie. |
| Changement de ressource d'un contrat qui n'a pas commencé | L'occupation suit, sur toute la période. |
| Changement de dates ou de client (brouillon seulement) | Rien à suivre : un brouillon n'occupe rien. |

**Seul un contrat actif se résilie.** Le prédicat d'occupation retient
`terminated` : un brouillon résilié occuperait sa ressource de son premier jour
à la date de résiliation, alors qu'il n'a engagé personne. Un brouillon abandonné
s'archive ; un contrat archivé ou déjà résilié ne se résilie pas.
`terminateContract` filtre sur `status = 'active'` et `deleted_at` nul, et la
fiche n'offre la résiliation qu'à un contrat actif.

### Limite : la ressource ne change qu'avant le début du contrat

L'occupation couvre toute la période du contrat, depuis `starts_on`. Changer la
ressource d'un contrat commencé la réécrirait depuis le premier jour :

- l'ancienne ressource perdrait la période écoulée (planning passé faux,
  indicateurs R31 faussés) ;
- la nouvelle serait refusée (`23P01`) dès qu'elle a porté une réservation ou un
  contrat depuis ce premier jour, même passés, avec un message qui cite cette
  occupation ancienne.

En attendant les avenants (vague 2, R12), **le changement de ressource, retrait
compris, n'est accepté que pour un contrat actif dont le premier jour vient
après aujourd'hui, jour du centre** (`canChangeContractResource`, filtre de
`changeContractResource`, qui lève `ContractAlreadyStartedError`). Pour un
contrat commencé, la fiche ne propose pas le changement : on résilie le contrat,
puis on en crée un nouveau sur l'autre ressource. L'avenant permettra de changer
de bureau en cours de contrat en gardant la trace de l'ancien.

### Des jours civils du centre aux instants

Les dates d'un contrat sont des jours civils du centre, bornes comprises
(ADR 006). L'occupation est bornée en `[)` comme toute réservation :

- elle commence le premier jour à minuit, heure du centre ;
- elle finit le lendemain du dernier jour à minuit, heure du centre.

Le fuseau est celui du centre (`tenants.timezone`), jamais l'UTC. Par exemple,
un contrat du 1er mars au 30 juin à Paris occupe de `2026-02-28T23:00Z` (heure
d'hiver) à `2026-06-30T22:00Z` (heure d'été).

### Un contrat sans terme occupe jusqu'au 31/12/9999

Un contrat à durée indéterminée (`ends_on` nul, non résilié) occupe jusqu'à
`9999-12-31T00:00:00Z`. Cette valeur est donnée par :

- `booking_open_end()` côté SQL ;
- `OPEN_ENDED_BOOKING_END` et `isOpenEndedBooking()` côté TypeScript
  (`src/modules/reservations/schema.ts`).

Ce n'est pas `infinity` : le pilote lit les `timestamptz` en `Date`, et
`infinity` y deviendrait une `Invalid Date`. Tous les calculs de planning
échoueraient sans erreur visible. La borne lointaine reste un instant ordinaire.
Les calculs de géométrie la rognent déjà sur la fenêtre affichée. Les écrans
doivent l'afficher « sans terme », jamais « jusqu'au 31/12/9999 ».

### L'occupation ne s'écrit qu'à travers son contrat

Le trigger `bookings_guard_contract_occupation` refuse toute écriture directe
d'une ligne `kind = 'contract'` : création, modification, annulation,
suppression, ou transformation d'une réservation en occupation. Le refus porte
le SQLSTATE `CA001` (`PG_CONTRACT_OCCUPATION_LOCKED` dans
`src/db/errors.ts`).

Sans ce garde, annuler l'occupation depuis le planning libérerait un bureau
toujours loué, et un second contrat pourrait s'y activer. Seule
`apply_contract_occupation` peut l'écrire : elle pose le drapeau
`app.contract_occupation_sync` le temps de son écriture.

Ce garde protège des erreurs de l'application. Ce n'est pas une frontière de
sécurité : le rôle applicatif écrit dans `contracts`, et décide donc déjà de
l'occupation.

### Reprise des contrats existants : signaler, pas échouer

La migration 0026 pose l'occupation de tous les contrats actifs ou résiliés, du
plus ancien au plus récent, par `backfill_contract_occupations()`. Des données
peuvent déjà se contredire : deux contrats sur le même bureau, ou une
réservation horaire pendant un contrat. Dans ce cas, le contrat concerné est
**signalé par un `NOTICE`** et laissé sans occupation. La migration n'échoue
pas : ces données existaient avant elle, et c'est à l'équipe de trancher.

Après la mise en production, cette requête liste les contrats restés sans
occupation :

```sql
SELECT c.reference, c.id, c.resource_id
  FROM contracts c
 WHERE c.deleted_at IS NULL AND c.status IN ('active', 'terminated')
   AND c.resource_id IS NOT NULL
   AND coalesce(least(c.ends_on, c.terminated_on), c.starts_on) >= c.starts_on
   AND NOT EXISTS (SELECT 1 FROM bookings b
                    WHERE b.contract_id = c.id AND b.kind = 'contract'
                      AND b.status <> 'cancelled');
```

Pour résoudre un conflit, l'équipe peut :

- annuler la réservation en trop ;
- archiver le contrat en double ;
- ou, si le contrat n'a pas encore commencé, le faire passer sur une autre
  ressource (voir la limite plus haut).

Le propriétaire de la base relance ensuite `SELECT backfill_contract_occupations();`,
qui rend le nombre de contrats encore en conflit. Tant qu'un conflit n'est pas
résolu, toute écriture du contrat concerné échoue (`23P01`) : l'occupation est
recalculée à chaque écriture, et la base refuse d'enregistrer la contradiction.
Les seules écritures qui passent sont celles qui suppriment l'occupation,
comme l'archivage ou, avant le début du contrat, le retrait de la ressource.

### Le canal de la réservation (R05)

`bookings.channel`, de type énuméré `booking_channel`, est obligatoire et
**sans valeur par défaut** :

- `staff` : saisie par l'équipe (back-office, séries, indisponibilités,
  occupations de contrat) ;
- `client` : déposée par une personne connectée à son espace client ;
- `public` : demandée depuis la page publique, sans compte (ADR 005).

Chaque chemin d'écriture dit d'où il vient, et la base refuse une réservation
qui ne le dit pas. Une valeur par défaut aurait fait passer un chemin oublié pour
l'accueil.

| Chemin d'écriture | Canal |
|---|---|
| `createBooking` | `staff` |
| `insertBookingSeries` | `staff` |
| `createBookingRequest` | `client` si la demande est rattachée à une entreprise, `public` sinon |

La migration 0026 déduit le canal des lignes existantes à partir des colonnes
que chaque chemin remplissait :

- des coordonnées de demandeur et un client : `client` ;
- des coordonnées de demandeur sans client : `public` ;
- sinon : `staff`.

Une demande publique rattachée plus tard à un client par l'équipe est donc
comptée `client` : l'ancien schéma ne distinguait pas les deux cas.
`updated_at` n'est pas modifié par cette reprise.

### Le contrat de la réservation (R05)

`bookings.contract_id` est relié à `contracts` par une clé étrangère composite
`(tenant_id, contract_id)`. La contrainte d'unicité `contracts_tenant_id_id_key`
est ajoutée pour cela, si bien qu'une réservation ne peut pas viser le contrat
d'un autre centre.

- Pour une occupation, le contrat est obligatoire (contrainte
  `bookings_contract_kind_consistent`).
- Pour une réservation ordinaire, il est facultatif : par exemple, des heures de
  salle comprises dans un contrat de bureau.

La base ne vérifie pas que `client_id` et le client du contrat concordent sur
une réservation ordinaire. C'est à l'application de les poser ensemble.

## Justification

**Pourquoi une ligne de `bookings` plutôt qu'une union à la lecture.** La
contrainte d'exclusion ne porte que sur une table, et c'est elle qui garantit
l'absence de double location, quelle que soit la concurrence (décision 3). Une
union à la lecture devrait être répétée partout : planning jour, vue semaine,
page publique, contrôle des séries, message de conflit. Le jour où l'un des
écrans l'oublie, il propose un bureau loué, et rien n'empêche l'écriture.

**Pourquoi un trigger plutôt que le code.** Une activation, une résiliation ou
un archivage passe parfois par l'application, parfois par un script de reprise.
Le trigger aligne l'occupation dans la même transaction que le contrat, quel
que soit le chemin. Un échec annule les deux.

## Conséquences

- Les calendriers voient les occupations sans rien changer à leurs requêtes :
  `listBookingsBetween`, `listDayAvailability` et `loadWeekCalendar` les
  comptent comme occupées. Un bureau loué n'est plus proposé sur la page
  publique.
- Les écrans doivent reconnaître `kind === 'contract'` :
  - afficher « Occupé — contrat X », avec un lien vers le contrat ;
  - n'offrir ni annulation, ni déplacement, ni rattachement à un client ;
  - afficher « sans terme » pour `isOpenEndedBooking()`.

  Une tentative directe échoue avec `CA001`, qu'il faut traduire.
- L'activation d'un contrat peut désormais échouer en `23P01`.
  `activateContract` doit traduire cette erreur et nommer la réservation en
  conflit, comme `createBooking` le fait déjà.
- Google Agenda ignore les occupations (`calendarActionFor` ne traite que
  `kind = 'booking'`), et « Mes réservations » aussi (filtre sur
  `kind = 'booking'`).
- Les tests qui vident les tables le font en `TRUNCATE` par le propriétaire. Un
  `DELETE FROM bookings` sous `app_centre` échoue dès qu'une occupation existe.
- Les statistiques d'occupation (R31) comptent les lignes `kind = 'contract'`.

## Alternatives écartées

**Union des contrats et des réservations à la lecture.** Pour les raisons
données plus haut : chaque écran doit y penser, et la base ne protège rien.

**Une seconde contrainte d'exclusion sur `contracts`** (ressource, intervalle
de dates). Elle empêcherait deux contrats sur le même bureau, mais pas une
réservation horaire pendant un contrat : une contrainte ne couvre pas deux
tables.

**`infinity` pour un contrat sans terme.** Une `Invalid Date` côté Node, qui
fausse tous les calculs de planning sans erreur visible.

**Un horizon glissant** (occuper douze mois, prolongés chaque nuit). Il dépend
d'une tâche planifiée. Si elle s'arrête, le bureau paraît libre au bout d'un an,
sans que personne ne s'en aperçoive.

**Un nouveau statut plutôt qu'une nouvelle nature.** Le statut décrit le cycle
de vie (`pending`, `confirmed`, `cancelled`), et le prédicat de la contrainte
d'exclusion en dépend. Une occupation suit le même cycle : elle est confirmée,
puis annulée à l'archivage.

**Une valeur par défaut pour le canal.** Un chemin d'écriture oublié serait
classé `staff` sans que personne ne le voie.
