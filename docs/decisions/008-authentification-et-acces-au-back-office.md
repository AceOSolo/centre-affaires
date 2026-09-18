# ADR 008 — Authentification et accès au back-office

**Date** : 2026-09-18
**Statut** : accepté

## Contexte

Jusqu'ici l'application n'avait aucune authentification. Le centre était le seul
utilisateur, l'outil tournait en local, et `currentTenantId()` renvoyait le
centre unique en dur. Le risque était théorique.

L'ADR 005 a ouvert une page publique de réservation. À partir de là, le même
déploiement sert des visiteurs anonymes et des écrans de gestion — ressources,
clients, contrats, grilles tarifaires, demandes à valider — accessibles à qui
connaît l'URL. Ce n'est plus théorique.

`CLAUDE.md` prévoit better-auth. Le projet est hébergé sur Neon, et `neon.ts`
déclare déjà `auth: true` : le schéma `neon_auth` est provisionné sur la
branche, avec ses tables `user`, `session`, `account`, `organization`.

## Décision

### Authentification : Neon Auth, c'est-à-dire Better Auth managé

Le SDK `@neondatabase/auth` est utilisé tel quel, avec un relais same-origin
`/api/auth/[...path]`. L'application ne détient ni mots de passe, ni sessions :
tout vit dans `neon_auth`, sur la même base et la même branche que le métier.

### L'authentification ne donne aucun droit

Une table `staff_members` dit qui appartient à l'équipe d'un centre. Elle porte
`tenant_id`, RLS comprise, comme toute autre table.

Le relais `/api/auth` expose l'inscription. **N'importe qui peut donc créer un
compte** ; cela ne donne accès à rien. L'accès au back-office est accordé par
une ligne dans `staff_members`, jamais par l'existence d'un compte.

### Un membre est inscrit par son adresse, rattaché à sa première connexion

`staff_members` porte l'adresse. `auth_user_id` reste nul jusqu'à la première
connexion, où le compte est rattaché au membre. Pas de clé étrangère vers
`neon_auth` : ce schéma appartient à Neon.

### Le contrôle vit dans les actions serveur, pas seulement dans le filtre de routes

`proxy.ts` redirige les visiteurs sans session vers `/auth/connexion`. C'est un
confort. Le contrôle qui protège réellement est `requireStaff()`, appelé par la
coque du back-office **et par chacune des dix-sept actions serveur** qui
écrivent.

### Deux rôles

`admin` et `staff`. `admin` administrera l'équipe ; `staff` utilise le
back-office. Aucun écran ne les distingue encore.

## Justification

**Pourquoi Neon Auth plutôt que better-auth auto-hébergé.** C'est le même
Better Auth, et son schéma est déjà provisionné sur la branche. Les sessions
suivent les branches de base : un environnement de test a ses propres comptes
sans montage particulier. L'auto-hébergement n'apporterait ici que des tables à
migrer et des mots de passe à stocker nous-mêmes. `CLAUDE.md` demande
better-auth ; c'est bien lui, managé.

Le jour où une fonctionnalité manquerait — MFA, passkeys, SSO —, le passage à
l'auto-hébergé reste ouvert : c'est la même bibliothèque.

**Pourquoi séparer authentification et autorisation.** C'est le point central de
cet ADR. Brancher Neon Auth sans liste d'accès reviendrait à mettre une serrure
dont la clé se distribue toute seule : le formulaire d'inscription est exposé
par le relais, et personne ne le retire sans casser la création de compte des
membres légitimes. Un compte prouve une adresse, pas une appartenance.

**Pourquoi le rattachement par adresse.** C'est le modèle habituel de
l'invitation : le centre inscrit `prenom@entreprise.fr`, la personne crée son
compte, le lien se fait. Il suppose que l'adresse ait été vérifiée — quiconque
la contrôle prend la place. Le code refuse le rattachement quand le service
déclare explicitement l'adresse non vérifiée. C'est une dépendance à la
vérification d'adresse, et elle doit être active en production.

**Pourquoi le contrôle dans chaque action.** Une action serveur Next s'invoque
par son identifiant, dans une requête POST vers n'importe quel chemin — y
compris la page publique, que le filtre laisse volontairement passer. Protéger
les chemins du back-office ne protège donc pas les actions. C'est le piège
classique de ce modèle d'exécution, et la raison pour laquelle `requireStaff()`
est répété dix-sept fois plutôt que posé une fois dans la coque.

**Pourquoi `staff_members` dans `src/db/` et non dans `src/modules/`.**
`CLAUDE.md` réserve `src/modules/` aux six domaines métier. L'accès au
back-office n'en est pas un : c'est du transverse, au même titre que `tenants`,
qui vit déjà dans `src/db/`. Créer un septième module pour une table de contrôle
d'accès brouillerait la liste des domaines.

**Pourquoi un script d'amorçage.** Aucun membre n'existe au départ, et
l'application ne permet d'en inscrire qu'à un membre déjà connecté. Il faut donc
une porte d'entrée hors application : `infra/ajouter-membre-staff.mjs`, qui se
connecte avec le rôle applicatif et écrit sous les mêmes politiques RLS que
l'application.

## Conséquences

**Le back-office n'est plus accessible sans compte.** Toute personne de l'équipe
doit être inscrite puis créer son accès. Il n'existe pas de porte dérobée.

**L'inscription est ouverte à tous.** C'est assumé : un compte sans ligne dans
`staff_members` ne voit que `/auth/acces-refuse`. La conséquence à surveiller est
le remplissage de `neon_auth.user` par des comptes inutiles, que rien ne purge
aujourd'hui.

**L'écran de connexion ne dit pas pourquoi il refuse.** « Accès refusé » sans
préciser que l'adresse n'est pas dans l'équipe : le dire renseignerait un
visiteur sur la composition de l'équipe.

**SMTP partagé.** Neon Auth envoie ses messages depuis `auth@mail.myneon.app`
tant qu'un SMTP propre n'est pas configuré. Les liens de vérification exigent un
SMTP propre — prérequis de mise en production, avec l'enregistrement des domaines
de confiance.

**Pas encore d'écran de gestion de l'équipe.** Ajouter ou retirer un membre passe
par le script. Le rôle `admin` existe pour cet écran, qui n'est pas écrit.

**Le portail client reste à faire.** Cet ADR ne traite que l'équipe du centre.
Les comptes des entreprises locataires — population `client` de `CLAUDE.md` —
demanderont leur propre rattachement, vers `clients` et non vers
`staff_members`.

## Alternatives écartées

**Un simple mot de passe partagé, ou une protection par l'hébergeur.** Le plus
rapide. Écarté : aucune trace de qui fait quoi, aucun retrait individuel, et il
faudrait tout reprendre à l'arrivée du portail client.

**Utiliser les organisations de Neon Auth plutôt qu'une table à nous.**
`neon_auth.organization` et `member` existent et porteraient l'appartenance.
Écarté pour trois raisons : la fonctionnalité est en bêta et partielle chez Neon
(pas de rôles personnalisés) ; nos politiques RLS comparent à `tenant_id` dans
notre schéma, pas à une table managée ; et l'appartenance à un centre est une
notion métier qui nous appartient.

**Ne protéger que par `proxy.ts`.** Un seul point, plus court. Écarté : ne
protège pas les actions serveur, qui sont précisément ce qui écrit.

**Attendre la mise en production pour poser l'authentification.** Écarté : la
page publique est déjà écrite, et le moment où « ça part en ligne » est
exactement celui où l'on ne veut pas découvrir ce chantier.
