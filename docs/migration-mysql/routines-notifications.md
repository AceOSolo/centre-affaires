# Routines SQL du module notifications

Fichier de règles : `src/db/regles/70-notifications.sql`. Contrat : voir
`conventions.md` §4.1.

## Routines appelées depuis le TypeScript ou les tests

| Routine | Type | Appelée par |
|---|---|---|
| `purge_expired_notification_deliveries(OUT p_count int)` | PROCEDURE (`SQL SECURITY DEFINER`) | `modules/notifications/queries.ts` (`purgeExpiredNotificationDeliveries(tx)`, lui-même appelé par `modules/rgpd/tache-de-nuit.ts`) |
| `notification_event_audience(p_event varchar(64)) → varchar(16)` | FUNCTION (`DETERMINISTIC NO SQL`) | trigger `notification_deliveries_before_*` ; `notifications.db.test.ts` (parité avec `notificationEventAudience`) |
| `notification_event_category(p_event varchar(64)) → varchar(16)` (`NULL` : pas de renoncement possible) | FUNCTION (`DETERMINISTIC NO SQL`) | `notifications.db.test.ts` (parité avec `notificationEventCategory`) |
| `notification_event_unknown(p_event varchar(64)) → varchar(16)` | FUNCTION | les deux précédentes (lève l'erreur d'un événement non classé) |

### `purge_expired_notification_deliveries`

Purge du journal des envois du centre courant (`@app_tenant_id`) au terme de
`tenants.notification_log_retention_months`, comptée depuis `sent_at`. Seule
porte d'effacement du journal (voir « Journal en ajout seul »).

Appel, dans la transaction de `withTenant()` (même connexion) :

```ts
await tx.execute(sql`call purge_expired_notification_deliveries(@purged)`)
const [rows] = await tx.execute(sql`select @purged as purged`)
```

**Écart avec PostgreSQL** : c'était une fonction qui rendait un entier. Elle
écrit ; avec la journalisation binaire de MySQL 8, une `FUNCTION` qui modifie
des données est refusée à la création (erreur 1418) sans
`log_bin_trust_function_creators`. Même choix que
`anonymize_expired_public_requests` (réservations) : `PROCEDURE` à paramètre
`OUT`. La signature TypeScript `purgeExpiredNotificationDeliveries(tx) →
Promise<number>` ne change pas.

## Journal en ajout seul : ce qui remplace `REVOKE UPDATE, DELETE`

PostgreSQL retirait `UPDATE`/`DELETE` au rôle applicatif ; MySQL n'a pas de
rôle séparé du propriétaire dans les tests, et une routine `DEFINER` doit
pouvoir écrire. Ce sont donc des **triggers** qui refusent, avec l'erreur
`1142` (normalisée `42501` par `dbErrorCode`, `DB_INSUFFICIENT_PRIVILEGE`) :

| Table | Refus |
|---|---|
| `notification_deliveries` | `UPDATE` et `DELETE`, sauf si une variable de session de la liste ci-dessous est posée |
| `notification_templates` | `DELETE` (même exception) ; `INSERT`/`UPDATE` sous portée client |
| `notification_preferences` | `DELETE` (même exception) ; `INSERT`/`UPDATE` hors des entreprises de la portée client |

Variables de session qui lèvent le verrou, **posées par la routine qui écrit
puis remises à `NULL`** :

| Variable | Posée par |
|---|---|
| `@app_notification_purge` | `purge_expired_notification_deliveries` |
| `@app_anonymization` (`'on'`) | `anonymize_client_rows` / `anonymize_member_rows` (module rgpd) : réécrivent `recipients`, `failed_recipients` et `subject` du journal d'un client anonymisé (`routines-rgpd.md`) |

## Contraintes qui deviennent des triggers ou changent de forme

| PostgreSQL | MySQL |
|---|---|
| `CHECK notification_deliveries_audience_matches` (appelle `notification_event_audience()`) | trigger `notification_deliveries_before_insert`/`_update` : `SIGNAL` avec l'erreur 3819 (`23514`, `DB_CHECK_VIOLATION`), message `Check constraint 'notification_deliveries_audience_matches' is violated.` — MySQL n'accepte pas de fonction stockée dans un `CHECK` |
| `CHECK notification_deliveries_status_consistent` (`<@`, `cardinality`) | `CHECK` avec `JSON_CONTAINS`, `JSON_LENGTH` (colonnes `recipients`, `failed_recipients` en `json`) |
| politiques RLS restrictives (portée client) | triggers `BEFORE INSERT/UPDATE` : écriture sous portée limitée à `audience = 'client'` et aux entreprises de `@app_client_ids`, erreur 1142 (`42501`, comme la violation de politique) ; **les lectures ne sont plus filtrées par la base** (voir `conventions.md` §6) |

Limite : `MESSAGE_TEXT` d'un `SIGNAL` tient en 128 caractères.
