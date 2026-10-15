# Routines SQL du module réservations

Fichier de règles : `src/db/regles/20-reservations.sql`. Contrat : voir
`conventions.md` §4.1.

## Routines appelées depuis le TypeScript ou par un autre module

| Routine | Type | Appelée par |
|---|---|---|
| `booking_open_end()` → `datetime(3)` (`9999-12-31 00:00:00.000`) | FUNCTION (`DETERMINISTIC NO SQL`) | routine d'occupation de contrat (module contrats), `contrats/occupation.db.test.ts` |
| `anonymize_expired_public_requests(OUT p_count int)` | PROCEDURE | `modules/reservations/conservation.ts` (`anonymizeExpiredPublicRequests(tx)`, lui-même appelé par `modules/rgpd/tache-de-nuit.ts`) |

Appel de la procédure : `call anonymize_expired_public_requests(@n)` puis
`select @n`, dans la même transaction (même connexion).

Pourquoi une `PROCEDURE` et non une `FUNCTION` pour un entier ? La routine
**écrit** (`UPDATE bookings`). Avec la journalisation binaire de MySQL 8 active
par défaut, `CREATE FUNCTION` d'une fonction qui modifie des données est refusé
(erreur 1418) sans `SUPER` ni `log_bin_trust_function_creators`. Une procédure
n'a pas cette restriction. Écart assumé par rapport à §4.1 point 1 ; le seul
appelant est `conservation.ts`, qui garde sa signature TypeScript.

## Routines supprimées ou réécrites en TypeScript

| PostgreSQL | MySQL |
|---|---|
| `booking_busy_ranges(from, to, resource_ids)` | réécrite en TypeScript : `listBusyRanges(tx, from, to, resourceIds?)` dans `modules/reservations/creneaux-occupes.ts`. Elle ne sélectionne que `resource_id`, `starts_at`, `ends_at`. Choix : une requête TS suffit (plus de RLS à contourner, la base ne filtre plus les lectures), ce qui évite une procédure à jeu de résultats. Les appelants hors module (`src/db/portee-client.db.test.ts`) doivent l'importer. |
| `current_tenant_id()`, `current_client_ids()` | disparues (`@app_tenant_id`, `@app_client_ids`) |
| `bookings_no_overlap` (EXCLUDE gist) | triggers `bookings_before_insert` / `bookings_before_update` (décision 3) |

## Variable de session lue par le module

| Variable | Posée par | Effet |
|---|---|---|
| `@app_contract_occupation_sync` | la routine d'occupation de contrat (module contrats) : `'on'` pendant son écriture, **remise à `NULL`** ensuite (y compris sur erreur) | tant qu'elle vaut `'on'`, le garde `CA001` laisse écrire une ligne `kind = 'contract'` |

## Triggers (non appelés depuis le code, listés pour mémoire)

Un trigger MySQL ne porte qu'un événement ; les triggers d'origine sont donc
regroupés en un par événement, dans l'**ordre d'exécution de PostgreSQL** :

- `bookings_before_insert` : garde d'occupation de contrat (CA001), mode de
  réservation du portail (CA009, pose le statut), garde de l'espace client
  (CA009), portée client, datation de la confirmation, puis anti-chevauchement
  (CA000, verrou de la ressource).
- `bookings_before_update` : idem, plus le garde du devis facturé (CA002).
- `bookings_before_delete` : garde d'occupation de contrat (CA001), portée client.

Anti-chevauchement : `SELECT COUNT(*) … FOR UPDATE` sur la ressource (verrou
d'exclusion mutuelle), puis `SELECT COUNT(*)` **sans** verrou de ligne sur les
réservations qui chevauchent (écart avec conventions §4, voulu) : sous
`READ COMMITTED`, la lecture voit tout ce qui est validé, et tout écrivain
passe par le verrou de la ressource. Verrouiller aussi les réservations
inverserait l'ordre des verrous d'un `UPDATE` (réservation puis ressource) et
provoquerait des interblocages.

Limite MySQL : `MESSAGE_TEXT` d'un `SIGNAL` tient en 128 caractères ; les
messages trop longs de PostgreSQL sont abrégés, les **codes** `CAnnn` sont
inchangés.
