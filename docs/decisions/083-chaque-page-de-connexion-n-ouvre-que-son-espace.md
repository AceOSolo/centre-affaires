# ADR 083 — Chaque page de connexion n'ouvre que son espace

**Date** : 2026-11-17
**Statut** : accepté. Amende l'ADR 077 (pages de connexion, déjà connecté) et
le commentaire de l'ADR 015 selon lequel « la page par laquelle on est entré »
ne compte pas. Sans migration.

## Contexte

Demande du responsable produit : « il faut que l'accès client et l'accès admin
soient différents ».

Deux pages de connexion existaient déjà, `/auth/connexion` pour les clients et
`/auth/equipe` pour l'équipe, mais elles faisaient la même chose : un membre
de l'équipe qui se connectait par la page des clients arrivait au back-office
(par l'aiguillage `/auth/suite`), et une personne déjà connectée qui ouvrait
la page de l'autre population était renvoyée vers son propre espace. Le lien
« Accès équipe » du pied de page de l'espace client menait en plus à la page
des clients.

Quatre degrés de séparation ont été proposés : chacun sa porte, sessions
séparées, comptes séparés, adresses web différentes. Le premier a été retenu.

## Décision

- **La page des clients n'ouvre qu'un compte qui a un espace client ; celle de
  l'équipe, qu'un membre de l'équipe.** Sitôt la session ouverte, le
  formulaire appelle `verifierPorteAction` : si le compte n'ouvre pas l'espace
  de la page, la session est refermée côté serveur et le formulaire dit
  d'utiliser l'autre page, avec un lien vers elle.
- **Après connexion, on reste dans l'espace de la page** : le chemin demandé
  (`?redirect=`) n'est suivi que s'il y appartient (`/compte…` côté clients,
  le reste côté équipe) ; sinon l'accueil de l'espace (`/compte`,
  `/aujourdhui`). Le formulaire des clients ne passe plus par `/auth/suite`.
- **Déjà connecté sur la page de l'autre population** : « Accès refusé », qui
  propose de revenir à son propre espace ou de se déconnecter pour changer de
  compte — plus de renvoi d'un espace vers l'autre.
- Le lien « Accès équipe » du pied de page mène à `/auth/equipe`.

Restent inchangés : un seul compte Better Auth par personne et une seule
session. Une personne à la fois membre de l'équipe et cliente (un gérant
domicilié) entre par l'une ou l'autre page ; une fois connectée, le bouton
« Mon espace client » du back-office lui ouvre toujours son espace client.

## Conséquences

- Logique pure dans `src/app/(auth)/deja-connecte.ts` (`ouvreLaPorte`,
  `suiteDeLaPorte`, `destinationSiConnecte`), éprouvée par
  `deja-connecte.test.ts`.
- C'est un parcours, pas une protection : les droits restent vérifiés par
  `requirePermission()` et `requireClientAccount()` dans chaque page et
  chaque action (ADR 008, 015, 019).
- La page de l'équipe ne lit plus l'espace client du compte : elle ne crée
  plus de fiche prospect à qui ne venait que pour le back-office
  (`resolveOrSignupClientAccounts`, ADR 068).
- Aller plus loin (sessions séparées, comptes séparés, sous-domaine pour
  l'admin) demanderait un nouvel ADR.
