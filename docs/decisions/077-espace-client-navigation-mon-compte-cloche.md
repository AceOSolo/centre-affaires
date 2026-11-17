# ADR 077 — Espace client : onglets, « Mon compte », cloche des nouveautés, pages de connexion

**Date** : 2026-11-17
**Statut** : accepté — recette du 17/11/2026, lot 4 (`docs/recette/2026-11-17.md`) ;
complète l'ADR 015 (espace client), l'ADR 038 (moteur de notifications : le
journal des messages nourrit la cloche du client, les préférences sont rangées
par service), les ADR 059 et 070 (une cloche pour le client, sur le modèle de
celle de l'équipe) et l'ADR 068 (comptes) ; une migration (tables
`client_notification_reads` et `client_bell_settings`, colonne
`client_members.phone`) ; règles `src/db/regles/74-cloche-client.sql`, code
`CA023`. Les choix marqués « à confirmer en recette » ont été tranchés par
défaut, le responsable produit étant absent.

## Contexte

Notes de recette du 17/11 confiées au lot 4 :

1. « Mini barre de défilement dans l'espace client, en face de « Accueil »
   « Réservations » ».
2. « Un compte connecté n'a pas accès aux pages de connexion ».
3. « Préférences / paramètres : pas très logique, à ranger selon les demandes
   et commandes du client ».
4. « Espace client : une cloche de notifications ».
5. « Espace client : le nombre de courriers indiqué d'emblée (un « +1 » par
   exemple) ».

Constats :

- `compte-nav.tsx` posait `sm:overflow-x-auto` sur la barre d'onglets, et
  chaque onglet descendait d'un pixel sur la bordure du bas (`sm:-mb-px`) pour
  la recouvrir de son trait. Ce pixel débordait de la barre ; comme
  `overflow-x: auto` rend aussi `overflow-y` défilant, une petite barre de
  défilement verticale apparaissait en face des onglets.
- `/auth/connexion`, `/auth/equipe` et `/auth/mot-de-passe-oublie`
  s'affichaient à une personne connectée, qui pouvait s'y reconnecter avec un
  autre compte sans s'être déconnectée.
- `/compte/preferences` montrait les sept catégories de messages à tout le
  monde, courrier compris pour qui n'est pas domicilié, et rien sur le compte
  lui-même (nom, téléphone, mot de passe).
- L'espace client n'avait aucune cloche ; le nombre de plis non lus n'était
  dit que sur l'accueil (« 2 plis non lus »), pas sur l'onglet « Courrier ».

## Décision

### 1. Onglets sans barre de défilement parasite

Le trait gris du bas de la barre devient une **ombre intérieure** de la barre
(`shadow-[inset_0_-1px_0_var(--border)]`) ; l'onglet actif pose son trait de
2 px par-dessus, sans marge négative. La barre garde `overflow-x-auto` — des
onglets trop nombreux défilent toujours de côté — et prend
`overflow-y-hidden` : rien ne peut plus déborder en hauteur. Vérifié sur la
source (`compte-nav.test.ts`). Rien ne change sur téléphone (grille).

### 2. Connecté, plus de page de connexion

