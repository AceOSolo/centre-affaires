# ADR 046 — Dolibarr tient le commercial et la facturation ; le back-office est rangé par produit

**Date** : 2026-10-20
**Statut** : accepté — amende l'ADR 016 (la facturation sort du site), met
en sommeil les ADR 026 à 034 (factures, paiements, lot, relances,
prélèvements, export comptable), tranche le point renvoyé par l'ADR 043 § 6
(« la bascule de la facturation »), étend l'ADR 043 aux fiches clients,
contrats, offres, services et tarifs ; première tranche faite, la seconde
(passerelle entrante) est à construire avec le développeur Dolibarr

## Contexte

Demande de l'exploitant (20/10/2026) :

> Dans l'admin, tout ce qui est commercial & facturation va être géré sur
> Dolibarr directement, notre site fait la passerelle. […] La distinction
> entre les espaces doit être claire par rapport à nos produits : les salles,
> les bureaux, la domiciliation, le camion… chaque espace doit être cohérent
> en fonction des types.

Quatre questions posées le même jour, quatre réponses :

| Question | Réponse |
|---|---|
| Où vivent les fiches clients (entreprises, contacts) ? | **Dans Dolibarr** ; le site en reçoit une copie, consultable, non modifiable. |
| Contrats, offres, services, tarifs ? | **Tout dans Dolibarr**, tarifs compris. |
| La facturation du site a-t-elle servi pour de vraies factures ? | **Non, jamais.** |
| Comment montrer les produits dans le menu ? | **Un rayon par produit.** |

Ce qui existait :

- le site porte toute la chaîne commerciale et de facturation (ADR 006, 016,
  023 à 034) : clients, contrats et avenants, catalogue, grilles tarifaires,
  factures et avoirs, lot mensuel planifié, relances, mandats et remises SEPA,
  export FEC ;
- l'ADR 043 a fait de Dolibarr le logiciel des devis, et annoncé qu'il
  ferait aussi les factures, sans faire la bascule ;
- le menu du back-office était rangé par tâche (planning, demandes,
  ressources…) : une salle, un bureau et le camion se mêlaient dans les mêmes
  listes.

## Décision

### 1. Dolibarr est la référence du commercial et de la facturation

Sont tenus dans Dolibarr, et seulement là :

- les **tiers** : entreprises clientes et prospects, contacts ;
- les **devis** (déjà, ADR 043), les **contrats** et leurs avenants, les
  **offres**, les **services** et les **tarifs** ;
- les **factures** et avoirs, les **règlements**, les **prélèvements**, les
  **relances**, l'**export comptable**, et le raccordement à la plateforme
  agréée de la réforme 2026-2027.

Le site garde l'**opérationnel** : ressources, planning et réservations,
demandes, courrier, états des lieux, espace client, comptes, notifications.

### 2. Le site est une passerelle, dans les deux sens

- **Vers Dolibarr**, ce que le site sait seul : les devis (ADR 043) et les
  **consommations facturables** — réservations hors contrat, actes de
  courrier (ouvertures, numérisations, réexpéditions, pages numérisées
  au-delà de celles comprises dans l'ouverture : `billablePages()`,
  `courrier/regles.ts`), services ponctuels.
- **Depuis Dolibarr**, ce dont l'opérationnel a besoin : la copie des
  tiers (pour l'espace client, le courrier, les réservations), les contrats
  en cours (qui occupe quel bureau ou quelle boîte aux lettres, qui est
  domicilié, du … au …, ADR 018), et les tarifs (le prix affiché à la
  réservation en ligne).

Même principe que l'ADR 043 : **le site expose une API à lui, stable,
documentée** dans `docs/integrations/dolibarr.md`, et le connecteur est écrit
par le développeur Dolibarr de l'exploitant. Le site ne tient ni identifiant
ni version de Dolibarr.

### 3. Première tranche (faite) : la facturation quitte le site

Aucune vraie facture n'a été émise par le site : il n'y a rien à reprendre,
seulement à arrêter.

- **Droits** : `facturation.consulter`, `facturation.gerer`,
  `paiements.gerer` et `comptabilite.exporter` ne sont plus accordés à aucun
  rôle (`dolibarrPermissions`, `lib/auth/permissions.ts`). Ils restent dans
  la liste : un identifiant de droit ne se recycle pas (ADR 019). Toute page
  ou action de facturation renvoie à « Accès réservé », qui dit d'aller dans
  Dolibarr ; les sections factures et mandats de la fiche client
  disparaissent d'elles-mêmes ; l'écran Équipe ne les liste plus.
- **Menu** : plus d'entrée Factures, Règlements, Comptabilité.
- **Lot planifié** : `/api/maintenance/facturation` ne prépare plus rien et
  répond `410` ; sa ligne est à retirer de la crontab du serveur
  (`infra/serveur/README.md`).
- **Le code et les tables restent** : rien n'est supprimé (décision 6), et
  la garde de l'ADR 043 sur le lot reste vraie. Leur retrait éventuel sera
  un nettoyage, une fois la passerelle en service.

### 4. Le back-office est rangé par produit

Un rayon par produit dans le menu, chacun avec son planning, ses demandes,
son parc et ses états des lieux :

| Rayon | Types de ressource | Entrées |
|---|---|---|
| Salles | `salle` | Planning (jour), Demandes, Salles |
| Bureaux | `bureau`, `casier` | Occupation (mois), Demandes, Bureaux, Casiers, États des lieux |
| Domiciliation | `boite_aux_lettres` | Courrier, Demandes (devis de domiciliation, ADR 043), Boîtes aux lettres |
| Camion | `vehicule` | Planning (semaine), Demandes, Véhicules, États des lieux |

« Au quotidien » garde les vues d'ensemble (planning général, toutes les
demandes, devis, tous les états des lieux) ; « Le centre » le parc complet,
les horaires, les annonces, les agendas. Le compteur de demandes en attente
est donné par rayon.

