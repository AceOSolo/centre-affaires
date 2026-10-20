# ADR 049 — Produits et tarifs reçus de Dolibarr par son module Webhook

**Date** : 2026-10-20
**Statut** : accepté — première pièce de la passerelle entrante de l'ADR 046 § 5
(les tarifs) ; tiers et contrats restent à faire

## Contexte

L'ADR 046 confie à Dolibarr les services et les tarifs : le site affichera
« les prix que Dolibarr lui transmet ». Le site en a besoin à deux endroits :

- le **catalogue de services** (`services`), que le code retrouve par leur
  code stable (`courrier.ouverture`, `courrier.page`… ADR 024) et que les
  demandes de devis proposent ;
- la **grille tarifaire par défaut** (`rate_plan_items`), qui chiffre la
  réservation en ligne et les devis.

En production, aucun service n'existe encore : les prix n'ont jamais été fixés
(`infra/configurer-centre.mjs`, aucun prix inventé, ADR 009). L'exploitant
veut que ces prix viennent de Dolibarr, et que son développeur Dolibarr n'ait
qu'un webhook à brancher.

Le module Webhook natif de Dolibarr poste, à chaque déclencheur choisi,
`{ "triggercode": "…", "object": { …l'objet… } }` en JSON, **sans aucun
en-tête configurable** (vérifié dans
`core/triggers/interface_95_modWebhook_WebhookTriggers.class.php`, branche
`develop`, octobre 2026).

## Décision

1. **Une route** `POST /api/dolibarr/produits` reçoit tel quel l'envoi du module
   Webhook pour `PRODUCT_CREATE`, `PRODUCT_MODIFY`, `PRODUCT_PRICE_MODIFY` et
   `PRODUCT_DELETE`. Rien à écrire côté Dolibarr : une cible de webhook à
   déclarer (`docs/integrations/dolibarr-produits.md`).
2. **Le jeton passe dans l'adresse** (`?jeton=<DOLIBARR_API_TOKEN>`), le module
   ne sachant poser aucun en-tête ; `Authorization: Bearer` reste accepté. Même
   jeton que l'API des devis : celui qui configure Dolibarr le détient déjà.
3. **La référence Dolibarr décide de la place du produit**, en minuscules :
   - `tarif.<type>.<unité>` et `tarif.<type>.<code ressource>.<unité>` : un prix
     de la grille par défaut en vigueur ce jour-là ;
   - tout autre service (`type` = 1) : un service du catalogue, de **code égal à
     la référence** ;
   - un produit physique : ignoré.
4. **Dolibarr fait foi** sur ce qu'il envoie : libellé, description, prix HT de
   base, TVA, mise en vente. La nature d'un service attendu (acte à l'unité)
   vient du code ; pour un autre, une durée en mois en fait un forfait mensuel.
   La nature d'un service existant ne change jamais.
5. **Rien n'est effacé** (décision 6) : un produit supprimé archive le service
   ou retire le prix ; un prix qui change retire l'ancien et ajoute le nouveau.
   Rejouer un envoi ne change rien.
6. **Pas de migration** : la correspondance passe par le code du service et la
   clé (type, ressource, unité) de la grille, qui existent déjà.

## Justification

- Le module Webhook est livré avec Dolibarr : le développeur déclare une
  adresse et quatre déclencheurs, au lieu d'écrire un connecteur qui
  interrogerait le site.
- La référence est le seul champ que l'exploitant voit et maîtrise sur chaque
  fiche produit ; une convention lisible (`tarif.salle.journee`) évite une
  table de correspondance à tenir des deux côtés, et un champ supplémentaire
  à créer dans Dolibarr.
- Sans migration, la version se déploie sans geste sur le serveur.

## Alternatives écartées

- **Champ supplémentaire Dolibarr** (« code site ») : une configuration de plus
  pour le développeur, et une saisie de plus pour l'exploitant à chaque produit.
- **Le site interroge l'API REST de Dolibarr** : le site tiendrait un
  identifiant Dolibarr, contraire à l'ADR 046 § 2.
- **Garder l'identifiant Dolibarr du produit en base** : robuste au renommage,
  mais demande une migration. Le renommage d'un service est suivi par
  `oldcopy.ref` quand Dolibarr l'envoie ; celui d'un tarif laisse l'ancien prix,
  à retirer à l'écran Tarifs.

## Conséquences

- Le jeton figure dans les journaux d'Apache et dans l'historique des webhooks
  de Dolibarr. La route n'écrit que ce dont Dolibarr fait déjà foi.
- Le module n'est pas rejoué par Dolibarr en cas d'échec : pour reprendre un
  produit, l'enregistrer à nouveau dans Dolibarr. Chargement initial : ouvrir
  chaque produit, Modifier, Enregistrer.
- Les **niveaux de prix** (multiprix) et les prix par client de Dolibarr ne
  sont pas lus : seul le prix de base vaut.
- Sans grille par défaut en vigueur, un tarif est refusé (409) : la grille se
  crée à l'écran Tarifs. `infra/catalogue.mjs` en pose une.
- Les écrans Services et Tarifs restent ouverts : une saisie à l'écran sera
  écrasée par le prochain envoi de Dolibarr. Leur passage en lecture seule
  reste à faire avec la suite de l'ADR 046 § 5 (tiers, contrats).
