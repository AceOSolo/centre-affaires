# ADR 068 — Des comptes créés par invitation ou après une demande du site

**Date** : 2026-11-05
**Statut** : accepté — revient sur l'ADR 045 (inscription libre fermée ; la
gestion des comptes, le bannissement et la fiche « inscrite en ligne »
restent) ; complète l'ADR 054 (l'écran Équipe envoie l'invitation) et
l'ADR 059 (même lien d'invitation, pour l'équipe et les demandeurs) ; choix
tranchés par la direction le 05/11/2026 ; migration 0015

## Contexte

Demande de la direction (05/11/2026) :

1. la direction invite par courriel, avec un rôle d'administration ou de
   client ; les administrateurs invitent aussi des clients ; la personne
   reçoit un lien pour créer son compte ;
2. un visiteur qui fait une demande sur le site donne son adresse : il
   reçoit un lien pour créer son compte et y retrouver sa demande.

État des lieux avant cet ADR :

- **Client invité depuis sa fiche** : en place (ADR 059), lien de sept jours
  pour choisir son mot de passe, renvoi, état sur la fiche. Mais il faut
  d'abord une fiche.
- **Équipe** : la direction et les exploitants inscrivent une adresse
  (ADR 054), **sans courriel** : la personne devait aller seule créer son
  compte sur `/auth/equipe`, puis confirmer son adresse.
- **Demande du site** : le centre est prévenu, le demandeur ne reçoit rien.
  S'il crée un compte ensuite, sa fiche « inscrite en ligne » est vide : sa
  demande, sans entreprise, n'y est pas rattachée.
- **Inscription libre** (ADR 045) : n'importe qui crée un compte sur la page
  de connexion et reçoit une fiche prospect vide.

Questions posées le même jour, réponses de la direction : **fermer
l'inscription libre** ; **ajouter un formulaire rapide** pour inviter un
client d'une adresse, sans passer d'abord par une fiche.

## Décision

### 1. Plus d'inscription libre

Un compte naît d'une invitation (équipe, espace client) ou d'une demande du
site, toujours par un lien parti à son adresse (`lib/auth/invitation.ts`).

- Better Auth : `emailAndPassword.disableSignUp`. `/api/auth/sign-up/email`
  refuse tout appel (`EMAIL_PASSWORD_SIGN_UP_DISABLED`) ; il sort de la
  preuve ALTCHA et des plafonds, devenus sans objet.
- Les pages de connexion n'ont plus de mode « Créer un compte ». Côté
  clients, elles disent quoi faire sans compte : une demande depuis le site,
  ou l'accès demandé à l'accueil. Côté équipe : ouvrir le lien reçu.
- `companyName` reste sur le compte, posé par le code et plus saisi
  (`input: false`) : la raison sociale d'un demandeur nomme sa fiche.
