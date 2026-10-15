# Routines SQL du module clients

Fichier de règles : `src/db/regles/30-clients.sql`. Contrat : `conventions.md`
§4.1. Rédigé **avant** le SQL.

## 1. Routines appelées depuis le TypeScript

**Aucune.** Les tables `clients`, `client_members` et `client_contacts` n'ont,
dans PostgreSQL, ni fonction métier ni trigger métier : seulement
`set_updated_at()` (désormais généré par le migrateur) et les politiques RLS.
Les fonctions d'anonymisation qui les réécrivent (`anonymize_client`,
`client_last_activity_on`, …) sont dans `routines-rgpd.md` (`90-rgpd.sql`).

## 2. Triggers

| Trigger | Table | Règle |
|---|---|---|
| `clients_guard_client_scope_insert` / `_update` / `_delete` | `clients` | sous portée client (`@app_client_ids` non nul), une ligne dont `id` n'est pas dans la liste n'est ni écrite ni modifiée ni supprimée : `CA015` |
| `client_members_guard_client_scope_insert` / `_update` / `_delete` | `client_members` | idem, sur `client_id` |
| `client_contacts_guard_client_scope_insert` / `_update` / `_delete` | `client_contacts` | idem, sur `client_id` |

Les politiques RESTRICTIVE `*_client_scope` de la migration 0026 filtraient les
lectures **et** les écritures. Les triggers ne reprennent que les écritures
(`WITH CHECK`, ainsi que l'ancienne ligne pour `UPDATE`/`DELETE`, ce que
faisait `USING`). **Les lectures sont filtrées par le code** : chaque requête
exécutée sous `withClientScope()` porte `inArray(table.clientId, clientIds)`
(conventions §6) — voir `src/modules/clients/historique-compte-queries.ts`.

`@app_client_ids = ''` (portée vide) refuse toute écriture : `FIND_IN_SET`
n'y trouve rien (défaut fermé, comme `{}` en PostgreSQL).

## 3. Écarts de comportement

- Écriture sous portée hors de ses entreprises : **`CA015`** (proposition :
  `DB_CLIENT_SCOPE_REFUSED` dans `src/db/errors.ts`, le même code que la
  facturation) à la place du `42501` de la politique RLS.
- `MESSAGE_TEXT` d'un `SIGNAL` : 128 caractères au plus, préfixe `CAnnn: `
  compris, et il ne prend qu'une **variable ou un littéral**, jamais une
  expression (`SET MESSAGE_TEXT = concat(…)` est une erreur de syntaxe).
- Index uniques « parmi les lignes vivantes » : colonnes générées `live`
  (`clients`, `client_members`) et `primary_live` (`client_contacts`), voir
  conventions §3.1. **Jamais à insérer.**
- Unicité d'un compte auxiliaire, d'un SIRET : le message de `23505` porte
  désormais `clients.clients_tenant_siret_key` (nom d'index, lu par
  `dbConstraintName()`).
