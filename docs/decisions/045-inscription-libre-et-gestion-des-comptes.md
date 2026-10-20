# ADR 045 — Inscription libre sur le site et gestion des comptes par l'équipe

**Date** : 2026-10-20
**Statut** : accepté — revient sur la règle « avoir un compte ne donne accès à
rien » des ADR 008 et 015 pour l'espace client ; le back-office n'est pas
concerné ; les choix marqués « à valider » attendent le centre

## Contexte

Jusqu'ici, créer un compte sur la page de connexion ne donnait aucun droit
(ADR 008, ADR 015). Seule une adresse inscrite au préalable par l'équipe —
dans l'équipe (`staff_members`) ou sur une fiche client (`client_members`) —
ouvrait un espace. Toute autre adresse tombait sur « Accès refusé ».

Le centre veut l'inverse pour sa clientèle : **n'importe qui crée son compte
seul sur le site**. L'équipe, elle, garde la main sur les comptes créés : elle
peut les **bannir** (pour toujours ou jusqu'à une date), les **réactiver** et
les **rattacher** à une entreprise existante.

La difficulté : l'espace client montre des documents sensibles d'une
entreprise — scans de courrier, factures, contrats. Une inscription libre ne
doit jamais ouvrir les documents d'une entreprise à quelqu'un qui n'en relève
pas.

## Décision

### Une inscription libre reçoit sa propre fiche client

Une personne qui s'inscrit sans avoir été inscrite par le centre reçoit **sa
propre fiche client** : un prospect marqué « inscrit en ligne »
(`clients.origin = 'inscription'`). Elle entre dans l'espace client de cette
fiche, vide au départ, et peut y faire des demandes de réservation, que
l'accueil valide (réglage `approval` par défaut, ADR 036). La portée client
(ADR 019) ne change pas : elle ne voit que sa fiche.

- **Quand.** À la première page de l'espace qui suit la confirmation de
  l'adresse (`clientAccess`, `modules/comptes/inscription.ts`), jamais avant :
  une adresse inventée ne remplit pas la liste des clients. En développement,
  où aucune adresse n'est confirmée (`AUTH_SKIP_EMAIL_VERIFICATION`), la fiche
  est créée à la première connexion.
- **Ordre.** Les inscriptions faites par le centre à cette adresse sont
  rattachées d'abord (`resolveClientAccounts`). Une personne invitée retrouve
  son entreprise, pas une fiche vide.
- **Une seule fois.** Rien n'est créé quand le compte a déjà eu un lien avec
  le centre, même retiré : accès à une entreprise, en cours ou retiré, ou place
  dans l'équipe, en cours ou passée. Un accès retiré par l'équipe ne renaît
  pas sous une fiche neuve. Le compte est verrouillé (`FOR UPDATE`) le temps de
  la vérification : deux premières requêtes simultanées ne créent pas deux
  fiches.
- **Raison sociale.** Le formulaire d'inscription demande l'entreprise,
  facultative (« laissez vide si vous louez en votre nom propre »). Elle est
  gardée sur le compte (`auth_users.company_name`, champ additionnel de Better
  Auth) jusqu'à la création de la fiche. Sans elle, la fiche porte le nom de la
  personne, à défaut son adresse.

Le back-office ne change pas : seul `staff_members` y donne accès (ADR 008).

### Le bannissement est une ligne du centre, pas un drapeau sur le compte

Table `account_bans` (`tenant_id`, `auth_user_id`, motif, terme facultatif
`banned_until`, auteur, levée `lifted_at` / `lifted_by`). Le compte
(`auth_users`) n'a pas de centre : en multi-centres, un centre ne doit pas
fermer un compte aux autres (décision 1). Une ligne par bannissement, jamais
supprimée (décision 6) : la levée la clôt, l'historique reste lisible.

Un bannissement est **en vigueur** tant qu'il n'est pas levé et que son terme,
s'il en a un, n'est pas passé. Bornes `[)` comme les réservations : « jusqu'au
11 inclus » se stocke en terme au 12 à 0 h, heure du centre, en UTC.

Effet :

- **Immédiat.** Les sessions ouvertes du compte sont supprimées dans la
  transaction du bannissement : la page suivante renvoie à la connexion.
- **Durable.** Un hook de Better Auth (`databaseHooks.session.create.before`,
  `lib/auth/server.ts`) refuse d'ouvrir une session à un compte banni dans le
  centre courant (`BANNED_USER`). La personne lit « compte suspendu, contactez
  l'équipe », jamais le motif.

Règles (`banAccounts`) : on ne se bannit pas soi-même ; on ne bannit pas un
membre de l'équipe — sa porte est l'écran Équipe, et un exploitant banni par
erreur ne pourrait plus rien réparer ; on ne superpose pas deux bannissements
en vigueur. Un lot de comptes est traité compte par compte : les refus sont
listés, les autres sont bannis.

### L'écran « Comptes »

`/comptes`, dans la catégorie Administration du back-office, sous un nouveau
droit `comptes.gerer`, **réservé à l'exploitant** (*à valider* : l'accueil
pourrait rattacher sans pouvoir bannir).