- L'amorçage, qui reposait sur l'inscription, passe par un lien :
  `infra/ajouter-membre-staff.mjs` l'affiche (`--lien` pour en refaire un),
  comme `seed-demo.mjs` pour les comptes de démonstration
  (`infra/lien-invitation.mjs`, même jeton que l'application).

### 2. Le moteur écrit à une personne seule

Troisième audience, `person` : une adresse donnée par l'appelant, sans
entreprise ni préférence — un membre de l'équipe invité, un demandeur du
site. Deux événements, journalisés comme les autres, modèles éditables :

| Événement | Quand | Variables propres |
|---|---|---|
| `staff_invited` | membre ajouté à l'équipe, invitation renvoyée | `role`, `lien`, `echeance`, `connexion` |
| `request_received` | demande déposée sur la page publique par un visiteur | `demande`, `numero`, `lien`, `echeance`, `connexion` |

Le journal porte `audience = person`, sans `client_id` ; `related_type`
gagne `staff_member`. Classés dans `notification_event_audience()` et
`notification_event_category()` (aucune catégorie : ils partent toujours).

### 3. L'équipe reçoit son invitation

- Ajouter un membre (`addTeamMemberAction`) lui envoie le lien, valable sept
  jours, qui mène au choix du mot de passe aux textes de l'équipe
  (`?invitation=1&espace=equipe`), puis à `/auth/equipe`.
- Une personne qui a déjà un mot de passe (elle est aussi cliente) le garde :
  le message l'invite à s'en servir, sans lien.
- L'écran Équipe dit où en est chaque invitation, avec les règles de la fiche
  client (`invitation-etat.ts`) : invitée jusqu'au …, expirée, non envoyée,
  compte activé. « Renvoyer l'invitation » tant que la personne ne s'est pas
  connectée, sous la règle des autres actions de la ligne : on ne touche
  qu'un membre dont on peut donner le rôle (ADR 054).

### 4. Inviter un client d'une adresse

Écran Comptes, section « Inviter un client », droit `clients.gerer` (celui
qui donne déjà l'accès depuis la fiche : accueil, exploitant, direction) :
adresse, nom et entreprise facultatifs. Une fiche prospect
(`origin = back_office`) et l'accès sont créés ensemble, puis l'invitation
de l'ADR 059 part. Sans entreprise, la fiche porte le nom de la personne, à
défaut son adresse. Une adresse qui a déjà un accès en cours n'en reçoit pas
un second : le message mène à sa fiche. Un client reste toujours rattaché à
une entreprise : c'est ce qui borne ce qu'il voit (ADR 019).

### 5. Demande du site : accusé de réception, puis espace

- **Accusé** : toute demande d'un visiteur non connecté (salle, bureau,
  camion, matériel, domiciliation) lui vaut `request_received`, après la
  réponse. Connecté à son espace, il voit déjà sa demande : rien ne part.
- **Lien offert** seulement à une adresse sans lien avec le centre : ni
  accès à une entreprise ni place dans l'équipe (même retirés), pas de
  compte avec mot de passe, pas de compte suspendu. C'est exactement
  l'adresse qui recevra sa propre fiche à la première entrée
  (`ensureSignupClient`, ADR 045). Le compte est créé à ce moment, sans mot
  de passe, avec le nom et la raison sociale donnés. Les autres reçoivent
  l'accusé seul : « l'équipe vous répond ; connectez-vous d'abord pour vos
  prochaines demandes ».
- **Première entrée** : choisir son mot de passe confirme l'adresse
  (ADR 059) ; la fiche prospect « inscrite en ligne » naît, au nom de la
  raison sociale, et reçoit les demandes du site faites à cette adresse et
  restées sans entreprise (`attachSiteRequests`) :
  - toutes les réservations, refusées comprises, sauf celles dont le
    demandeur a été anonymisé ; les principales d'abord, puis leur matériel
    en option, qui doit être au nom du client de sa principale (`CA018`) ;
  - les devis **brouillons** seulement : un devis validé ne change plus de
    destinataire (`CA016`), Dolibarr reprend ce que le centre a validé.
- **Dans l'espace** : les réservations sont dans « Mes réservations » ; une
  demande de domiciliation, qui n'est qu'un devis (ADR 043), a sa carte sur
  l'accueil de l'espace tant qu'elle est ouverte (référence, date, « en cours
  d'étude » ou « devis envoyé »).

## Justification

- **Fermer l'inscription** supprime les fiches prospects vides créées par des
  inconnus ou des robots, et la case anti-robot de la connexion. Tout chemin
  légitime reste ouvert : le visiteur fait une demande, le client est
  invité.
- **Un seul lien pour tous** (celui du mot de passe oublié de Better Auth,
  sept jours) : vérification, expiration, usage unique, confirmation de
  l'adresse sont déjà éprouvés (ADR 059). Pas de jeton maison.
- **Une audience `person`** plutôt que détourner `client` (qui exige une
  entreprise) ou envoyer hors du moteur : le message reste modifiable par le
  centre et journalisé.
- **Rattacher à la première entrée seulement**, l'adresse confirmée :
  quiconque peut taper une adresse dans le formulaire public ; seule la
  personne qui la reçoit voit les demandes faites en son nom. Le lien n'est
  pas offert à une adresse déjà connue, pour ne pas glisser une demande d'un
  inconnu dans l'espace d'une entreprise existante.

## Alternatives écartées

- **Garder l'inscription libre** à côté des invitations : écarté par la
  direction.
- **Rattacher aussi, à chaque connexion, les demandes d'un compte qui a déjà
  une entreprise** : un inconnu qui tape l'adresse d'un client glisserait une
  demande dans l'espace de cette entreprise. L'équipe la rattache à la
  validation, comme avant.
- **Créer la fiche dès la demande** : une adresse inventée remplirait la
  liste des clients (même raison que l'ADR 045).
- **Rattacher un devis validé** en levant `CA016` : Dolibarr a pu reprendre
  le tiers du demandeur ; le changer après coup les désaccorderait.
- **Un formulaire d'invitation de client sans fiche** : un client sans
  entreprise ne voit rien (ADR 019) ; la fiche est créée avec lui.

## Conséquences

- Migration 0015 : valeurs `staff_invited` et `request_received` de
  `event`, `person` de `audience`, `staff_member` de `related_type`
  (`notification_deliveries`, `notification_templates`). Règles
  `70-notifications.sql` rejouées. Aucun nouveau code `CAnnn`.
- **Sans SMTP, plus personne ne crée de compte** hors du script d'amorçage
  (`infra/serveur/README.md` § 5 et § 8). En développement, Mailpit
  (ADR 059) montre les liens.
- Les comptes déjà créés par l'inscription libre restent, avec leur fiche.
- La bascule « Inscrits en ligne » (`/clients?origine=inscription`) isole
  désormais les demandeurs du site qui ont créé leur espace.
- Tests : `demandes-site.db.test.ts` (accusé et lien, compte sans mot de
  passe, première entrée, rattachement, devis validé laissé, carte de
  domiciliation, adresses connues), `equipe-invitation.db.test.ts` (lien de
  l'équipe jusqu'à la première connexion, mot de passe existant, membre
  retiré, inscription refusée), `invitation-rapide.db.test.ts`.
