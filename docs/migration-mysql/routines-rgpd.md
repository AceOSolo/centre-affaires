# Routines SQL du module rgpd (anonymisation, ADR 040 et 041)

Fichier de règles : `src/db/regles/90-rgpd.sql`. Contrat : `conventions.md`
§4.1. Rédigé **avant** le SQL ; porte le contenu des migrations 0043 et 0044
(état final : signatures à quatre arguments de la 0044).

Rappels MySQL qui touchent les appelants :

- **Pas de paramètre par défaut, pas de cast** : `select anonymize_client(${id},
  ${staffId}, 'relationship_ended', null)` — chaînes telles quelles pour
  l'énumération `anonymization_basis`, `null` ou `'AAAA-MM-JJ'` pour la date.
- Appel toujours ``select f(…)`` **sans `FROM`**.
- Les routines qui écrivent sont des `FUNCTION … DETERMINISTIC MODIFIES SQL
  DATA` (`DETERMINISTIC` n'est pas vrai ; il évite l'erreur 1418 sous
  `log_bin`, comme `next_document_number`) et rendent un entier (`1` pour
  « rien » : MySQL n'a pas de `FUNCTION … RETURNS void`).
- `SQL SECURITY DEFINER` : elles s'exécutent avec les droits de leur créateur.
- `MESSAGE_TEXT` d'un `SIGNAL` : 128 caractères, préfixe `CAnnn: ` compris.
  Le message d'un refus qui énumère des exclusions est donc **abrégé** : le
  code TypeScript (`rgpd/anonymisation.ts`) relit les exclusions complètes par
  `client_anonymization_blockers()` pour l'afficher.
- **Fuseaux horaires** : `client_last_activity_on` et les durées de
  conservation calculent le « jour du centre » : les tables de fuseaux de
  MySQL doivent être chargées (`mysql_tzinfo_to_sql`). Sans elles,
  `rgpd_local_date` n'a de repli que pour `Europe/Paris` (règle européenne du
  changement d'heure) et lève une erreur claire pour tout autre fuseau.

## 1. Routines appelées depuis le TypeScript ou par un autre module

| Routine | Type | Rend | Appelée par |
|---|---|---|---|
| `anonymize_client(p_client_id char(36), p_staff_member_id char(36), p_basis varchar(32), p_erasure_requested_on date)` | FUNCTION `DEFINER` | `int` (1) ; refus `CA012` | `rgpd/anonymisation.ts` (`anonymizeClientOnRequest`), tests facturation (`comptabilite-anonymisation`, `offres-portail`), clients, rgpd |
| `anonymize_client_member(p_member_id char(36), p_staff_member_id char(36), p_basis varchar(32), p_erasure_requested_on date)` | FUNCTION `DEFINER` | `int` (1) ; refus `CA012` | `rgpd/anonymisation.ts` (`anonymizeClientMemberOnRequest`) |
| `anonymize_staff_member(p_staff_member_id char(36), p_by char(36), p_basis varchar(32), p_erasure_requested_on date)` | FUNCTION `DEFINER` | `int` (1) ; refus `CA012` | `rgpd/anonymisation.ts` (`anonymizeStaffMemberOnRequest`) |
| `anonymize_expired_clients()` | FUNCTION `DEFINER` | `int` : entreprises anonymisées | `rgpd/anonymisation.ts` (`anonymizeExpiredClients`), puis `rgpd/tache-de-nuit.ts`, route `src/app/api/maintenance/conservation` (via `runNightlyConservation`) |
| `anonymize_removed_members()` | FUNCTION `DEFINER` | `int` : membres (accès clients + équipe) anonymisés | idem (`anonymizeRemovedMembers`) |
| `client_last_activity_on(p_client_id char(36))` | FUNCTION `READS SQL DATA` | `date` (jour du centre) ou `NULL` si client inconnu du centre | `rgpd/anonymisation.ts` (`readClientRetention`, `readAnonymizationOutlook`) |
| `client_anonymization_blockers(p_client_id char(36))` | FUNCTION `READS SQL DATA` | `json` : tableau de phrases (`[]` : rien ne l'empêche), `NULL` si client inconnu | `rgpd/anonymisation.ts`, `facturation/offres-portail.db.test.ts` |
| `rgpd_local_date(p_instant datetime(3), p_timezone varchar(64))` | FUNCTION `READS SQL DATA` | `date` : le jour de l'instant (UTC) dans le fuseau | `rgpd/anonymisation.ts` (`readAnonymizationOutlook`) ; utilisable par d'autres modules |

Routines **internes** (jamais appelées depuis le code) :
`anonymization_request_check(p_by, p_basis, p_erasure_requested_on)`,
`anonymize_client_rows(p_client_id, p_by, p_basis, p_erasure_requested_on)`,
`anonymize_member_rows(p_table, p_id, p_by, p_basis, p_erasure_requested_on)`.

Routine **appelée mais définie ailleurs** : `derive_accounting_code(p_name)`
(`50-facturation.sql`, `routines-facturation.md`), par `anonymize_client_rows`.
Le fichier `90-rgpd.sql` passe après les autres (`NN` = 90), donc elle existe.

Pour la **route de maintenance** (`src/app/api/maintenance/conservation`,
agent « app ») : elle n'appelle aucune routine SQL directement ; elle appelle
`runNightlyConservation(tenantId, removeObject)` (`rgpd/tache-de-nuit.ts`),
dont l'interface n'a pas changé.

## 2. Variable de session

| Variable | Posée par | Lue par |
|---|---|---|
| `@app_anonymization` (`'on'`, sinon `NULL`) | `anonymize_client_rows`, `anonymize_member_rows` — **remise à sa valeur précédente (`NULL`) en sortie, y compris sur erreur** (`EXIT HANDLER`) | `*_guard_anonymized_*` (clients, client_contacts, client_members, staff_members) ; `mail_requests_guard_*` (courrier), `inspections_guard_*` (états des lieux), `offer_requests_guard` (contrats/facturation), `notification_deliveries` (notifications) : test `COALESCE(@app_anonymization, '') = 'on'` |

Le code TypeScript ne pose **jamais** cette variable.

## 3. Triggers (refus d'écriture sur lignes anonymisées, `CA012`)

| Trigger | Table | Règle |
|---|---|---|
| `clients_guard_anonymized_insert` / `_update` | `clients` | `anonymized_at` n'est posé que par les routines ; une ligne anonymisée ne change plus |
| `client_contacts_guard_anonymized_insert` / `_update` | `client_contacts` | idem |
| `client_members_guard_anonymized_insert` / `_update` | `client_members` | idem |
| `staff_members_guard_anonymized_insert` / `_update` | `staff_members` | idem (posé ici, table de `src/db/staff.ts`) |

La comparaison « la ligne n'a pas changé hors `updated_at` » se fait colonne
par colonne (`<=>`, égalité nulle-sûre) : MySQL n'a pas `to_jsonb(NEW)`. Une
colonne ajoutée à l'une de ces quatre tables **doit** l'être aussi dans son
trigger `_update` (le test d'anonymisation modifie chaque colonne pour le
vérifier).

## 4. Écarts de comportement

- `greatest()`/`least()` de MySQL rendent `NULL` dès qu'un argument l'est
  (PostgreSQL les ignorait) : réécrits avec `coalesce` (voir le fichier).
- `now()` de PostgreSQL est constant dans la transaction ; `CURRENT_TIMESTAMP`
  de MySQL l'est par instruction. Conséquence : le code TS ne retrouve plus
  les lignes d'un passage par `anonymized_at = now()` ; il compte par
  différence avant/après (`countAnonymized`).
- Le conseil (`HINT`) du refus n'existe plus côté base ; il est ajouté par
  `refusalMessage()`.
- `notification_deliveries.recipients` / `failed_recipients` : tableaux JSON
  (convention §3, `routines-notifications.md`) ; `array_fill` est remplacé par
  une reconstruction JSON de même longueur.