- Liste des comptes du centre — et de ceux qui ne relèvent encore d'aucun
  centre : adresse pas encore confirmée —, avec date d'inscription, adresse
  confirmée ou non, équipe ou entreprises, état (texte et icône, jamais la
  seule couleur). Filtre par état, recherche par nom ou adresse, plafond de 200
  lignes.
- Sélection multiple : bannir ou réactiver plusieurs comptes d'un coup.
- Fiche d'un compte (`/comptes/[id]`) : bannir ou réactiver, rattacher à une
  entreprise existante, historique des bannissements (qui, quand, motif,
  durée, levée).

**Rattacher** ajoute une personne sur la fiche choisie (`client_members`), déjà
reliée au compte. La fiche créée à l'inscription **reste** : elle porte
peut-être des demandes. L'équipe l'archive depuis la fiche client si elle n'a
plus lieu d'être (*à valider* : l'archiver d'office quand elle est vide).

### Correctif lié

En développement, `AUTH_SKIP_EMAIL_VERIFICATION` ne confirme aucune adresse :
`emailVerified` valait `false` et fermait tout rattachement, y compris celui
des comptes de démonstration. `sessionUser` ne le transmet plus quand le
serveur n'exige pas la vérification, ce qui n'arrive jamais en production.

## Justification

- **Une fiche par inscription** réutilise tout l'espace client existant
  (réservation, demandes d'offre, historique), sans un second espace « réduit »
  à construire et à protéger. La portée client, éprouvée (ADR 019), garantit
  que la personne ne voit rien d'autre.
- **Créer la fiche après confirmation** garde la liste des clients propre : un
  robot qui s'inscrit avec des adresses inventées ne crée rien.
- **Bannir par centre** respecte la décision 1 et garde l'historique, au lieu
  d'un `banned` booléen sur un compte partagé entre centres.
- **Supprimer les sessions** au lieu de vérifier le bannissement à chaque
  requête : un contrôle de plus par page pour un événement rare n'en vaut pas
  la peine, et l'effet est le même.

## Alternatives écartées

- **Plugin `admin` de Better Auth** (bannissement intégré). Il pose un drapeau
  global sur le compte (pas de centre), ajoute un rôle concurrent de
  `staff_members` et expose des routes `/api/auth/admin/*` gardées par ce
  rôle. Son hook de connexion a servi de modèle au nôtre.
- **Espace réduit sans fiche** (demandes seulement, puis rattachement par
  l'équipe) : un second espace, des demandes sans client, et la même table à
  rattacher ensuite. Écarté par le centre.
- **Ouvrir l'espace client sans fiche** : impossible, toute donnée de l'espace
  est portée par une entreprise.

## Conséquences

- Migration de structure 0003 : `account_bans`, `clients.origin`,
  `auth_users.company_name`. Les gardes d'écriture par centre (`CA014`) et
  `updated_at` sont générées par le migrateur. Aucun nouveau code d'erreur.
- La liste des clients se remplit de prospects inscrits en ligne : la fiche le
  dit (« inscrit en ligne » dans l'écran Comptes). *À valider* : un filtre par
  origine dans la liste des clients.
- Les prospects inscrits en ligne entrent dans l'anonymisation RGPD comme les
  autres (ADR 040) : sans contrat ni échange, ils s'anonymisent au terme de la
  durée des prospects (36 mois par défaut). L'anonymisation détache le compte
  et efface l'adresse : une personne qui revient ensuite reçoit une fiche
  neuve, ce qui est voulu — l'ancienne n'existe plus que sous forme anonyme.
- `/auth/acces-refuse` ne sert plus qu'aux cas restants : accès retiré, ancien
  membre de l'équipe, client sur le back-office.
- Tests : `modules/comptes/regles.test.ts` (état, durée, formulaire),
  `modules/comptes/comptes.db.test.ts` (création unique de la fiche, refus,
  bannissement, sessions fermées, levée, centres séparés, rattachement).

## Révision du 20/10/2026 — espace client d'un membre de l'équipe

Un membre de l'équipe peut aussi être client du centre : il loue, ou veut
voir le portail comme ses clients le voient. Il garde un seul compte.

- **Sur demande seulement.** Le lien « Créer mon espace client » en pied de
  la barre latérale du back-office (`openStaffClientSpaceAction`) lui crée sa
  fiche prospect, d'origine `back_office` : pas une inscription en ligne à
  examiner. `ensureSignupClient(…, { forStaff: true })` saute pour cela
  l'exclusion des membres de l'équipe ; sans l'option, rien ne change. Jamais
  d'office : un membre qui fait une demande de réservation connecté sur le site
  ne se retrouve pas avec une fiche qu'il n'a pas demandée.
- **Ensuite.** Le lien devient « Mon espace client » (`staffHasClientSpace`,
  qui compte aussi une inscription faite à son adresse par le centre). Depuis
  `/compte`, un bouton « Back-office » le ramène à l'équipe.
- Un ancien accès retiré par l'équipe ne renaît toujours pas.
