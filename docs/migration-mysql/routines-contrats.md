# Routines SQL du module contrats (`src/db/regles/40-contrats.sql`)

Contrat : `conventions.md` §4.1. Rédigé **avant** le SQL ; les signatures
ci-dessous sont celles que le fichier implémente.

Tables du module : `contracts`, `contract_lines`, `contract_amendments`,
`contract_documents`, `contract_renewals`, `offer_requests`.

## 1. Routines et vues appelées depuis le TypeScript ou par un autre module

| Routine | Type | Rend | Appelée par |
|---|---|---|---|
| `contract_price_versions` | **VIEW** (colonnes : `tenant_id`, `contract_id`, `amendment_id`, `amendment_number`, `starts_on`, `ends_on`, `amount_cents`) | une ligne par version de prix de chaque contrat | `contrats/versions.ts`, `contrats/compte-queries.ts`, `facturation/lot-queries.ts` (`cross join lateral` → `join … on v.contract_id = contracts.id`), `indicateurs` |
| `contract_segments` | **VIEW** (colonnes : `tenant_id`, `contract_id`, `amendment_id`, `amendment_number`, `resource_id`, `starts_on`, `ends_on`) | une ligne par segment de ressource de chaque contrat | `contrats/versions.ts`, `contrats/compte-queries.ts`, `facturation/lot-queries.ts`, `indicateurs/queries.ts`, procédure d'occupation |
| `contract_earliest_end_on(p_contract_id char(36), p_notice_on date)` | FUNCTION `READS SQL DATA` | `date` : dernier jour possible du contrat si le préavis est donné ce jour-là (`NULL` si le contrat n'existe pas) | `contrats/avenants.db.test.ts` ; jumelle TypeScript : `earliestEndOn` (`reconduction.ts`) |
| `contract_version_lines_amount(p_tenant_id char(36), p_contract_id char(36), p_amendment_id char(36))` | FUNCTION `READS SQL DATA` | `int` : somme des lignes récurrentes vivantes d'une version, `NULL` sans ligne (`p_amendment_id` `NULL` : version initiale) | triggers du module ; jumelle TypeScript : `contractSchedule` (`echeancier.ts`) |
| `apply_contract_occupation(IN p_contract_id char(36))` | **PROCEDURE** | rien | triggers `contracts_after_*` et `contract_amendments_after_*` ; tests ; rejouable par un script de reprise |
| `backfill_contract_occupations(OUT p_skipped int)` | **PROCEDURE** | `p_skipped` : nombre de contrats laissés sans occupation (ressource déjà prise) | `contrats/occupation.db.test.ts` ; rejouable à la main |

Appel des procédures, dans la même transaction (même connexion) :

```ts
await tx.execute(sql`call apply_contract_occupation(${contractId})`)
await tx.execute(sql`call backfill_contract_occupations(@skipped)`)
const [rows] = await tx.execute(sql`select @skipped as skipped`)
```

Lecture d'une version de prix ou d'un segment (jointure, plus de `lateral`) :

```sql
select v.amount_cents
  from contract_price_versions as v
 where v.contract_id = ? and v.starts_on <= ?
 order by v.starts_on desc limit 1
```

### Écarts avec la signature PostgreSQL

| PostgreSQL | MySQL | Pourquoi |
|---|---|---|
| `contract_price_versions(p_contract_id uuid) RETURNS TABLE` | vue `contract_price_versions` filtrée par `contract_id` | fonction de table non portable ; une vue se joint en SQL comme l'ancien `cross join lateral`, sans réécrire les trois modules appelants. §4.1 point 3 demande du TypeScript : les requêtes des appelants sont des jointures SQL (liste de contrats, lot de facturation, indicateurs), la vue évite N requêtes |
| `contract_segments(c contracts) RETURNS TABLE` | vue `contract_segments` | idem |
| `apply_contract_occupation(c contracts) RETURNS void` | `PROCEDURE … (p_contract_id)` | pas de type ligne en MySQL ; elle **écrit** : une `FUNCTION` modifiante est refusée sous `log_bin` (erreur 1418) sans `SUPER` |
| `backfill_contract_occupations() RETURNS integer` | `PROCEDURE … (OUT p_skipped int)` | elle écrit (même raison) |
| `next_contract_reference() RETURNS text` (défaut de colonne) | disparue : trigger `contracts_before_insert` | MySQL n'accepte pas une fonction stockée comme défaut de colonne (voir 2.1) |
| `contract_amendment_assert_signable(a, c) RETURNS void` | `PROCEDURE` interne (paramètres scalaires) | pas de type ligne |
| `contract_billed_through(p_contract_id uuid)` | **définie par la facturation** (`50-facturation.sql`, elle lit `invoice_lines`) ; le trigger d'avenant l'appelle | voir `routines-facturation.md` |

## 2. Comportements à connaître

### 2.1 Référence automatique d'un contrat

`contracts.reference` a pour valeur par défaut la chaîne repère `'@auto'`
(`CONTRACT_REFERENCE_AUTO`, `schema.ts`). Le trigger `contracts_before_insert`
la remplace par `next_document_number('contract')`, en sautant les numéros déjà
portés par un contrat du centre (archivé compris). Omettre la colonne (ou
`undefined` côté Drizzle) donne donc un numéro ; **la chaîne vide reste
refusée** (`contracts_reference_not_blank`, `23514`). Même résultat que le
défaut `next_contract_reference()` de PostgreSQL.

### 2.2 `LEAST` / `GREATEST` et `NULL`

PostgreSQL ignore les `NULL` dans `least` et `greatest` ; **MySQL rend `NULL`**
dès qu'un argument l'est. Le dernier jour d'un contrat s'écrit donc :

```sql
case when ends_on is null then terminated_on
     when terminated_on is null then ends_on
     else least(ends_on, terminated_on) end
```

(`coalesce(least(a, b), 'infinity')` de PostgreSQL devient `coalesce(<ci-dessus>, '9999-12-31')`.)
Les appelants SQL de la facturation et des indicateurs sont concernés.

### 2.3 Dates et instants

- Une colonne `date` lue par un `select` brut (`tx.execute`) arrive en `Date`
  JavaScript : écrire ``cast(col as char)`` (ou `date_format`) pour obtenir
  `AAAA-MM-JJ`. Par le query builder Drizzle (`mode: 'string'`), rien à faire.
- L'occupation d'un contrat va de minuit du centre au premier jour à minuit du
  lendemain du dernier jour : conversion par `CONVERT_TZ` (**tables de fuseaux
  MySQL chargées**, comme `next_document_number`). Sinon la procédure lève
  « Fuseaux horaires MySQL non chargés » plutôt que de dater faux.
- `commitment_ends_on` (colonne générée, `stored`) :
  `date_sub(date_add(starts_on, interval n month), interval 1 day)` ; comme
  PostgreSQL, le jour est ramené à la fin du mois (31 jan + 1 mois = 28 fév).

### 2.4 `now()` n'est plus celui de la transaction

`CURRENT_TIMESTAMP(3)` est l'instant du **début de l'instruction**. L'archivage
d'un contrat et de ses souscriptions « au même instant » se fait donc en
recopiant `contracts.deleted_at` (`archiveContractSubscriptions`).

### 2.5 Empreinte d'un document de contrat

`sha256 = SHA2(CAST(snapshot AS CHAR CHARACTER SET utf8mb4), 256)`. La forme
canonique du `json` de MySQL (clés triées par longueur puis ordre, espaces
après `:` et `,`) remplace celle de `jsonb::text` : les empreintes ne sont pas
comparables à celles de PostgreSQL (base neuve, sans effet). Vérification côté
requête : ``sha2(cast(snapshot as char character set utf8mb4), 256) = sha256``.

## 3. Variables de session

| Variable | Posée par | Lue par |
|---|---|---|
| `@app_contract_occupation_sync` | `apply_contract_occupation` : `'on'` pendant l'écriture des occupations, **remise à `NULL`** ensuite (y compris sur erreur, `EXIT HANDLER`) | triggers `bookings_before_*` (réservations, `CA001`) |
| `@app_anonymization` | routines `anonymize_*` (rgpd) | `offer_requests_before_insert` / `_update` : laisse passer l'effacement du motif |
| `@app_client_ids`, `@app_tenant_id` | `withClientScope()`, `withTenant()` | gardes d'écriture sous portée client |

## 4. Triggers (non appelés depuis le code, listés pour mémoire)

Un trigger MySQL ne porte qu'un événement ; les triggers d'origine sont éclatés
par événement. Les triggers `updated_at` et `<table>_guard_tenant_*` sont posés
par le migrateur.

| Trigger | Table | Règle d'origine |
|---|---|---|
| `contracts_before_insert` | `contracts` | référence automatique (0026/0027) ; portée client |
| `contracts_before_update` | `contracts` | `contracts_guard_version` (0031) : prix et engagement figés hors brouillon (`CA004`), montant d'un brouillon égal à la somme de ses lignes, date de début figée avec des avenants signés ; portée client |
| `contracts_after_insert` / `_after_update` | `contracts` | `contracts_sync_occupation` (0026) : occupation alignée sur le contrat (`CA000` si la ressource est prise) |
| `contract_lines_before_insert` / `_update` | `contract_lines` | `contract_lines_guard` (0031) : seules les lignes d'un brouillon s'écrivent (`CA004`), ni contrat ni avenant ne changent ; portée client |
| `contract_lines_before_delete` | `contract_lines` | pas de suppression (`CA004` ; remplace `REVOKE DELETE`) |
| `contract_lines_after_insert` / `_update` | `contract_lines` | `contract_lines_sync_amount` (0031) : le montant de la version suit ses lignes |
| `contract_amendments_before_insert` / `_update` | `contract_amendments` | `contract_amendments_guard` (0031/0032) : numéro attribué (`CA005` contrat pas en cours), avenant signé figé (`CA004`), signature vérifiée (`CA005`, dont période déjà facturée), montant suit les lignes ; portée client |
| `contract_amendments_before_delete` | `contract_amendments` | pas de suppression (`CA004`) |
| `contract_amendments_after_insert` / `_update` | `contract_amendments` | `contract_amendments_sync_occupation` (0031) : occupation par segments à la signature d'un avenant de ressource |
| `contract_documents_before_insert` | `contract_documents` | `contract_documents_guard` (0031) : version attribuée sous verrou du contrat, empreinte SHA-256, date ; portée client |
| `contract_documents_before_update` / `_delete` | `contract_documents` | un document remis ne se réécrit pas (`CA004`) |
| `contract_renewals_before_insert` | `contract_renewals` | journal du seul back-office : refusé sous portée client (`CA015`) |
| `contract_renewals_before_update` / `_delete` | `contract_renewals` | journal en ajout seul : `42501` (remplace `REVOKE UPDATE, DELETE`) |
| `offer_requests_before_insert` / `_update` / `_delete` | `offer_requests` | `offer_requests_guard` (0044, `CA013`) ; portée client |

Les politiques RLS d'origine (`*_client_scope`, `WITH CHECK`) deviennent des
gardes d'écriture `FIND_IN_SET(client_id, @app_client_ids)` : refus `CA015`
(`DB_CLIENT_SCOPE_REFUSED`, proposition commune avec `routines-facturation.md`).
**Les lectures sont filtrées par les requêtes** (voir `compte-queries.ts`).

## 5. Limites MySQL

- `MESSAGE_TEXT` d'un `SIGNAL` tient en 128 caractères : les messages longs
  sont abrégés, les **codes** `CAnnn` sont inchangés.
- `backfill_contract_occupations` : un contrat dont l'occupation échoue au
  milieu (annulations faites, réécriture refusée) peut garder ces annulations —
  pas de sous-transaction par contrat comme en PostgreSQL. Rejouer la procédure
  une fois le conflit levé rétablit l'état.

## 6. Pour qui lit ou teste ces routines

- **Fuseaux horaires** : `apply_contract_occupation` et `next_document_number`
  utilisent `CONVERT_TZ` avec un nom de fuseau (`Europe/Paris`). Les tables de
  fuseaux de MySQL doivent être chargées (`mysql_tzinfo_to_sql`) ; sans elles,
  l'activation d'un contrat avec ressource lève « Fuseaux horaires MySQL non
  chargés ».
- **Lectures brutes** : un `tx.execute(sql`select …`)` rend les `datetime` et
  `date` en **chaîne** (`2026-02-28 23:00:00.000`, en UTC), pas en `Date` ;
  les `tinyint(1)` en 0/1. Écrire ``cast(col as char)`` pour une `date`, et
  convertir soi-même (`new Date(`${s.replace(' ', 'T')}Z`)`) pour un instant.
- **`last_value`** est un mot réservé de MySQL 8 (fonction de fenêtre) : entre
  accents graves dans tout SQL écrit à la main sur `document_sequences`.
