# Routines SQL du module courrier (`src/db/regles/60-courrier.sql`)

Contrat §4.1 des conventions. Seules les routines **appelées depuis le
TypeScript ou depuis le SQL d'un autre module** sont listées ; les triggers sont
décrits plus bas pour mémoire.

| Routine | Type | Appelée par |
|---|---|---|
| `purge_expired_mail_scan_views() → int` | FUNCTION (`SQL SECURITY DEFINER`, écrit) | `src/modules/courrier/conservation.ts` : `select purge_expired_mail_scan_views() as purged` ; centre = `@app_tenant_id` |
| `mail_request_service_code(p_kind varchar(20)) → varchar(40)` | FUNCTION `DETERMINISTIC NO SQL` | SQL de facturation (`invoice_lines_guard`, `50-facturation.sql`) : `scan` → `courrier.numerisation`, `forward` → `courrier.reexpedition`, sinon `NULL` |

Rien d'autre n'est exposé : `mail_item_adopt_requests()` n'existe plus comme
routine (la reprise est dans le trigger `mail_items_after_insert`), et
`current_client_ids()` / `current_tenant_id()` disparaissent (§4.1 point 4).

`purge_expired_mail_scan_views` **écrit** : sur un serveur qui journalise en
binaire, `CREATE FUNCTION` exige `log_bin_trust_function_creators = 1` (déjà
posé par `infra/serveur/compose.yml`).

## Triggers (portés des migrations 0019-0020, 0026, 0041)

| Trigger | Table | Règle |
|---|---|---|
| `mail_items_before_insert` | `mail_items` | portée client (42501) ; un pli inséré déjà retiré avec une demande ouverte naît `received` |
| `mail_items_after_insert` | `mail_items` | un pli inséré avec `opening_requested_at` reçoit sa demande `open_and_scan` (reprise) |
| `mail_items_before_update` | `mail_items` | portée client (42501) ; `CA008` : le résumé `status`/`opening_requested_*` n'est écrit que par la base ; le retrait remet le résumé à `received` |
| `mail_items_after_update` | `mail_items` | pli ouvert : demande d'ouverture faite ; pli retiré : demandes en cours refusées |
| `mail_requests_before_insert` / `_before_update` / `_before_delete` | `mail_requests` | `CA008` : naissance, transitions, dates posées par la base, portée client, jamais supprimée |
| `mail_requests_after_insert` / `_after_update` | `mail_requests` | le résumé du pli suit la demande d'ouverture en cours |
| `mail_scans_before_insert` / `_before_update` | `mail_scans` | portée client par le pli (42501) |
| `mail_scan_views_before_insert` | `mail_scan_views` | portée client par le pli de la numérisation (42501) |
| `mail_scan_views_before_update` / `_before_delete` | `mail_scan_views` | journal en ajout seul (42501, comme le droit retiré sous PostgreSQL) ; la purge échue passe par `@app_journal_purge` |

Les contrôles `CHECK` du schéma (`schema.ts`) restent des contraintes
déclaratives ; les index uniques partiels sont des colonnes générées
(`mail_requests.pending_live`, `mail_scans.live_key`).

## Drapeaux de session (remis à leur valeur précédente en sortie, y compris sur erreur)

| Variable | Posée par | Lue par |
|---|---|---|
| `@app_mail_request_sync` | les triggers du pli et de la demande (reprise, ouverture, retrait, résumé) | `mail_items_before_update`, `mail_requests_before_*`, `mail_requests_after_*` |
| `@app_anonymization` | routines `anonymize_*` du module rgpd | `mail_requests_before_insert` / `_update` |
| `@app_journal_purge` | `purge_expired_mail_scan_views()` | `mail_scan_views_before_delete` |

## Écarts avec PostgreSQL

- Un trigger MySQL ne peut pas écrire la table qui l'a déclenché. Le résumé du
  pli à son retrait est donc posé par le BEFORE UPDATE du pli (même résultat) ;
  un pli **inséré** déjà retiré avec une demande en cours ne produit pas de
  demande refusée d'office (cas de reprise de données seulement).
- Messages : `MESSAGE_TEXT` est limité à 128 caractères ; quelques messages sont
  abrégés, les codes `CAnnn` sont inchangés.
- Refus de portée client : 42501 (errno 1142 forcé dans le `SIGNAL`) ;
  `dbErrorCode()` rend `42501` comme avant.
