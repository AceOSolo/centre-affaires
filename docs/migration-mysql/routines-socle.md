# Routines du socle (`src/db/regles/05-fondations.sql`)

| Routine | Type | Appelée par |
|---|---|---|
| `next_document_number(p_type varchar(20)) → varchar(32)` | FUNCTION (`SQL SECURITY DEFINER`, `MODIFIES SQL DATA`) | `issue_invoice` (facturation, dans la routine SQL), `contracts` (référence automatique, contrats), tests `src/modules/contrats/numerotation.db.test.ts` |

## `next_document_number(p_type)`

- `p_type` : `'contract'`, `'invoice'` ou `'credit_note'` (valeurs de
  `documentTypes`, `src/db/numerotation.ts`). Plus de cast `::document_type` :
  passer la chaîne telle quelle. Une valeur inconnue lève une erreur.
- Rend `CT-2026-0001`, `FA-2026-0001`, `AV-2026-0001` : même format que
  PostgreSQL (quatre chiffres au moins, jamais tronqué).
- Appel : ``sql`select next_document_number(${type}) as numero` `` ;
  dans une routine SQL : `SET v_number = next_document_number('invoice');`.
- Centre = `@app_tenant_id` (posée par `withTenant()`). Hors contexte : erreur
  « Numérotation impossible hors du contexte d'un centre » (sans code `CAnnn`,
  comme l'original).
- Atomique et sans trou : `INSERT … ON DUPLICATE KEY UPDATE last_value =
  LAST_INSERT_ID(last_value + 1)` verrouille la ligne du compteur jusqu'à la
  fin de la transaction appelante ; une transaction annulée rend son numéro.
- Année civile calculée dans le fuseau du centre (`tenants.timezone`) avec
  `CONVERT_TZ` : **les tables de fuseaux de MySQL doivent être chargées**
  (`mysql_tzinfo_to_sql`). Sinon la fonction lève une erreur explicite plutôt
  que de numéroter dans la mauvaise année.
- Création de la fonction : en `log_bin` actif, l'utilisateur de migration doit
  avoir `SUPER` ou `log_bin_trust_function_creators = 1`.
- `document_sequences` n'est modifiable que par cette fonction (DEFINER) :
  `infra/migrer.ts` retire `INSERT/UPDATE/DELETE` à l'utilisateur applicatif.

## Disparues (plus d'équivalent à appeler)

`uuid_generate_v7()` (→ `uuidv7()` TS), `current_tenant_id()`,
`tenant_id_default()` (→ `@app_tenant_id` et `tenantId()` Drizzle),
`set_updated_at()` (→ triggers `<table>_set_updated_at` du migrateur).
