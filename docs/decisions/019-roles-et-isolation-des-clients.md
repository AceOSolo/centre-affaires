# ADR 019 — Rôles de l'équipe et isolation des clients entre eux

**Date** : 2026-10-01
**Statut** : accepté

## Contexte

Le cahier des charges distingue trois rôles : exploitant, accueil et client
(R27). Il exige aussi des comptes clients isolés (R28). L'ADR 016 a écarté le
second facteur : R28 se limite donc à l'isolation.

Ce qui existe :

- **Deux rôles d'équipe**, `admin` et `staff` (`staff_role`, ADR 008), dans
  `staff_members`.
- **Les accès clients**, dans une table à part, `client_members` (ADR 015).
- **Une isolation par centre seulement.** La RLS ne sépare que les centres.
  L'isolation entre clients repose sur des filtres `where client_id in (…)`
  écrits dans chaque requête de l'espace client (`compte-queries.ts`,
  `courrier/queries.ts`). Un filtre oublié dans une requête future suffirait à
  montrer à une entreprise le courrier d'une autre. C'est la donnée la plus
  sensible du produit.

## Décision

### Rôles : on garde les valeurs, l'interface affiche les libellés du cahier des charges

| Valeur en base (`staff_role`) | Rôle du cahier des charges |
|---|---|
| `admin` | Exploitant |
| `staff` | Accueil |

La correspondance vit dans `staffRoleLabels` (`src/db/staff.ts`). L'interface
affiche toujours le libellé, jamais la valeur. Aucune migration n'est
nécessaire.

Le rôle client reste porté par `client_members`, pas par une valeur de
`staff_role` : l'ADR 015 a écarté le mélange des deux populations.

**La matrice des droits vit dans le code, pas en base.** Elle décide qui peut
faire quoi dans le back-office, et elle est vérifiée dans chaque action serveur,
comme `requireStaff()` (ADR 008). La RLS ne distingue pas l'exploitant de
l'accueil : tous deux voient les données de leur centre, et c'est l'action qui
refuse ce que le rôle ne permet pas.

### Isolation des clients : un second niveau de RLS, la portée client

**La portée.** Une transaction peut porter une *portée client* : le paramètre
de session `app.client_ids`, un tableau d'identifiants d'entreprises. Il est
posé par :

```ts
withClientScope<T>(
  tenantId: string,
  clientIds: readonly string[],
  run: (tx: Transaction) => Promise<T>,
  database?: Database,
): Promise<T>
```

Cette fonction est dans `src/db/index.ts`, à côté de `withTenant()`. Elle pose
aussi `app.tenant_id`, pour la durée de la transaction seulement. La fonction
SQL `current_client_ids()` lit la portée : elle rend `NULL` hors portée.

**Les politiques.** Des politiques `RESTRICTIVE` s'ajoutent en *et* aux
politiques par centre. Sous portée client, elles ne laissent lire et écrire que
les lignes des entreprises de la portée :

| Table | Rattachement au client |
|---|---|
| `clients` | `id` |
| `client_members`, `client_contacts`, `contracts`, `bookings`, `mail_items` | `client_id` |
| `mail_scans` | par le pli (`mail_items.client_id`) |
| `mail_scan_views` | par la numérisation, puis le pli |

**Ce qui se passe selon la portée :**

- **Sans portée** (le back-office) : rien ne change.
- **Portée vide** (`[]`) : rien ne passe. Le défaut est fermé, comme pour
  `app.tenant_id`.
- **Tables sans client** (`resources`, `tenants`, `opening_hours`, etc.) : elles
  restent lisibles, comme sous `withTenant()`.
