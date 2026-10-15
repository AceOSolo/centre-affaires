# Routines SQL du module facturation (structure et règles)

Fichier de règles : `src/db/regles/50-facturation.sql`. Contrat : voir
`conventions.md` §4.1. Éprouvé contre MySQL 8.4 (les neuf `*.db.test.ts` de
la partie « structure et règles » passent).

Tables du module : `rate_plans`, `rate_plan_items`, `services`, `offers`,
`offer_items`, `subscribed_services`, `invoice_runs`, `sepa_mandates`,
`invoices`, `invoice_lines`, `payments`, `invoice_reminders`,
`accounting_accounts`, `accounting_exports`.

Rappels MySQL qui touchent les appelants :

- **Pas de paramètre par défaut.** `issue_invoice(id)` à un argument n'existe
  plus : toujours `issue_invoice(id, NULL)` ou `issue_invoice(id, staffId)`.
  Même chose pour `line_net_amount_cents` (six arguments, `NULL` pour les
  absents).
- **Pas de cast `::uuid`, `::text`, `::int`, `::invoice_kind`.** Passer les
  valeurs telles quelles (chaînes pour les énumérations).
- Une fonction qui rend une `date` donne un `Date` JavaScript côté mysql2 :
  écrire ``cast(f(…) as char)`` pour obtenir `AAAA-MM-JJ`.
- Les routines qui écrivent sont des `FUNCTION … DETERMINISTIC MODIFIES SQL DATA` :
  `DETERMINISTIC` n'est pas vrai, il évite l'erreur 1418 sous `log_bin`.
  Appel : toujours ``select f(…)`` **sans** `FROM` (jamais
  `select f(x) from invoices`).
- `execute(sql…)` rend `[lignes, champs]` : ``const [rows] = await tx.execute(…)``.
- **Fuseaux horaires** : `issue_invoice` calcule le jour du centre par
  `CONVERT_TZ` ; les tables de fuseaux de MySQL doivent être chargées
  (`mysql_tzinfo_to_sql`), comme pour `next_document_number`.

## 1. Routines appelées depuis le TypeScript ou par un autre module

| Routine | Type | Rend | Appelée par |
|---|---|---|---|
| `issue_invoice(p_invoice_id char(36), p_issued_by char(36))` | FUNCTION | `varchar(32)` : le numéro (`FA-2026-0001`, `AV-…`) | `factures-queries.ts` (`issueInvoice`), tests de facturation, clients, indicateurs, notifications, rgpd |
| `draft_credit_note(p_id char(36), p_invoice_id char(36), p_reason text)` | **PROCEDURE** | rien : le brouillon d'avoir **a pour identifiant `p_id`** (fourni par l'appelant, `uuidv7()`) | `factures-queries.ts` (deux appels), tests |
| `invoice_refresh_amounts(p_invoice_id char(36))` | FUNCTION | `int` (0) | **nouveau pour le TS** : voir §2 |
| `contract_billed_through(p_contract_id char(36))` | FUNCTION `READS SQL DATA` | `date` ou `NULL` : dernier jour facturé du contrat | `modules/contrats/versions.ts`, `contrats/avenants.db.test.ts` ; **définie dans `50-facturation.sql`** (elle lit `invoice_lines`) ; le trigger d'avenant (contrats) l'appelle |
| `line_net_amount_cents(p_quantity int, p_unit_price_cents int, p_discount_bp int, p_discount_cents int, p_prorata_numerator int, p_prorata_denominator int)` | FUNCTION `DETERMINISTIC` | `int` | `montants.db.test.ts` (jumeau de `lineNetAmountCents`), triggers de lignes. Les colonnes générées n'appellent **pas** la fonction : leur expression est écrite en ligne (`lineNetAmountSql`) |
| `vat_amount_cents(p_base_cents bigint, p_rate_bp int)` | FUNCTION `DETERMINISTIC` | `bigint` | `montants.db.test.ts`, triggers |
| `invoice_payment_status(p_kind varchar(20), p_total_cents int, p_paid_cents int, p_credited_cents int)` | FUNCTION `DETERMINISTIC` | `varchar(20)` : `issued`, `cancelled`, `paid`, `partially_paid` | `montants.db.test.ts` ; la contrainte `invoices_status_derived` porte la même expression en `CASE` |
| `seed_accounting_accounts(p_tenant_id char(36))` | FUNCTION | `int` : nombre de comptes du centre après pose | tests ; appelée aussi par le trigger `tenants_seed_accounting_accounts` à la création d'un centre. **`toutVider()` vide `accounting_accounts` : les tests qui s'en servent rappellent cette fonction** |
| `derive_accounting_code(p_name text)` | FUNCTION `DETERMINISTIC` | `varchar(17)` | `comptabilite-anonymisation.db.test.ts` ; **appelée par l'anonymisation d'un client** (module rgpd, `anonymize_client_rows`) ; définie dans `50-facturation.sql` |

