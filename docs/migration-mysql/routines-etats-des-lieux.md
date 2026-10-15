# Routines SQL du module états des lieux (`src/db/regles/80-etats-des-lieux.sql`)

| Routine | Type | Appelée par |
|---|---|---|
| `inspection_fields_error(p_fields json) → text` | FUNCTION `DETERMINISTIC NO SQL` | trigger `inspection_template_versions_before_insert` ; tests |
| `inspection_values_error(p_fields json, p_values json, p_complete tinyint) → text` | FUNCTION `DETERMINISTIC NO SQL` | triggers `inspections_before_insert` / `_update` ; tests |
| `mark_inspection_photo_purged(p_photo_id char(36)) → tinyint` | FUNCTION `SQL SECURITY DEFINER`, écrit | `src/modules/etats-des-lieux/conservation.ts` : `select mark_inspection_photo_purged(${id})` (1 = marquée) |
| `rekey_inspection_photo(p_photo_id char(36), p_from_version int, p_to_version int) → tinyint` | FUNCTION, écrit | `src/modules/etats-des-lieux/rechiffrement.ts` (1 = changée) |
| `purge_expired_inspection_photo_views() → int` | FUNCTION `SQL SECURITY DEFINER`, écrit | `src/modules/etats-des-lieux/conservation.ts` |

Les fonctions qui écrivent exigent `log_bin_trust_function_creators = 1` sur un
serveur qui journalise en binaire (déjà posé par `infra/serveur/compose.yml`).

Réécrites en TypeScript (contrat §4.1 point 3), donc **plus de routine** :

- `expired_inspection_photos(p_limit)` : `expiredInspectionPhotos()` dans
  `conservation.ts` (centre = contexte `withTenant`) ;
- `inspection_photo_retention_start(i)` : l'expression `retentionStart` de cette
  même requête ;
- `inspection_condition_levels()` : constante `inspectionConditionLevels`
  (schema.ts) ; la validation SQL porte l'échelle en dur.

## Validation « valeur conforme au modèle » (CA011)

Faite **en SQL**, avec les types JSON de MySQL (`JSON_TYPE`, `JSON_EXTRACT`,
`JSON_KEYS`, `JSON_CONTAINS`, `JSON_TABLE`) : le modèle est un tableau JSON, la
validation une boucle `WHILE` dans une fonction. `CHECK` n'accepte pas de
routine stockée : la validation des champs d'une version est donc portée par le
trigger `inspection_template_versions_before_insert` (plus par un `check`, le
code d'erreur devient `CA011` au lieu de `23514`). Comparaisons de chaînes
**binaires** (la collation ignore la casse, pas la règle). Messages identiques à
PostgreSQL ; ils sont tronqués à 128 caractères dans le `SIGNAL` des triggers
(l'écran dit le message complet par `champs.ts`, dont
`etats-des-lieux-ecrans.db.test.ts` éprouve l'accord avec les fonctions SQL).

## Triggers (portés des migrations 0039, 0042, 0044)

| Trigger | Table | Règle |
|---|---|---|
| `inspection_templates_before_insert` / `_before_update` | `inspection_templates` | écriture au back-office seul (42501 sous portée client) |
| `inspection_template_versions_before_insert` | `…_versions` | back-office seul ; `fields` valide (`CA011`) |
| `inspection_template_versions_before_update` / `_before_delete` | `…_versions` | version figée (42501, comme le droit retiré) |
| `inspections_before_insert` / `_before_update` / `_before_delete` | `inspections` | `CA010` figé / `CA011` non conforme ; clôture ; validation du client ; portée client (états clos de l'entreprise) |
| `inspection_photos_before_insert` / `_before_update` / `_before_delete` | `inspection_photos` | `CA010` / `CA011`, purge et rechiffrement par drapeau |
| `inspection_photo_views_before_insert` | `inspection_photo_views` | portée client par la photo (42501) |
| `inspection_photo_views_before_update` / `_before_delete` | `inspection_photo_views` | journal en ajout seul ; purge échue par `@app_journal_purge` |

## Drapeaux de session (remis à leur valeur précédente en sortie, y compris sur erreur)

| Variable | Posée par | Lue par |
|---|---|---|
| `@app_anonymization` | routines `anonymize_*` du module rgpd | `inspections_before_insert` / `_update` |
| `@app_inspection_photo_purge` | `mark_inspection_photo_purged()` | `inspection_photos_before_*` |
| `@app_inspection_photo_rekey` | `rekey_inspection_photo()` | `inspection_photos_before_*` |
| `@app_journal_purge` | `purge_expired_inspection_photo_views()` | `inspection_photo_views_before_delete` |

## Écarts avec PostgreSQL

- Sous portée client, une **mise à jour** d'un état des lieux qui n'est pas clos
  et vivant de l'entreprise est **refusée** (42501) ; PostgreSQL l'ignorait
  silencieusement (ligne invisible). Les lectures n'étant plus filtrées par la
  base, `queries.ts` filtre explicitement (`loadDetail` filtre aussi l'entrée et
  la sortie liées : un brouillon de sortie reste invisible du client).
- Messages abrégés à 128 caractères (codes inchangés).
