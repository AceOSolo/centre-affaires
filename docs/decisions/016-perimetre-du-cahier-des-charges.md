# ADR 016 — Tout le cahier des charges DOMOTOP entre dans le périmètre

**Date** : 2026-10-01
**Statut** : accepté

## Contexte

Le cahier des charges du 18/09/2026 (support *DOMOTOP — Application de gestion
de centre d'affaires* et son analyse) décrit 33 exigences. L'audit du 30/09
(`docs/roadmap.md`) en trouve 5 couvertes, 18 partielles, 10 absentes, et
plusieurs points que le cahier des charges laisse « à arbitrer » ou qui
contredisent `CLAUDE.md` et des ADR existants.

Le centre demande que tout ce qui est partiel ou absent soit fait, et a tranché
les points ouverts le 01/10/2026.

## Décision

**Tout le périmètre est retenu.** Les 28 exigences partielles ou absentes sont
construites en quatre vagues, chacune livrée de la base à l'écran :

1. socle d'exploitation, sécurité, conservation, continuité ;
2. monétisation : tarifs, services, offres, facturation ;
3. autonomie client : portail, demandes, notifications ;
4. états des lieux.

**La facturation entre dans le périmètre.** Elle remplace la mention « hors
scope de la V1 » de `CLAUDE.md`. Les principes déjà posés restent :

- factures en données structurées, compatibles EN 16931 dès leur création ;
- le PDF n'est qu'une vue ;
- l'émission réglementaire passera par une plateforme agréée, jamais par du
  code maison.

Le choix de la plateforme et son raccordement viendront plus tard. La TVA et une
numérotation continue par centre font partie du modèle dès la vague 2.

**Paiement : virement et prélèvement suivis à la main.** L'IBAN et le mandat de
prélèvement sont conservés (chiffrés). L'équipe pointe les paiements reçus, et
un export sert pour la banque. Aucun prestataire de paiement, aucune dépendance.

**Réservation par un client connecté : un réglage par ressource.** Chaque
ressource dit si sa réservation se confirme immédiatement ou attend l'accord de
l'accueil. La page publique anonyme reste une demande validée par l'équipe
(ADR 005).

**Pas de second facteur.** L'authentification reste sur Neon Auth géré
(ADR 008). L'exigence R28 se limite à l'isolation des comptes clients entre eux.

**Sauvegardes sans abonnement payant.** Une sauvegarde nocturne de la base et
une copie du stockage objet, chiffrées et hors du serveur. La procédure de
restauration est documentée et testée.

Les autres arbitrages font chacun l'objet d'un ADR dans la vague qui les
construit :

- planning toutes ressources et vue mois (amende l'ADR 011) ;
- occupation des ressources sous contrat protégée par la base ;
- rôles exploitant et accueil ;
- règles tarifaires paramétrables par centre (amende les ADR 006 et 009) ;
- catalogue de services et offres groupées ;
- formulaires d'état des lieux définis en base.

## Conséquences

- La section Facturation de `CLAUDE.md` renvoie à cet ADR. L'ordre de
  construction suit les vagues ci-dessus.
- `docs/roadmap.md` est la liste de contrôle : chaque vague met à jour le
  statut des exigences qu'elle livre.
- Toute règle métier nouvelle (devis, remise, engagement, prorata, purge,
  droits) arrive avec son test.

## Alternatives écartées

**Garder la facturation hors de la V1** : le relevé des ouvertures resterait
ressaisi à la main. C'est l'inverse du « sans ressaisie » du cahier des charges,
et l'émission électronique devient obligatoire au 01/09/2027.

**Passer à better-auth auto-hébergé pour le second facteur** : refusé par le
centre. Le chemin reste ouvert (ADR 008).

**Prélèvement par un prestataire (Stripe, GoCardless)** : ce serait un contrat
et une dépendance de plus, sans besoin exprimé à ce stade.
