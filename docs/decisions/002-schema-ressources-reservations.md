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
`app.tenant_id`, posé par `withTenant()` dans la transaction. Les politiques RLS
comparent à `current_tenant_id()`, qui renvoie NULL quand le paramètre est
absent : une requête émise hors contexte ne renvoie aucune ligne.

`FORCE ROW LEVEL SECURITY` est activée : sans elle, le propriétaire des tables —
c'est-à-dire le rôle applicatif, sur Neon comme en local — échapperait aux
politiques et les tests passeraient sans rien prouver.

La valeur par défaut de `tenant_id` retombe sur le centre unique tant que le
produit est mono-centre, conformément à la décision 1.

### Une réservation ne peut pas pointer sur la ressource d'un autre centre

`bookings` référence `resources` par une clé étrangère composite
`(tenant_id, resource_id)`. Un identifiant de ressource copié d'un autre centre
est rejeté par la base, pas seulement filtré par RLS.

### UUID v7 généré en base

Une fonction `uuid_generate_v7()` sert de valeur par défaut. Un seed, un import
ou une requête SQL directe produisent donc les mêmes identifiants qu'une
insertion par l'application. Postgres 18 fournit `uuidv7()` nativement : la
fonction disparaîtra à la montée de version.

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

**UUID v7 généré en TypeScript** (paquet `uuidv7`) : permet de connaître
l'identifiant avant l'insertion, au prix d'une dépendance et d'un comportement
différent selon l'auteur de l'écriture. À reconsidérer si un besoin réel
d'identifiant pré-alloué apparaît.

**Une table par type de ressource** : écartée par la décision 2.

**Vérification du chevauchement en code** : écartée par la décision 3.

## Conséquences

Toute lecture ou écriture métier doit passer par `withTenant()`. Une requête
directe sur `db` renvoie zéro ligne — c'est le comportement voulu, mais il
surprend, d'où le commentaire explicite dans `src/db/index.ts`.

Les migrations 0000, 0002 et 0003 sont écrites à la main (`drizzle-kit generate
--custom`) : Drizzle ne sait décrire ni les contraintes d'exclusion, ni les
politiques RLS, ni les triggers. Elles restent des migrations numérotées comme
les autres et suivent la même règle : jamais éditées après application.

L'identifiant du centre unique est écrit à trois endroits — `DEFAULT_TENANT_ID`,
`tenant_id_default()` et l'insertion de la migration 0002. C'est le prix de la
valeur par défaut exigée par la décision 1 ; un test d'intégration vérifie que
les trois concordent.

Les contraintes de la base ne sont vérifiables que par un vrai moteur : la CI
démarre un Postgres 17 et `*.db.test.ts` y applique les migrations avant de les
mettre à l'épreuve. Sans `TEST_DATABASE_URL`, ces tests sont ignorés.
