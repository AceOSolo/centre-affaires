# ADR 002 — Schéma des ressources et des réservations

**Date** : 2026-09-18
**Statut** : accepté

## Contexte

Première tranche de construction : ressources, calendrier et réservation en
back-office. Il faut poser les premières tables, et avec elles la façon dont
toutes les suivantes seront écrites — identifiants, isolation par centre,
horodatage, suppression logique.

Les décisions 1 à 6 de `CLAUDE.md` fixent le cadre. Cet ADR consigne les choix
de mise en œuvre qu'elles laissent ouverts.

## Décision

### Trois tables

`tenants`, `resources`, `bookings`. Les grilles tarifaires, les clients et les
horaires d'ouverture arrivent avec les tranches suivantes.

`resources` porte `resource_type`, `code`, `name`, `capacity`, `status` et un
`attributes` en JSONB pour les champs propres à chaque type. `bookings` porte
`resource_id`, `starts_at`, `ends_at`, `status` et le motif.

### Isolation par centre fermée par défaut

Le contexte de centre est porté par un paramètre de session Postgres,
`app.tenant_id`, posé par `withTenant()` pour la durée de la transaction — donc
compatible avec un pooler en mode transaction. Les politiques RLS comparent à
`current_tenant_id()`, qui renvoie NULL quand le paramètre est absent : une
requête émise hors contexte ne renvoie aucune ligne.

`ENABLE` et `FORCE ROW LEVEL SECURITY` n'y suffisent pas, parce que l'attribut
`BYPASSRLS` l'emporte sur `FORCE` et que le rôle propriétaire le porte dans les
deux environnements. L'ADR 003 traite ce point et retient un rôle de connexion
dédié, `app_centre` : c'est lui, et non le propriétaire, qui sert les requêtes
de l'application.

Conséquence pour ce schéma : `src/db/index.ts` n'exporte pas la base, seulement
`withTenant()`. Le passage par le contexte de centre n'est pas une convention
qu'on peut oublier, c'est le seul chemin ouvert au code métier.

La valeur par défaut de `tenant_id` retombe sur le centre unique tant que le
produit est mono-centre, conformément à la décision 1.

### Une réservation ne peut pas pointer sur la ressource d'un autre centre

`bookings` référence `resources` par une clé étrangère composite
`(tenant_id, resource_id)`. Un identifiant de ressource copié d'un autre centre
est rejeté par la base, pas seulement filtré par RLS.

### UUID v7 généré en base

Une fonction `uuid_generate_v7()` sert de valeur par défaut. Un seed, un import
ou une requête SQL directe produisent donc les mêmes identifiants qu'une
insertion par l'application.

Postgres 18 fournit `uuidv7()` nativement, et l'ADR 003 aligne tous les
environnements sur cette version : la fonction maison peut être réduite à un
appel au natif. Reste à faire, par une nouvelle migration — la 0000 est
appliquée, elle ne se modifie plus.

### `updated_at` tenu par un trigger

Même raison : la colonne reste juste quel que soit l'auteur de l'écriture.

### Pas de `deleted_at` sur `bookings`

L'annulation est la suppression logique d'une réservation, et c'est déjà le
prédicat de la contrainte d'exclusion (`status <> 'cancelled'`). Un second
marqueur laisserait des créneaux bloqués par des lignes invisibles dans
l'interface. `resources` et `tenants` gardent `deleted_at`.

### Les invariants sont dans la base

Contrainte d'exclusion pour le chevauchement, `CHECK` pour l'intervalle non
vide et pour la cohérence entre `status = 'cancelled'` et `cancelled_at`. Les
fonctions de `availability.ts` reproduisent les mêmes règles pour répondre à
l'utilisateur avant l'écriture, mais ne font pas autorité.

## Alternatives écartées

**RLS ouverte par défaut** (retomber sur le centre unique quand `app.tenant_id`
est absent) : plus confortable aujourd'hui, mais le jour où un deuxième centre
arrive, un oubli de contexte donne accès aux données d'un autre client sans
rien casser de visible. Fermer par défaut rend l'oubli immédiat.

**`SET LOCAL ROLE` depuis le rôle propriétaire**, plutôt qu'un rôle de
connexion dédié : évite un secret de plus à gérer par environnement, et une
migration suffit à tout mettre en place. Écarté au profit de la solution de
l'ADR 003 : avec `SET ROLE`, une requête émise hors de `withTenant()` tourne en
propriétaire et voit tous les centres, alors qu'avec une connexion dédiée elle
ne voit rien. La différence porte précisément sur le cas de l'oubli, c'est-à-dire
le seul qui compte.

**UUID v7 généré en TypeScript** (paquet `uuidv7`) : permet de connaître
l'identifiant avant l'insertion, au prix d'une dépendance et d'un comportement
différent selon l'auteur de l'écriture. À reconsidérer si un besoin réel
d'identifiant pré-alloué apparaît.

**Une table par type de ressource** : écartée par la décision 2.

**Vérification du chevauchement en code** : écartée par la décision 3.

## Conséquences

Toute lecture ou écriture métier doit passer par `withTenant()`. Une requête
émise hors de ce contexte renvoie zéro ligne — c'est le comportement voulu, mais
il surprend, d'où le commentaire explicite dans `src/db/index.ts`.

Les migrations 0000, 0002, 0003 et 0004 sont écrites à la main (`drizzle-kit
generate --custom`) : Drizzle ne sait décrire ni les contraintes d'exclusion, ni
les politiques RLS, ni les triggers, ni les rôles. Elles restent des migrations numérotées comme
les autres et suivent la même règle : jamais éditées après application.

L'identifiant du centre unique est écrit à trois endroits — `DEFAULT_TENANT_ID`,
`tenant_id_default()` et l'insertion de la migration 0002. C'est le prix de la
valeur par défaut exigée par la décision 1 ; un test d'intégration vérifie que
les trois concordent.

Les contraintes de la base ne sont vérifiables que par un vrai moteur : la CI
démarre un Postgres 17 et `*.db.test.ts` y applique les migrations avant de les
mettre à l'épreuve. Sans `TEST_DATABASE_URL`, ces tests sont ignorés.

Ces tests passent par `createDatabase()` et `withTenant()`, le code utilisé en
production, et non par une connexion montée pour l'occasion : une isolation qui
ne tiendrait que dans le test ne prouverait rien. L'un d'eux vérifie
explicitement que le rôle courant n'a pas `BYPASSRLS` — sans ce garde-fou, tous
les autres tests d'isolation passeraient à vide.

Drizzle enveloppe les erreurs du driver dans une `DrizzleQueryError` depuis la
0.44. Le code applicatif qui distingue un conflit de créneau (`23P01`) d'une
autre erreur doit dérouler la chaîne des `cause` ; `error.code` est indéfini.
