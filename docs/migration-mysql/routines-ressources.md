# Routines SQL du module ressources

Fichier de règles : `src/db/regles/10-ressources.sql`.

| Routine | Type | Appelée par |
|---|---|---|
| *(aucune)* | | |

Le module n'appelle aucune routine SQL depuis le TypeScript, et n'en avait pas
sous PostgreSQL. Ce que les migrations 0001-0028 posaient sur `resources`,
`opening_hours`, `closures` et `listings` est porté ainsi :

| PostgreSQL | MySQL |
|---|---|
| index unique partiel `resources_tenant_code_key` (`deleted_at is null`) | index unique `(tenant_id, code, live)` ; `live` colonne générée |
| index unique `resources_tenant_locker_numero_key` (`lower(attributes ->> 'numero')`, casier vivant) | colonne générée `locker_numero_key`, index unique `(tenant_id, locker_numero_key)` |
| index unique `opening_hours_slot_key` avec `coalesce(resource_id, 0000…)` | colonne générée `resource_key`, index unique |
| index unique partiel `listings_tenant_slug_key` | index unique `(tenant_id, slug, live)` |
| politiques RLS, `set_updated_at` | supprimées / générées par le migrateur |
| horaires 9h-18h lun-ven posés par la migration 0011 | `INSERT … WHERE NOT EXISTS` dans `10-ressources.sql` |

Le réglage `resources.client_booking_mode` est **appliqué par un trigger du
module réservations** (`bookings_apply_client_booking_mode`, code `CA009`) : il
n'est pas dans ce fichier.