Routines **internes** (jamais appelées depuis le code) :
`invoice_settle(p_invoice_id)` (trigger des paiements et `issue_invoice` pour un
avoir) et `invoice_line_check(...)` (procédure partagée par les triggers
d'insertion et de mise à jour des lignes).

### 1.1 `issue_invoice(p_invoice_id, p_issued_by)`

Même contrat que PostgreSQL : verrouille le brouillon, vérifie les mentions
obligatoires, **recalcule la TVA et les totaux**, prend le numéro
(`next_document_number`), date du jour du centre, fige vendeur / acheteur /
mentions, règle la facture corrigée pour un avoir. Mêmes codes : `CA002` déjà
émise, `CA003` non conforme. Rend le numéro.

```ts
const [rows] = await tx.execute(sql`select issue_invoice(${id}, ${staffMemberId}) as number`)
const number = (rows as { number: string }[])[0].number
```

- Le message `CA003` « Émission impossible, il manque : … » tient en 128
  caractères (limite de `SIGNAL`) : la fin d'une longue liste est coupée. Le
  détail complet se lit avant l'émission (`factures-document.ts`).
- Les mentions JSON (`seller_snapshot`, `buyer_snapshot`, `legal_mentions`)
  sont lues par `mysql2` comme **objets** ; `vatOnDebits` y est un vrai
  `true`/`false`.

### 1.2 `draft_credit_note(p_id, p_invoice_id, p_reason)`

Crée le brouillon d'avoir `p_id` (reprise des lignes pas encore entièrement
créditées de la facture) **et recalcule ses montants**. Plus de valeur de
retour : l'appelant connaît déjà l'identifiant.

```ts
const id = uuidv7()
await tx.execute(sql`call draft_credit_note(${id}, ${invoiceId}, ${reason})`)
```

`p_reason` : `NULL` accepté.

## 2. Changement de comportement à connaître : le recalcul des montants

PostgreSQL recalculait la TVA des lignes et les totaux du brouillon par un
trigger **d'instruction** après chaque écriture de ligne
(`invoice_lines_refresh`). MySQL n'a ni trigger d'instruction ni droit pour un
trigger de `invoice_lines` d'écrire `invoice_lines`. Conséquence :

- à chaque écriture d'une ligne, le trigger `BEFORE` pose **la TVA provisoire
  de cette ligne** (`vat_amount_cents`, `total_amount_cents`) comme avant ;
- **la répartition de l'écart d'arrondi par taux (EN 16931 BR-CO-17) et les
  totaux de la facture (`total_excl_tax_cents`, `total_tax_cents`,
  `total_incl_tax_cents`) ne sont tenus à jour que par**
  ``select invoice_refresh_amounts(${invoiceId})``.

**À faire par « facturation B »**, après chaque série d'écritures de lignes
d'un brouillon, dans la même transaction (fait dans `factures-queries.ts` et
`lot-queries.ts` d'après les tests ; à vérifier pour toute écriture de ligne
ajoutée) : insertion, mise à jour, retrait (`deleted_at`) d'une ligne, ou
changement du client d'un brouillon sans ligne.

`issue_invoice` et `draft_credit_note` rappellent la fonction elles-mêmes : une
facture **émise** est toujours juste ; seuls les totaux **affichés d'un
brouillon** dépendent de l'appel.

L'abandon d'un brouillon (`update invoices set deleted_at = …`) retire encore
ses lignes par trigger (`invoices_after_update`).

## 3. Routines d'autres modules que la facturation appelle

| Routine | Module | Que savoir |
|---|---|---|
| `next_document_number(p_type)` | socle | appelée par `issue_invoice` |
| `contract_price_versions`, `contract_segments` | contrats | **vues** (`routines-contrats.md`) : `join … on v.contract_id = contracts.id`, plus de `cross join lateral` ; les triggers de lignes les lisent |
| `mail_request_service_code(p_kind)` | courrier | utilisée par le garde des lignes (acte d'une demande) |
| `anonymize_client(...)` | rgpd | appelle `derive_accounting_code` |

## 4. Propriétés exportées du schéma : changements

Aucun nom de propriété ni de colonne n'est renommé. Ajouts (colonnes
**générées**, jamais à insérer — absentes de `$inferInsert`) :