Le produit est un **regroupement d'affichage**, décrit une fois dans le code
(`ressources/produits.ts`) : il ne s'écrit jamais en base. La décision 2
(une seule table `resources`, un `resource_type`) est inchangée. Les listes
se filtrent par `?type=` (planning, parc) ou par `?produit=` (demandes,
états des lieux, devis) ; l'entrée du menu allumée suit ce filtre
(`nav-actif.ts`).

### 5. Seconde tranche (à faire) : la passerelle entrante

D'ici là, le rayon « Clients » (clients, contrats, offres, services,
tarifs) reste tel quel : le retirer avant que Dolibarr ne fournisse ces
données laisserait le site sans client à qui attribuer un courrier ni prix à
afficher. Elle comprendra :

- l'API qui reçoit de Dolibarr les tiers, les contrats et les tarifs, et la
  référence Dolibarr sur chaque fiche reçue ;
- l'API qui expose les consommations facturables à Dolibarr, à reprendre une
  seule fois chacune (comme les devis : « transmis », rejouable) ;
- les écrans Clients et Contrats en lecture seule, et la disparition des
  écrans Offres, Services et Tarifs ;
- l'arrêt de la reconduction tacite de nuit (`/api/maintenance/contrats`),
  qui revient à Dolibarr ;
- l'espace client : factures et contrats lus depuis ce que Dolibarr
  transmet, ou renvoi vers ses documents.

## Justification

**Couper par les droits plutôt que supprimer les écrans.** Une ligne dans la
matrice ferme toutes les pages et toutes les actions de facturation à la
fois, sans toucher à plus de deux mille lignes de règles SQL ni aux tests qui
les éprouvent. Si l'exploitant revenait en arrière, rien n'est perdu.

**Arrêter le lot plutôt que le laisser filtrer.** La garde de l'ADR 043 ne
retenait que les réservations au devis vivant ; les loyers des contrats et
les actes de courrier seraient encore partis en brouillon le 1er du mois.
Deux logiciels qui facturent, c'est une double facture.

**Le produit en code, pas en base.** Quatre rayons, qui regroupent des types
qui existent déjà : une table de produits, son écran et sa migration
n'apporteraient rien qu'un fichier relu et testé n'apporte. Si le centre
ajoute un produit, c'est une ligne et un test.

**Les casiers avec les bureaux, les boîtes aux lettres avec la
domiciliation.** C'est ainsi qu'ils se vendent : un casier accompagne un
poste de travail, une boîte aux lettres n'existe que pour un domicilié.

**La passerelle entrante dans une seconde tranche.** Elle dépend du format que
le développeur Dolibarr peut produire (tiers, contrats, produits et prix de
Dolibarr), qui n'est pas encore connu. La première tranche ne dépend de
personne et supprime dès maintenant le risque de double facturation.

## Alternatives écartées

**Un sélecteur de produit en haut de page**, qui filtrerait tout le
back-office : l'accueil passe d'un produit à l'autre dans la même heure, et
un filtre global caché fait chercher une réservation qui est simplement
filtrée. Écarté par l'exploitant.

**Supprimer le code et les tables de facturation tout de suite** : de gros
écarts à relire, des migrations sur des tables liées aux réservations et au
courrier (`invoice_lines`), pour un gain nul tant que la passerelle n'est pas
en service.

**Une table ou un écran par produit** : contraire à la décision 2 ; le
planning, les réservations et les demandes sont communs à tous.

**Garder les tarifs sur le site** pour chiffrer la réservation en ligne :
proposé, écarté par l'exploitant. Le site affichera les prix que Dolibarr
lui transmet.

## Conséquences

- Plus personne, exploitant compris, n'ouvre les factures, les règlements
  ni l'export comptable sur le site.
- **À faire sur le serveur** : retirer la ligne du lot de facturation de la
  crontab (`sudo -u deploy crontab -e`).
- Les **indicateurs** de chiffre d'affaires (ADR 031) lisent les factures du
  site : ils resteront vides. À relire depuis Dolibarr ou à retirer, avec la
  seconde tranche.
- La page « Factures » de l'**espace client** reste en place et vide (aucune
  facture émise) jusqu'à la seconde tranche.
- Le prix affiché à la réservation en ligne vient encore des grilles du site
  jusqu'à ce que Dolibarr transmette les siens.
- **À trancher avec le développeur Dolibarr** : le format des tiers, des
  contrats et des tarifs reçus ; la manière dont une grille à l'heure, à la
  demi-journée et à la journée (ADR 009, 023) s'écrit en produits Dolibarr ;
  la fréquence des échanges ; la référence commune d'un tiers (SIREN,
  identifiant Dolibarr) ; qui envoie l'avis d'une facture au client (ADR 038,
  `invoice_issued`, `invoice_reminder`).
- `CLAUDE.md` (Facturation) et `docs/roadmap.md` (D11) sont mis à jour.

## Tests

`ressources/produits.test.ts` (chaque type dans un seul produit),
`(admin)/nav-actif.test.ts` (l'entrée allumée suit le produit filtré, dans
toutes les vues du planning), `lib/auth/permissions.test.ts` (aucun rôle n'a
la facturation, l'exploitant a tout le reste), `api/maintenance/facturation/
facturation.test.ts` (le lot planifié répond 410 et ne prépare rien).
