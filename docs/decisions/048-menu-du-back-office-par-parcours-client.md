# ADR 048 — Menu du back-office rangé par le parcours d'une demande

**Date** : 2026-10-20
**Statut** : accepté — remplace la partie « menu rangé par produit » de
l'ADR 046 ; les filtres par produit des pages (ADR 046) sont conservés ;
rangement par parcours remplacé par le rangement par service vendu de
l'ADR 053 (boîte de réception unique, « Réglages » et fiche client conservés)

## Contexte

L'ADR 046 avait rangé le menu par produit : un rayon Salles, Bureaux,
Domiciliation, Camion, chacun avec son planning, ses demandes, son parc et ses
états des lieux, plus les vues d'ensemble. Résultat : 32 entrées, dont cinq
« Planning », cinq « Demandes », six listes de ressources et trois « États des
lieux ». L'exploitant trouve des pages « en trop ou répétées » et demande un
rangement qui suive la logique **client → commande → administratif → gestion
→ retour au client**. Il a choisi ce rangement sur maquette, face à un menu
par produit dédoublonné (20/10/2026).

## Décision

### Une entrée par écran, dans l'ordre du parcours

| Étape | Entrées |
|---|---|
| Ce qui arrive | Demandes (compteur), Clients |
| Commande | Devis, Contrats |
| Administratif | Comptes du site |
| Gestion | Planning, Courrier (compteur), États des lieux, Ressources |
| Retour client | Messages envoyés, Annonces du site |
| *(séparé)* | Réglages |

32 entrées → 12. Le menu est décrit sans rendu dans `(admin)/menu.ts` ;
`menu.test.ts` vérifie l'ordre des étapes, qu'aucun écran n'y paraît deux
fois, qu'aucune entrée ne porte de filtre, que chaque entrée mène à une page
et ne cite que des droits de la matrice.

### Le produit se choisit dans la page

Les pastilles « Tous / Salles / Bureaux / Domiciliation / Camion » de l'ADR 046
restent dans les pages (Demandes, États des lieux, Ressources, Planning,
Devis). Les adresses filtrées (`/reservations?type=salle`,
`/demandes?produit=bureaux`…) fonctionnent toujours.

### « Demandes » est la seule boîte de réception

Elle réunit les réservations à valider, **les devis à compléter**
(domiciliation, camion, devis de l'accueil — ADR 043) et les offres
demandées. Un devis qui accompagne une demande de réservation en attente
n'apparaît pas deux fois : la carte de la demande porte son devis
(`awaitsReception`). Le compteur du menu compte les réservations en attente et
ces devis, une fois chacun. La pastille Domiciliation y est désormais
proposée.

### « Réglages » réunit ce qui se règle une fois

Une page (`/reglages`) : catalogue et tarifs (offres, services, tarifs), le
centre (horaires et fermetures, agendas Google, indicateurs), équipe et
configuration. Elle n'affiche que les écrans du rôle et se garde par
`requireAnyPermission` (au moins un de leurs droits) ; chaque écran garde le
sien. L'entrée du menu reste allumée sur ces écrans. Le test des gardes
accepte cette garde pour une page.

### La fiche client montre sa commande

Une section « Devis » (de la demande au contrat), avec « Nouveau devis »
présélectionnant l'entreprise (`/devis/nouveau?client=…`).

## Justification

**Le parcours plutôt que le produit.** L'accueil traite une demande de bout en
bout ; les écrans sont communs à tous les produits (décision 2 du
`CLAUDE.md` : une seule table, un seul calendrier). Ranger par produit
recopiait chaque écran quatre fois dans le menu ; le filtre de la page fait la
même chose sans la répétition.

**Une boîte de réception unique.** Une domiciliation n'a pas de créneau : ses
demandes vivaient dans « Devis », à part des autres. Tout ce qui attend
l'accueil se trouve maintenant au même endroit, avec un seul compteur.

## Alternatives écartées

**Le menu par produit, dédoublonné** (une entrée par produit, environ 18
entrées) : présenté à l'exploitant, non retenu.

**Supprimer des pages.** Aucune page n'est retirée : les écrans de
facturation sont déjà fermés à tous les rôles par l'ADR 046 et restent
consultables par adresse pour les factures émises (décision 6) ; les vues
jour, semaine et mois du planning sont un même écran.

## Conséquences

- Plus de compteur par produit dans le menu ; la file d'un produit se lit dans
  « Demandes » filtrée.
- L'accueil ne voit pas « Réglages » (aucun de ses droits n'y figure).
- Un nouvel écran de paramétrage s'ajoute à `reglages/sections.ts`, pas au
  menu.
