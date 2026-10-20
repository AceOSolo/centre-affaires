# ADR 050 — Écran « Aujourd'hui », page d'arrivée de l'équipe

**Date** : 2026-10-20
**Statut** : accepté — amende l'ADR 048 (ordre des groupes du menu : « Aujourd'hui » en tête)

## Contexte

En se connectant, l'équipe arrivait sur le planning. Ce qui attend un geste
— demandes à valider, courrier à traiter, états des lieux à terminer ou à
faire signer — était dispersé dans quatre écrans, chacun à ouvrir pour le
savoir. L'exploitant demande un back-office « simple et intuitif à l'usage ».

## Décision

### Une page d'arrivée, `/aujourdhui`

- **À traiter** : une tuile par file d'attente que le rôle peut traiter —
  demandes (même compte que le menu, ADR 048), demandes de courrier, états
  des lieux à terminer, états des lieux à faire signer. Une file vide reste
  affichée (« Aucune demande en attente ») : c'est une information, et la
  grille ne change pas de forme d'un jour à l'autre.
- **Planning du jour** : les réservations de la journée en tableau, situées
  par rapport à l'heure (terminée, en cours, à venir — bornes `[)`), sans les
  annulées. Chaque ligne mène à la réservation.
- **Demandes à valider** : les cinq plus proches, vers « Demandes ».

L'écran ne traite rien lui-même : chaque tuile, chaque ligne mène à l'écran
qui traite. Il ne remplace ni « Demandes » ni le planning.

### Droits

La page s'ouvre avec un seul des droits qu'elle réunit
(`requireAnyPermission`, comme « Réglages ») ; chaque bloc vérifie le sien.
Les règles (tuiles, journée) sont dans `aujourdhui/journee.ts`, testées.

### Menu et redirections

« Aujourd'hui » est le premier groupe du menu, une seule entrée, sans titre
visible. La connexion de l'équipe, le logo du back-office et le lien
« Back-office » de l'espace client y mènent, au lieu du planning.

## Justification

**Voir avant d'ouvrir.** Les compteurs du menu disent qu'il y a quelque
chose ; la page dit quoi, et mène au bon endroit en un clic.

**Rien de nouveau à maintenir.** Les nombres viennent des requêtes des
écrans existants : la page et les écrans ne peuvent pas diverger.

## Alternatives écartées

**Un tableau de bord d'indicateurs** (occupation, chiffre d'affaires) : il
existe déjà (`/indicateurs`) et sert le pilotage, pas la journée.

**Garder le planning comme arrivée, avec un bandeau d'alertes** : le planning
est dense ; y ajouter les files d'attente l'alourdit pour tout le monde.

## Conséquences

- Une file d'attente nouvelle s'ajoute à `todoTiles`, avec son droit.
- Le menu compte 13 entrées, la limite de `menu.test.ts`.
