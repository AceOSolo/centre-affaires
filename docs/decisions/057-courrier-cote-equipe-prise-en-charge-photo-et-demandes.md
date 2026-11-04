# ADR 057 — Courrier côté équipe : « Prendre en charge » sans page d'erreur, la photo du pli, les demandes dans « Demandes »

**Date** : 2026-11-04
**Statut** : accepté — lot 1 de la recette du 04/11/2026
(`docs/recette/2026-11-04.md`) ; complète les ADR 037 (demandes de
courrier), 048 (« Demandes », boîte de réception unique), 050
(« Aujourd'hui ») et 055 (photos du courrier) ; sans migration ni dépendance

## Contexte

Trois notes de la recette du 04/11/2026 sur le courrier, côté équipe :

1. « Prendre en charge la demande » affiche une erreur serveur sur
   www.handfield.fr ;
2. quand un client demande une ouverture, l'équipe n'a ni photo ni repère
   pour savoir quelle lettre ou quel colis ouvrir : la file affichait « Lettre
   — expéditeur non précisé », et la fiche du pli un simple lien vers
   l'enveloppe ;
3. les demandes de courrier (ouverture, numérisation, réexpédition) ne
   remontaient pas dans « Demandes » ni dans son compteur : elles vivaient
   dans `/courrier/demandes`, à part.

## Décision

### 1. « Prendre en charge » : reproduit nulle part, rendu incapable de planter

**Le bug n'a pas été reproduit en local**, sur aucun point d'entrée :

- fiche du pli (`StartRequestButton`), dans le navigateur, sur la base de
  développement ;
- file `/courrier/demandes`, case cochée puis « Prendre en charge la
  sélection » ;
- `/aujourdhui` n'a pas de bouton « Prendre en charge » : sa tuile mène à la
  file ;
- au niveau de la base, sur une base neuve préparée par `npm run db:migrer` :
  le trigger `mail_requests_before_update` existe et pose `started_at`, la
  prise en charge passe pour une ouverture comme pour une numérisation, seule
  et en groupe (tests ci-dessous).

Les règles du courrier (`60-courrier.sql`) n'ont pas changé pour les demandes
depuis le passage à MySQL (15/10). La cause en production reste donc à
constater sur le serveur, dans cet ordre :

1. **les règles de la base n'y sont pas à jour** — un `migrer` oublié ou
   interrompu (le DDL de MySQL n'est pas transactionnel : un fichier de règles
   arrêté à mi-course laisse un trigger supprimé et pas recréé) ; sans le
   trigger, la date de prise en charge manque et le contrôle
   `mail_requests_status_consistent` refuse l'écriture ;
2. une erreur de base imprévue (verrou, interblocage, garde d'un autre
   centre…) qui remontait en page d'erreur ;
3. une page ouverte avant une mise en ligne : ses actions serveur n'existent
   plus sur la nouvelle version (« Failed to find Server Action »).

L'hypothèse 1 a été rejouée sur une base de test, trigger supprimé : la
prise en charge était refusée par le contrôle, et l'écran affichait « Un
refus porte toujours son motif. », un message faux qui a pu être pris pour
une erreur du serveur ; en groupe, la demande passait pour « déjà prise en
charge ». Ce cas est désormais un test de la base
(`demandes-queries.db.test.ts`), qui remet le trigger en place ensuite.

Les commandes pour le constater et le corriger sont dans le message de fin du
lot ; elles reprennent `infra/serveur/README.md` § 4.

Quelle que soit la cause, **aucune de ces erreurs n'aboutit plus à une page
d'erreur du serveur** :

- **Message clair pour chaque refus de la base.** `mailRequestRefusal` dit en
  français les gardes `CA008`, les contraintes, et désormais le verrou ou
  l'interblocage (« réessayez dans un instant »). Le message du contrôle
  `mail_requests_status_consistent` était faux (« Un refus porte toujours son
  motif ») : il dit maintenant que la date n'a pas pu être posée et que les
  règles de la base ne sont peut-être pas à jour.
- **Erreur imprévue journalisée et dite.** Chaque action de traitement d'une
  demande (`demandes-actions.ts`) écrit l'erreur, avec la demande en cause,
  dans le journal du serveur (`docker compose logs app`), et rend « Le serveur
  n'a pas pu enregistrer cette étape : rien n'a été modifié… ». Les
  redirections de Next (session expirée) passent toujours
  (`unstable_rethrow`).
- **Prise en charge groupée sans arrêt.** Une panne sur une demande n'arrête
  plus les autres : elle est comptée en échec (`startMailRequests`) et dite à
  part, en alerte, sous la confirmation (`?echecs=`). Seule une demande
  prise, faite ou annulée entre-temps compte comme « ignorée »
  (`MailRequestError.reason = 'moved'`) ; un refus de la base est un échec,
  journalisé.
- **Filet du back-office.** `src/app/(admin)/error.tsx` remplace l'écran blanc
  de Next par un message, « Réessayer », « Recharger la page », et la
  référence de l'erreur, qui est celle des journaux du serveur. Le menu reste
  affiché.

### 2. Savoir quel pli ouvrir

**La photo de l'enveloppe, en vignette agrandissable** (`EnvelopeZoom`,
`courrier/enveloppe-zoom.tsx`), partout où l'équipe traite une demande :