- `/auth/connexion`, `/auth/equipe` et `/auth/mot-de-passe-oublie` relisent
  la session (et non la seule présence du cookie : un cookie périmé laisse la
  page s'afficher, sans boucle) et renvoient la personne connectée
  (`destinationSiConnecte`, `src/app/(auth)/deja-connecte.ts`) :
  - vers le chemin demandé (`?redirect=`, que pose `proxy.ts`) s'il est sûr
    (`safeRedirect`) et hors de `/auth` — la page visée revérifie les droits ;
  - sinon vers son espace : depuis la page des clients, `/compte` d'abord ;
    depuis celle de l'équipe, `/aujourdhui` d'abord ; une personne à la fois
    cliente et membre de l'équipe va vers l'espace de la page ouverte ;
  - un compte qui n'ouvre rien va à « Accès refusé », qui le dit et propose
    de se déconnecter pour changer de compte.
- **Restent ouverts** : `/auth/acces-refuse`, `/auth/suite` (l'aiguillage),
  la déconnexion, et `/auth/nouveau-mot-de-passe` — le lien d'une invitation
  ou d'un mot de passe oublié. Connecté, cette page **dit ce qui se passe** :
  - lien de son propre compte (lu dans la table de vérification de Better
    Auth, `reset-password:<jeton>`) : « une fois le mot de passe enregistré,
    vos sessions se ferment » ;
  - lien d'un autre compte : « ce lien concerne un autre compte ; pour entrer
    ensuite avec lui, vous vous déconnecterez d'abord », et « Se connecter »
    devient une déconnexion qui mène à la page de connexion ;
  - lien périmé : demander un nouveau lien passe d'abord par la déconnexion.
- Un client change son mot de passe, connecté, dans « Mon compte » (§ 3) ;
  qui a oublié l'actuel se déconnecte puis choisit « Mot de passe oublié ? ».

### 3. « Mon compte », séparé des notifications

Le lien « Préférences » de la coque devient **« Mon compte »**, en deux pages
reliées par une petite navigation (`aria-current`) :

- **Mes informations** (`/compte/mon-compte`) :
  - **prénom et nom** (obligatoire) et **téléphone** (facultatif, mis en
    forme par `normalisePhone` comme les contacts), écrits sur chacun des
    accès de la personne (`client_members.full_name`, nouvelle colonne
    `client_members.phone`) et, pour le nom, sur son compte Better Auth (le
    « Bonjour » de l'accueil). L'équipe voit le téléphone sur la fiche du
    client, sous le nom de l'accès ;
  - **adresse électronique** affichée, non modifiable : c'est l'identifiant
    du compte **et** la clé qui le rattache aux entreprises (ADR 015) ;
  - **mot de passe** : actuel, nouveau, confirmation, par le client
    d'authentification (`change-password`), qui vérifie l'ancien et ferme les
    autres sessions ;
  - les entreprises du compte, et à qui s'adresser pour un autre accès.
- **Mes notifications** (`/compte/preferences`, adresse gardée : les
  courriels y renvoient) : les préférences de l'ADR 038, **rangées par
  service** (`preferences-groupes.ts`) — Courrier (domicilié : courrier,
  avis « pas de courrier »), Réservations (s'il en a), Contrats, États des
  lieux, Factures (s'il en a), et Informations du centre pour tous. Seuls
  les groupes utiles s'affichent, avec un titre et une phrase. Un groupe
  caché **garde son réglage** : le formulaire déclare les cases montrées et
  l'action n'écrit qu'elles (`mergeShownPreferences`).
- Téléphone **effacé à l'anonymisation** de l'accès : un trigger de
  `74-cloche-client.sql` le vide dans la même écriture que les routines de
  l'ADR 040, sans les modifier ; la contrainte
  `client_members_anonymized_no_phone` le vérifie.

### 4. La cloche du client

**Ce qui la nourrit : le journal des messages** (`notification_deliveries`,
ADR 038). Chaque message adressé à l'entreprise y a déjà sa ligne, quelle
qu'ait été l'issue du courriel (envoyé, modèle désactivé, personne qui a
renoncé à la catégorie, SMTP absent) : la cloche ne dépend donc pas du
courriel, comme celle de l'équipe (ADR 059), et n'oblige à toucher aucun
déclencheur. Elle retient les messages `audience = 'client'` des entreprises
du compte, de ces natures (`clientBellEvents`, `cloche-client.ts`) :

| Nouveauté | Événement | Mène à |
|---|---|---|
| Courrier reçu | `mail_batch_received` (fin de tournée), `mail_received` | la boîte, ou le pli |
| Numérisation prête | `mail_scanned` | la fiche du pli |
| Demande de courrier traitée / refusée | `mail_request_done`, `mail_request_refused` | la fiche du pli de la demande |
| Demande de réservation acceptée / refusée | `booking_request_accepted`, `booking_request_refused` | « Mes réservations », à la réservation |
| Réservation confirmée / annulée | `booking_confirmed`, `booking_cancelled` | idem |
| Contrat activé | `contract_activated` | « Contrats », au contrat |
| État des lieux à valider | `inspection_to_sign` | l'état des lieux |
| Message du centre | `client_broadcast` | la nouvelle page `/compte/messages/[id]` |

Écartés : `mail_none` (un avis quotidien, pas une nouveauté),
`member_invited` (la personne n'est pas encore là), `invoice_issued` et
`invoice_reminder` (facturation du site en sommeil, ADR 046 ; les factures
de Dolibarr sont au lot 8).

- **Chaque ligne** : la nouveauté, l'objet du message tel qu'il est parti (ou
  serait parti) — déjà au journal, rien n'est recopié —, l'entreprise quand
  le compte en a plusieurs, le moment (« il y a 12 min », à l'heure du
  centre), « Non lue » écrit en toutes lettres en plus du fond. Les vingt
  plus récentes.
- **Lu, personne par personne** (`client_notification_reads`) : une
  nouveauté ouverte depuis la cloche est marquée lue pour la personne seule,
  au titre de l'accès de l'entreprise du message ; « Tout marquer comme lu »
  pour la période. La pastille dit le nombre de non lues (« 99+ »), juste dès
  le rendu de la coque.
- **Rafraîchissement** : `GET /api/compte/notifications` toutes les minutes
  quand l'onglet est visible, à chaque navigation et à l'ouverture du
  panneau ; marquer lu passe par des actions serveur. Pas de websocket, pas
  de dépendance.
- **À l'écran** : en haut de l'espace, au bout de la ligne de l'entreprise,
  cible de 44 px ; panneau qui s'ouvre vers la gauche, sans dépasser l'écran
  à 375 px ; clavier : `aria-expanded`, `aria-controls`, Échap referme et
  rend le focus, compteur annoncé poliment. État vide : ce qui s'affichera.
  Lien « Choisir les courriels que je reçois » vers les notifications.
- **Réglable par centre** (règle commune de la recette : rien d'écrit en dur)
  dans Réglages > « Cloche de l'espace client »
  (`/notifications/cloche-client`, droit `notifications.gerer`, celui des
  modèles des messages) : les nouveautés annoncées — une case par nature,
  toutes cochées par défaut — et la durée pendant laquelle une nouveauté
  reste dans la cloche, **30 jours par défaut**, de 1 à 90. Le réglage garde
  les natures **retirées**, pas celles montrées : une nature ajoutée plus
  tard au code paraît d'elle-même. Une ligne par centre
  (`client_bell_settings`), sans suppression.
- **La base** (`74-cloche-client.sql`, `CA023`) refuse une lecture qui ne
  vise pas un message au client de l'entreprise de l'accès, une lecture
  réécrite (autre message, autre personne), un effacement depuis l'espace,
  et la suppression du réglage ; sous portée client, une écriture hors des
  entreprises du compte (`CA015`) et tout réglage (erreur 1142).
- **Conservation** : les lectures partent avec leur ligne du journal, par la
  clé étrangère en cascade, au terme de
  `tenants.notification_log_retention_months` ; rien de plus à purger.

### 5. Le nombre de courriers d'emblée

Une **pastille** sur l'onglet « Courrier » : le nombre de plis non lus de la
personne, en chiffres, et en toutes lettres pour un lecteur d'écran
(« 3 nouveaux courriers ») ; tenue à jour avec la cloche, la coque de
l'espace n'étant pas recalculée d'une page à l'autre. Sur l'accueil, la
carte « Courrier » porte « 3 nouveaux courriers » à côté de son titre, et
l'encart « à voir » dit la même phrase. Le compte vient d'une fonction à part
(`countMailForAccounts`, `courrier/non-lus.ts`) : un pli non lu est un pli
sans classement ou sans `read_at` pour la personne (ADR 044), retiré exclu.

## Choix par défaut (à confirmer en recette)

1. **Ce qui nourrit la cloche** : le journal des messages, natures du tableau
   du § 4, trente jours.
2. **« Lu » à l'ouverture depuis la cloche** seulement : lire le pli depuis
   la boîte ne marque pas la nouveauté « Courrier reçu ». Le faire
   toucherait les pages du courrier (lot 5) ; possible ensuite.
3. **Une cloche pour toute l'entreprise** : un message adressé à une seule
   personne (la réponse à sa demande) paraît dans la cloche de chaque
   personne de l'entreprise, qui voit déjà ce courrier ou cette réservation.
4. **L'adresse électronique ne se change pas depuis l'espace** : elle se
   change par l'accueil (§ 3).
5. **Prénom et nom en un seul champ**, comme le compte et l'accès les
   gardent ; « Bonjour » prend le premier mot.
6. **Groupes de préférences communs à toutes les entreprises du compte** :
   un gérant de deux sociétés voit, pour chacune, les groupes des services
   utilisés par l'une ou l'autre.
7. **Lien « Réglages »** rangé provisoirement sous « Équipe et
   configuration », service **« Tous les services »** : le lot 9 range
   Réglages par service.
8. **Connecté, la page de connexion suit le chemin demandé** (`?redirect=`)
   avant l'espace par défaut.

## Écarts et contradictions

- **Lu / non lu, abandonné pour l'équipe par l'ADR 070, gardé pour le
  client** : la cloche de l'équipe est une liste de travail (une demande
  attend), celle du client un fil de nouveautés (quelque chose est arrivé) ;
  un client n'a rien à « traiter ». Pas de contradiction avec l'ADR 070, qui
  ne vaut que pour l'équipe.
- **Pas de suppression physique** (`CLAUDE.md`, décision 6) : les lectures
  ne sont pas des entités métier ; elles partent avec la ligne du journal
  qu'elles marquent, purgée comme le prévoit déjà l'ADR 038.
- **« Mon compte : … adresse électronique »** (recette) : affichée, pas
  modifiable (choix 4). La modifier depuis l'espace, avec confirmation à la
  nouvelle adresse, demanderait de déplacer en même temps les accès
  (`client_members.email`) : à décider en recette.
- **Astérisques** : le composant commun du lot 1 n'existait pas dans la copie
  du lot ; les formulaires du lot (Mon compte, mot de passe, réglage de la
  cloche) portent un astérisque local (`aria-hidden`), `required`,
  `aria-required` et la phrase « Les champs marqués * sont obligatoires ».
  À remplacer par le composant du lot 1 à la fusion. Les formulaires de
  connexion, revus par le lot 1, ne sont pas touchés ici.

## Alternatives écartées

- **Une table de notifications du client, écrite par chaque déclencheur**
  (comme `staff_notifications`, ADR 059) : une copie de plus du journal, et
  tous les déclencheurs à modifier ; le journal a déjà chaque message, son
  entreprise, sa nature et son entité.
- **Lire la cloche dans les sources** (comme l'ADR 070 pour l'équipe) :
  réservations, contrats et messages n'ont pas d'état « lu » ; il en
  faudrait un par table.
- **Marquer lu à l'affichage de la page visée** par une route `GET` qui
  marque puis redirige : un lien préchargé par le navigateur la marquerait
  sans clic.
- **Le téléphone sur le compte Better Auth** : hors des tables métier, sans
  `tenant_id`, et hors des routines d'anonymisation ; sur l'accès, l'équipe
  le voit sur la fiche et l'anonymisation l'efface.
- **Websocket** : exclu comme pour l'équipe (ADR 059).

## Conséquences

- Migration de structure : `client_notification_reads`,
  `client_bell_settings`, `client_members.phone` et sa contrainte. Gardes de
  centre générées par le migrateur. Règles `74-cloche-client.sql` (nouveau
  fichier, aucun fichier de règles existant modifié). `DB_CLIENT_BELL_REFUSED`
  (`CA023`) dans `src/db/errors.ts`.
- Aucun nouvel événement de notification, aucun nouveau droit.
- Nouvelles pages : `/compte/mon-compte`, `/compte/messages/[id]`,
  `/notifications/cloche-client` (back-office) ; route
  `/api/compte/notifications`.
- Raccords à la fusion des lots du 17/11 :
  - lot 2 (pièces justificatives) : une pièce refusée est une nouveauté —
    ajouter son événement à `clientBellEvents`, son libellé, sa description
    et son lien (`clientBellHref`) ; sa rubrique s'ajoute dans
    `espace-rubriques.ts` ;
  - lot 5 (« ignorer » un pli) : exclure peut-être les plis ignorés de
    `countMailForAccounts` ;
  - lot 8 (factures de Dolibarr) : le groupe « Factures » des préférences et
    l'onglet suivent `invoices` (tables du site, en sommeil) ; à rebrancher
    sur les factures reçues, et un éventuel événement « facture disponible »
    à ajouter à la cloche ;
  - lot 9 (Réglages par service) : « Cloche de l'espace client » relève de
    « Tous les services » ;
  - lot 1 (astérisques) : composant commun.
- Tests : `cloche-client.test.ts` (natures, liens, lignes, réglage),
  `cloche-client.db.test.ts` (journal, lu par personne, réglage, `CA023`,
  purge, plis non lus, « Mon compte », anonymisation, message du centre),
  `preferences-groupes.test.ts`, `mon-compte.test.ts`,
  `deja-connecte.test.ts`, `compte-nav.test.ts`, `espace-rubriques.test.ts`,
  `cibles-tactiles.test.ts`.