- **Réservation sans client** (indisponibilité, réservation interne, demande
  d'un visiteur) : elle n'appartient à aucune portée, elle est donc invisible
  depuis un espace client. Pour afficher les disponibilités, la fonction
  `booking_busy_ranges(from, to, resource_ids?)` rend les créneaux occupés de
  tout le centre. Elle ne rend que la ressource, le début et la fin : ni objet,
  ni client, ni demandeur. C'est ce que la page publique montre déjà.

**La preuve.** `src/db/portee-client.db.test.ts` interroge chaque table sous le
rôle `app_centre`, sans aucun `where`, sous portée client. Seules les lignes de
l'entreprise de la portée remontent. Une écriture pour une autre entreprise, ou
pour aucune, est refusée.

**L'usage dans l'espace client.** Le compte connecté est d'abord résolu en
entreprises sous `withTenant()` : `resolveClientAccounts` doit lire
`client_members` pour savoir de quelles entreprises il relève. Ensuite, toutes
les lectures et écritures de l'espace passent par
`withClientScope(currentTenantId(), accounts.map((a) => a.clientId), …)`. Les
filtres applicatifs restent : la RLS est un second verrou, pas un remplaçant.

## Justification

**Pourquoi garder `admin` et `staff`.** Renommer une valeur d'énumération coûte
une ligne de SQL (`ALTER TYPE … RENAME VALUE`). Mais le renommage touche aussi :

- les gardes (`requireAdmin`) ;
- les tests ;
- `infra/ajouter-membre-staff.mjs` et sa documentation ;
- les comptes déjà inscrits en production.

Tout cela pour une valeur que personne ne lit à l'écran. Le changement minimal
est le libellé.

**Pourquoi des politiques restrictives.** Une politique permissive s'ajoute en
*ou* : elle élargirait l'accès au lieu de le restreindre. Une politique
`RESTRICTIVE` se combine en *et* avec l'isolation par centre. Une ligne doit
satisfaire les deux.

**Pourquoi une sous-requête pour les numérisations.** `mail_scans` et
`mail_scan_views` n'ont pas de `client_id`. Il faudrait le recopier depuis le
pli et le tenir à jour par trigger si le pli changeait de client. La
sous-requête sur `mail_items` suit le pli sans dupliquer, et elle est elle-même
soumise aux politiques de `mail_items`.

## Conséquences

- **Ce n'est pas une frontière contre un code malveillant.** Le rôle applicatif
  peut appeler `set_config` lui-même. Comme `app.tenant_id`, la portée protège
  contre un filtre oublié, pas contre un code qui choisirait sa portée.
- **Les fonctions `SECURITY DEFINER` ne voient pas la portée.** Elles
  s'exécutent sous le propriétaire, qui contourne la RLS (`BYPASSRLS` sur Neon,
  ADR 003). Chacune filtre donc elle-même sur `current_tenant_id()`, et
  `booking_busy_ranges` ignore volontairement la portée client.
- **Aucune fuite d'une requête à l'autre.** La portée est locale à la
  transaction (`set_config(…, true)`) : une connexion rendue au pool ne la garde
  pas. Un test le vérifie sur une connexion unique.
- **Performance.** Chaque ligne de `mail_scans` et de `mail_scan_views` passe
  par une sous-requête indexée. C'est négligeable au volume d'un centre.
- **Paramètre tableau.** Pour passer une liste à `booking_busy_ranges` depuis
  Drizzle, il faut écrire ``sql`array[${id}::uuid]` `` ou un littéral `'{…}'` :
  un tableau JavaScript interpolé n'est pas converti.

## Alternatives écartées

**Renommer les valeurs en `exploitant` et `accueil`.** Pour les raisons données
plus haut : aucun gain visible, des écritures partout.

**Une table des rôles et des permissions en base.** Une matrice éditable à
l'écran est un besoin de multi-centres configurable, que personne n'a exprimé.
Elle déplacerait vers une configuration modifiable la frontière que les actions
serveur tiennent aujourd'hui dans le code relu.

**Un rôle Postgres par client, ou `SET ROLE` par requête.** Cela demande de
gérer des rôles à la volée, et c'est incompatible avec le pooler en mode
transaction de Neon. Un paramètre de session fait le même travail dans le cadre
déjà posé pour `app.tenant_id`.

**Recopier `client_id` sur les numérisations et le journal.** C'est une donnée
en double, à tenir à jour par trigger, pour un gain de performance sans objet à
ce volume.

**Le second facteur pour l'équipe.** Écarté par le centre (ADR 016).