- dans « Demandes » et dans la file `/courrier/demandes`, sur chaque ligne ;
- en grand sur la fiche du pli.

Un clic (ou Entrée) l'ouvre dans un dialogue natif (`<dialog>`, comme
`ConfirmDialog`) : la page derrière est inerte, Échap ou « Fermer » referme,
le focus revient à la vignette. La grande image n'est demandée qu'à
l'ouverture. Un PDF d'enveloppe s'ouvre dans un nouvel onglet. Sans photo, la
place reste réservée (« Pas de photo »), et la fiche propose de l'ajouter
(ADR 055).

**Consultation journalisée comme les numérisations** (ADR 020) : l'image
passe par la route protégée `/courrier/scans/…`, qui déchiffre le fichier et
inscrit la consultation au journal du pli avant de l'envoyer, sans cache. La
vignette d'une ligne est une consultation ; son agrandissement en est une
autre. Le journal de la fiche le montre.

**De quoi retrouver le pli physiquement**, sur chaque ligne et sur la fiche :
l'entreprise, le type (lettre, recommandé, colis, autre), la date et l'heure
de réception, l'expéditeur s'il est connu, et **le rang du pli dans sa
journée** : « pli 3 sur 5 du 04/11 », « seul pli du 02/11 », l'année en plus
pour une autre année.

Choix du repère : **le rang du jour, calculé, plutôt qu'une référence courte
stockée.** Il se lit avec ce que l'accueil a sous la main — la pile du jour
de l'entreprise, dans l'ordre où les plis ont été saisis — et ne demande rien
de plus à l'enregistrement : une référence courte n'aide à retrouver le pli
que si elle est écrite sur l'enveloppe, un geste de plus par pli. Règle
(`courrier/reperage.ts`, testée) :

- par entreprise, sur les plis reçus le même jour **du centre** (fuseau du
  centre, décision 4 ; un jour de changement d'heure compte 23 ou 25 heures) ;
- dans l'ordre de l'heure de réception, puis de l'identifiant (UUID v7,
  ordonné dans le temps), qui départage les plis d'une même saisie groupée ;
- un pli retiré ne compte pas : il n'est plus dans la pile de l'entreprise.
  Retirer un pli renumérote donc ceux qui le suivent ce jour-là.

Le client voit déjà la date, le type et l'expéditeur dans son espace. Le
rang ne lui est pas encore montré : c'est le même calcul (`findMailSpots`)
si l'on veut le lui afficher pour parler du même pli au téléphone.

### 3. Les demandes de courrier dans « Demandes »

- **Une section « Courrier à traiter »** dans « Demandes », après les
  réservations, avec la pastille **Domiciliation** : les demandes déposées ou
  prises en charge, dans l'ordre d'arrivée (25 au plus ; au-delà, un lien
  mène à la vue filtrée). Elle paraît sous « Tous les produits » et sous la
  pastille Domiciliation, pas sous les autres produits.
- **« Prendre en charge » ligne par ligne**, qui mène à la fiche du pli (là
  où l'on ouvre, numérise ou réexpédie), **et en groupe** (cases à cocher,
  « Prendre en charge la sélection »), qui revient à « Demandes » avec le
  bilan. Les cases sont rattachées au formulaire du groupe par leur attribut
  `form` : chaque ligne garde son propre formulaire, sans formulaires
  imbriqués.
