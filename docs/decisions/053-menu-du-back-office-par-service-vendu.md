# ADR 053 — Menu du back-office rangé par service vendu

**Date** : 2026-10-22
**Statut** : accepté — remplace le rangement par parcours de l'ADR 048 (la
boîte de réception unique « Demandes », la page « Réglages » et la fiche
client qui montre sa commande sont conservées) ; garde « Aujourd'hui » en tête
(ADR 050)

## Contexte

Depuis l'ADR 048, le menu suit le parcours d'une demande : ce qui arrive,
commande, administratif, gestion, retour client. Deux jours plus tard,
l'exploitant demande un menu « rangé par service ». Deux lectures lui ont été
présentées sur maquette le 22/10/2026 : par service de l'équipe (accueil,
commercial, gestion du centre) ou par service vendu (salles, bureaux,
domiciliation, camion). Il a choisi **par service vendu**, en sachant que
c'était le rangement de l'ADR 046, écarté pour ses 32 entrées répétées.

## Décision

### Un rayon par produit, sans répétition

| Groupe | Entrées |
|---|---|
| *(sans titre)* | Aujourd'hui, Demandes (compteur) |
| Salles | Planning des salles, Salles |
| Bureaux | Planning des bureaux (vue du mois), Bureaux (et casiers), États des lieux |
| Domiciliation | Courrier (compteur), Boîtes aux lettres |
| Camion | Planning du camion (vue de la semaine), Véhicules, États des lieux |
| Tous les services | Clients, Devis, Contrats, Comptes du site, Messages envoyés, Annonces du site |
| *(séparé)* | Réglages |

19 entrées. Les rayons suivent l'ordre et les libellés des produits de
`src/modules/ressources/produits.ts` ; une entrée de rayon est une adresse
filtrée (`?type=`, `?produit=`) sur son seul produit.

### Ce que l'ADR 046 répétait n'est pas repris

- **Une seule « Demandes »**, en tête sous « Aujourd'hui », avec un seul
  compteur (ADR 048) : pas de « Demandes » par rayon. Le produit se choisit
  par les pastilles de la page.
- **Pas de vues d'ensemble doublées** : ni « Planning général », ni « Toutes
  les ressources », ni « États des lieux » général au menu. On y accède par la
  pastille « Tous » de chaque page filtrée.
- **Ce qui se règle une fois reste dans « Réglages »** (ADR 048) : offres,
  services, tarifs, horaires, agendas, indicateurs, équipe, configuration.

### L'entrée active

Les vues jour, semaine et mois d'un même produit allument son planning
(`also` : `/reservations?type=bureau` pour le planning des bureaux, qui
s'ouvre sur le mois). La liste des casiers allume « Bureaux ». Une page sans
produit dans l'adresse (fiche d'une réservation, planning « Tous ») n'allume
aucune entrée.

### Vérifié par `menu.test.ts`

L'ordre des groupes (rayons = produits de `produits.ts`), qu'une entrée de
rayon ne filtre que sur son produit, qu'aucune entrée hors rayon ne porte de
filtre, qu'aucune adresse n'est deux fois au menu, au plus 20 entrées, que
chaque entrée mène à une page et ne cite que des droits de la matrice.

## Justification

**Le choix de l'exploitant.** Il vend quatre produits et pense son centre par
produit : chercher « le planning du camion » sous « Camion » est plus direct
que sous « Gestion », puis par une pastille.

**Sans retomber dans les 32 entrées.** Ce qui avait fait écarter l'ADR 046
était la répétition : cinq plannings, cinq « Demandes », six listes de
ressources. Ici chaque produit n'a que ses écrans propres, et ce qui est
commun n'est qu'une fois au menu.

## Alternatives écartées

**Par service de l'équipe** (Accueil, Commercial, Gestion du centre) :
présenté le 22/10/2026, non retenu.

**Le menu de l'ADR 046 tel quel** : 32 entrées, écarté par l'ADR 048 pour ses
répétitions.

## Conséquences

- Le menu passe de 13 à 19 entrées.
- Un produit nouveau dans `produits.ts` fait échouer `menu.test.ts` tant que
  son rayon n'est pas ajouté au menu.
- La décision 2 du `CLAUDE.md` est inchangée : le produit reste un
  regroupement d'affichage, les écrans sont communs à tous les types.