| Table | Colonne générée | Sert à |
|---|---|---|
| `rate_plan_items` | `live`, `typeLive` | index uniques partiels (`rate_plan_items_resource_key`, `rate_plan_items_type_key`) |
| `services` | `live` | unicité du `code` d'un service vivant |
| `sepa_mandates` | `activeLive` | un seul mandat actif par client |
| `invoice_runs` | `runningLive` | un seul lot `running` par centre |
| `invoices` | `runPeriodLive` | une facture de lot par client et par période |
| `invoice_lines` | `heldLive` | une source n'est tenue que par une ligne vivante (réservation, pli, demande de courrier) |
| `accounting_accounts` | `lineKindKey`, `vatRateKey` | `nulls not distinct` de PostgreSQL : unicité `(purpose, line_kind, vat_rate_bp)` avec des `NULL` |

Pour `accounting_accounts` : un `ON CONFLICT (tenant_id, purpose, line_kind,
vat_rate_bp)` devient `onDuplicateKeyUpdate` (toute clé unique réagit).

Autres écarts de type :

- `invoice_reminders.recipients` : `json` typé `string[]` ;
  `cardinality()` devient `JSON_LENGTH()`.
- `sepa_mandates.ibanCiphertext` : `varbinary(512)`, rendu en `Buffer`.
- `lineNetAmountSql({...})` garde sa signature et rend une **expression
  arithmétique en ligne** (une colonne générée MySQL ne peut pas appeler une
  fonction stockée) ; le résultat est identique à `line_net_amount_cents` et à
  `lineNetAmountCents()` (`montants.ts`), éprouvé sur 1 400 cas.
- Les énumérations exportées (`invoiceStatusEnum`, `rateUnitEnum`, …) sont des
  fonctions `(name) => mysqlEnum(name, valeurs)` ; leur appel
  `rateUnitEnum('unit')` ne change pas. **`invoiceStatusEnum.enumValues` et
  équivalents n'existent plus** : utiliser les tableaux `invoiceStatuses`,
  `rateUnits`, … déjà exportés.

## 5. Codes d'erreur : écarts

- Violation d'une exclusion (`invoice_lines_contract_period_no_overlap`,
  `invoice_lines_subscription_period_no_overlap`,
  `subscribed_services_no_overlap`, `rate_plans_default_no_overlap`) :
  `CA000` (`DB_EXCLUSION_VIOLATION`) au lieu de `23P01`.
- Unicité d'une source (réservation, pli, demande) : `23505` comme avant ;
  `dbConstraintName()` rend le nom d'index (`invoice_lines_booking_key`, …).
- Écriture sous portée client hors de ses entreprises, sur une table de
  facturation, ou toute écriture sous portée sur une table du seul
  back-office (lots, plan de comptes, exports, relances) : `CA015`
  (`DB_CLIENT_SCOPE_REFUSED`) à la place du `42501` de la politique RLS. Un
  client n'écrit jamais un brouillon.
- **Suppressions et journaux** : plus de `REVOKE DELETE/UPDATE` (MySQL n'a pas
  de droit par table dans ce montage). Des triggers refusent, avec le même
  code qu'avant, `42501` (errno 1142, `DB_INSUFFICIENT_PRIVILEGE`) :
  `DELETE` sur `services`, `offers`, `offer_items`, `subscribed_services`,
  `invoice_runs`, `invoices`, `invoice_lines`, `payments`, `sepa_mandates`,
  `invoice_reminders`, `accounting_exports` ; `UPDATE` sur `invoice_reminders`
  et `accounting_exports`. **Le propriétaire aussi** (il avait `CA002`
  auparavant) ; `TRUNCATE` (tests) n'est pas intercepté.
- `MESSAGE_TEXT` d'un `SIGNAL` tient en 128 caractères : les messages qui
  portent un numéro ou un montant (« Avoir excédentaire : il reste N
  centimes… ») sont coupés à 128, les **codes** `CAnnn` sont inchangés.

## 6. Variables de session

| Variable | Posée par | Lue par |
|---|---|---|
| `@app_invoice_amounts_sync` | `invoice_refresh_amounts` : `'on'` le temps de ses écritures, **remise à `NULL`** (y compris sur erreur) | gardes de `invoices` et `invoice_lines` |
| `@app_invoice_issue` | `issue_invoice` | garde de `invoices` : seul chemin vers l'état émis |
| `@app_invoice_settlement_sync` | `invoice_settle` | gardes de `invoices` et `invoice_lines` : paiements, avoirs, libération des sources |
| `@app_client_ids`, `@app_tenant_id` | `withClientScope()`, `withTenant()` | gardes d'écriture sous portée (copiés dans une variable locale : voir ci-dessous) |

Les triggers copient `@app_client_ids` dans une **variable locale**
(`DECLARE v_scope … DEFAULT @app_client_ids`) avant tout `FIND_IN_SET` : une
variable de session non posée n'a pas la collation des colonnes
(`utf8mb4_0900_as_ci`) et `FIND_IN_SET` lève « Illegal mix of collations ».