- **Le compteur de « Demandes » les compte** (`inboxCount`), dans le menu
  comme sur la tuile d'« Aujourd'hui » : le même nombre. La tuile du
  courrier d'« Aujourd'hui » en donne la part (« dont 2 demandes de
  courrier ») et mène à « Demandes » filtrée sur la domiciliation. Le
  compteur de « Courrier », dans le rayon Domiciliation, reste : c'est la
  part du rayon.
- **Droits.** Le courrier relève de `courrier.gerer`, le reste de
  `demandes.traiter`. « Demandes » s'ouvre avec l'un des deux
  (`requireAnyPermission`, `demandesPermissions`) et chaque section vérifie
  le sien, comme « Réglages » (ADR 048). Aujourd'hui, tous les rôles ont les
  deux.
- **Une seule « Demandes »** (ADR 048, ADR 053). `/courrier/demandes` reste,
  comme **vue filtrée** sur le courrier, historique compris (faites,
  refusées, annulées), par nature et par client : pas d'entrée au menu, elle
  allume « Demandes » (`also`) et y ramène (« ← Demandes »). `menu.test.ts`
  vérifie qu'il n'y a qu'une entrée « Demandes » et que la file du courrier
  l'allume.

Le tableau de la file est un seul composant (`MailRequestQueue`,
`courrier/demandes-file.tsx`) pour « Demandes » et pour la vue filtrée.

## Justification

**Rendre l'erreur impossible à l'écran plutôt que deviner sa cause.** Sans
accès au serveur, la cause du bug ne se prouve pas d'ici. Ce qui est sûr :
toute erreur de base dite en français, toute erreur imprévue écrite au
journal avec sa demande, et le filet du back-office, transforment un écran
blanc en un message qui dit quoi faire et une trace qui dit pourquoi.

**Le rang du jour plutôt qu'une référence.** Voir § 2 : il ne demande aucun
geste de plus à l'enregistrement, ni colonne, ni migration.

**Une boîte de réception, une vue filtrée.** L'ADR 048 a fait de « Demandes »
la seule boîte de réception ; le courrier en était la seule file à part. Le
garder dans une vue filtrée conserve l'historique et les filtres propres au
courrier sans répéter d'entrée au menu.

## Alternatives écartées

- **Une référence courte stockée** (« C-0411-03 ») : une colonne, une
  migration, et un geste de plus par pli pour l'écrire sur l'enveloppe.
- **Ouvrir la photo dans un nouvel onglet seulement**, comme dans l'espace
  client : l'accueil perd la file à chaque pli. Le lien reste dans le
  dialogue.
- **Supprimer `/courrier/demandes`** : l'historique des demandes du courrier
  (faites, refusées, annulées) et ses filtres n'ont pas leur place dans une
  boîte de réception.
- **Retirer la tuile du courrier d'« Aujourd'hui »** : elle disait aussi ce
  qui attend la domiciliation ; elle devient la part du courrier dans
  « Demandes ».

## Conséquences

- La fiche du pli et les deux files montrent la photo, le type, l'expéditeur,
  la réception et le repère ; chaque affichage d'une photo est inscrit au
  journal du pli.
- Le compteur de « Demandes » grossit des demandes de courrier en cours.
- Après une mise en ligne, `docker compose run --rm migrer` reste
  indispensable (`infra/serveur/README.md` § 4) : c'est lui qui recrée les
  triggers du courrier.
- Tests : `reperage.test.ts` (rang, jour du centre, changement d'heure,
  libellé), `demandes-refus.test.ts` (messages des refus de la base, bilan de
  la prise en charge groupée), `journee.test.ts` et `menu.test.ts`
  (compteur, tuile, une seule « Demandes »), `demandes-queries.db.test.ts`
  (prise en charge d'une ouverture, prise en charge groupée, règles absentes,
  photo et repère sur une base réelle).
- Au passage : l'enveloppe du tableau de la file est `relative`, pour que
  son libellé `sr-only` « Action » (positionné en absolu) ne fasse plus
  défiler la page de côté sur un écran étroit.
