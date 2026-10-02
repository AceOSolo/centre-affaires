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

## Mise en œuvre

### La matrice des droits

Elle est dans `src/lib/auth/permissions.ts`, un module pur éprouvé par
`permissions.test.ts`. Un droit est une capacité du back-office, pas un écran :

| Droit | Ce qu'il couvre | Accueil | Exploitant |
|---|---|---|---|
| `reservations.gerer` | Planning : créer, déplacer, annuler, rattacher à un client, séries et indisponibilités | oui | oui |
| `demandes.traiter` | Valider ou refuser les demandes de réservation | oui | oui |
| `clients.gerer` | Fiches clients, accès à l'espace client | oui | oui |
| `courrier.gerer` | Enregistrer, ouvrir, retirer, consulter le courrier | oui | oui |
| `contrats.consulter` | Lire les contrats | oui | oui |
| `clients.archiver` | Archiver une fiche client | non | oui |
| `courrier.releve` | Relevé mensuel des ouvertures et son export (source de la facturation) | non | oui |
| `contrats.creer` | Créer un contrat, modifier un brouillon | non | oui |
| `contrats.activer` | Activer un contrat | non | oui |
| `contrats.resilier` | Résilier un contrat | non | oui |
| `contrats.archiver` | Archiver un contrat | non | oui |
| `tarifs.gerer` | Grilles tarifaires | non | oui |
| `ressources.gerer` | Ressources et annonces du site public | non | oui |
| `horaires.gerer` | Horaires d'ouverture et fermetures | non | oui |
| `centre.configurer` | Configuration du centre : règles de réservation, conservation | non | oui |
| `agenda-google.gerer` | Agendas Google | non | oui |
| `equipe.gerer` | Équipe : inscrire, changer un rôle, retirer | non | oui |

L'accueil tient l'opérationnel du quotidien. Ce qui engage le centre
(prix, contrats, équipe, configuration, export vers la facturation) revient à
l'exploitant. Le test refuse un droit ajouté sans décision explicite sur
l'accueil : la répartition se tranche, elle ne s'hérite pas.

### Une garde unique

`requirePermission(droit)` (`src/lib/auth/staff.ts`) remplace `requireStaff()`
et `requireAdmin()` en tête de chaque page, route et action serveur du
back-office :

- **Sans session ou sans membre** : même issue qu'avant, connexion ou accès
  refusé.
- **Membre dont le rôle ne suffit pas** : renvoi vers `/acces-reserve`, dans la
  coque du back-office. La page dit quel droit manquait et à qui s'adresser.

`requireStaff()` ne garde plus que la coque et `/acces-reserve`, ouverte à
tout membre puisqu'elle explique le refus. `requireAdmin()` reste, dépréciée,
comme alias de `requirePermission('equipe.gerer')`.

`src/lib/auth/gardes.test.ts` relit les sources et échoue si une page, une
route ou une action serveur du back-office n'appelle pas `requirePermission()`
avec un droit de la matrice. Une page ajoutée sans garde ne passe pas la CI.

### Navigation et boutons

Chaque entrée de la navigation porte le droit de sa page ; la coque passe les
droits du membre (`permissionsOf(role)`) et la navigation masque le reste.
Dans les pages ouvertes aux deux rôles, les boutons qu'un rôle ne peut pas
utiliser sont masqués : activer ou résilier un contrat, nouveau contrat,
archiver un client, relevé des ouvertures. Le serveur refuse de toute façon :
masquer est un confort, pas la protection.

Les écrans et actions livrés par les autres tranches de la vague 1 suivent la
même matrice : modifier un brouillon de contrat (`contrats.creer`), changer la
ressource d'un contrat en cours (`contrats.activer`, puisque c'est déplacer son
occupation), archiver et désarchiver un contrat (`contrats.archiver`), contacts
de la fiche client (`clients.gerer`), fiche et modification d'une ressource
(`ressources.gerer`), vue mois du planning (`reservations.gerer`).

L'en-tête affiche le libellé du rôle à côté du nom.

### L'écran Équipe

`/equipe`, réservé à l'exploitant (`equipe.gerer`) :

- il liste les membres actifs, leur rôle et l'état de leur compte ;
- il inscrit un membre par son adresse et son rôle ;
- il fait passer un membre de l'accueil à l'exploitant, et inversement ;
- il retire un membre (`deleted_at`) : l'accès cesse, la ligne reste.

Il reprend la matrice en tableau, pour que l'équipe sache ce que chaque rôle
permet.

**Règles**, dans `src/lib/auth/equipe.ts` :

- on ne se retire pas soi-même ;
- on ne change pas son propre rôle : un exploitant qui se rétrograde perdrait
  l'écran d'où annuler son geste ;
- on ne retire pas, et on ne rétrograde pas, le dernier exploitant actif.

La règle s'exerce dans la transaction qui écrit. Les exploitants actifs et la
cible sont verrouillés ensemble (`for update`, dans l'ordre des
identifiants) : deux exploitants qui se rétrogradent l'un l'autre au même
instant passent l'un après l'autre, et le second relit un exploitant de moins.
`equipe.db.test.ts` éprouve les règles et ce cas concurrent contre la base.

`infra/ajouter-membre-staff.mjs` reste pour l'amorçage (le premier exploitant)
et le dépannage. Il n'applique pas ces règles.

### L'espace client sous portée

`inClientSpace(accounts, run)` (`src/modules/clients/comptes.ts`) appelle
`withClientScope(currentTenantId(), accounts.map((a) => a.clientId), run)`.
Toutes les lectures et écritures de l'espace client passent par elle, en plus
de leurs filtres :

- `listMailForAccounts`, `requestOpening`, `cancelOpeningRequest` et
  `findScanForAccounts` (`courrier/queries.ts`) ;
- `logScanView` pour une consultation par un client, sous la portée de
  l'entreprise destinataire du pli ;
- `listBookingsForAccounts` et `cancelRequestForAccounts`
  (`reservations/compte-queries.ts`).

Restent sous `withTenant()`, volontairement :

- la résolution du compte (`resolveClientAccounts`) : c'est elle qui dit
  quelle portée poser ;
- la lecture du centre (`currentTenant`) : `tenants` ne relève d'aucun client ;
- le courriel à l'équipe après une demande d'ouverture
  (`notifyOpeningRequested`) : il est écrit pour le centre ;
- la demande de réservation du site public (`requestBookingAction`), qui peut
  venir d'un visiteur anonyme.

`src/modules/clients/espace-client.db.test.ts` le prouve avec le code de
l'espace lui-même. Une requête de l'espace écrite sans aucun filtre, ou avec un
filtre sur l'entreprise voisine, ne rend que l'entreprise du compte. Les
lectures et écritures du portail n'atteignent pas l'autre entreprise. Le
journal refuse la consultation d'un pli qui n'est pas le sien. Le back-office,
sans portée, voit toujours tout.
