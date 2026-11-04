# Raccorder Dolibarr aux devis de l'application

Pour le développeur qui écrit le connecteur Dolibarr. Décision et raisons :
[ADR 043](../decisions/043-demandes-par-produit-et-devis-dolibarr.md).

Les produits et les tarifs vont dans l'autre sens, de Dolibarr vers le site,
par le module Webhook de Dolibarr et sans code : voir
[dolibarr-produits.md](dolibarr-produits.md) (ADR 049).

Les tiers, les contrats et les consommations facturables (seconde tranche,
[ADR 066](../decisions/066-seconde-tranche-dolibarr-tiers-contrats-consommations.md))
sont décrits plus bas : § « Seconde tranche », et ce qui reste à valider
ensemble : § « À valider avec le développeur Dolibarr ».

## Le principe

L'application recueille les demandes (salle ou bureau, camion, domiciliation)
et en fait des **devis structurés**. Elle **n'appelle pas Dolibarr** : c'est le
connecteur qui vient chercher les devis prêts, les crée dans Dolibarr
(proposition commerciale), puis le signale à l'application.

```
Application                                   Connecteur (vous)              Dolibarr
───────────                                   ─────────────────              ────────
devis « prêt »  ◄── GET  /api/dolibarr/devis ──  toutes les N minutes
                                                 crée ou retrouve le tiers ──► /thirdparties
                                                 crée la proposition ────────► /proposals
« transmis »    ◄── POST /api/dolibarr/devis/{id}/transmis
« signé »/      ◄── POST /api/dolibarr/devis/{id}/issue     (quand la proposition est signée ou refusée)
« refusé »
devis annulés   ◄── GET  /api/dolibarr/devis?statut=cancelled&depuis=…
                                                 ferme la proposition ───────► /proposals/{id}/close
```

Un devis **prêt** a été validé : chiffré d'office (salle réservée au prix de la
grille) ou relu par l'accueil (camion, domiciliation, tout devis complété à la
main). Un devis **à compléter** n'apparaît jamais dans l'API.

## Accès

- Base : l'adresse publique de l'application (`APP_URL`), par exemple
  `https://reservation.exemple.fr`.
- Jeton : `Authorization: Bearer <jeton>`. **D'où il vient** (ADR 065) :
  - **le jeton du centre**, généré par la direction dans le back-office
    (Réglages > Connexion au CRM), affiché une seule fois et remis par elle.
    Il désigne le centre : chaque centre a le sien, et un appel est servi pour
    le centre de son jeton ;
  - **à défaut, l'ancien jeton du serveur** (`DOLIBARR_API_TOKEN`, dans le
    `.env` du VPS), tant qu'aucun jeton n'est réglé à l'écran. C'est celui que
    vous avez aujourd'hui : **rien à changer tant que la direction n'en génère
    pas un nouveau.** Le jour où elle le fait, l'ancien cesse aussitôt :
    remplacez-le dans votre connecteur **et** dans l'adresse de la cible du
    module Webhook (produits, `?jeton=`), en même temps.
- Sans jeton valide, ou si aucun jeton n'est configuré, **toutes les routes
  répondent 404** : c'est voulu, elles n'existent pas pour les autres.
- Un flux coupé par le centre (Réglages > Connexion au CRM, « Flux échangés »)
  répond **403** sur les routes des devis, des tiers, des contrats et des
  consommations, **400** au webhook des produits,
  avec `{ "erreur": "Flux « Devis » désactivé dans les réglages du centre (…)" }`.
  Chaque appel au jeton valide, réussi ou non, est inscrit au journal des
  échanges que le centre lit sur le même écran.
- Réponses en JSON, UTF-8. Instants en UTC, ISO 8601 (`2026-11-03T08:00:00.000Z`).

## `GET /api/dolibarr/devis`

| Paramètre | Défaut | Sens |
|---|---|---|
| `statut` | `ready` | `ready`, `sent`, `accepted`, `refused`, `cancelled` (ou `draft`, sans intérêt pour vous) |
| `depuis` | — | instant ISO : seulement les devis modifiés depuis |
| `limite` | 100 | 1 à 500 |

Tri : du plus ancien au plus récent (par date de dernière modification).
Un paramètre illisible (statut inconnu, date non ISO, limite hors de 1 à 500)
répond **400** `{ "erreur": "…" }`.

```json
{
  "devis": [
    {
      "id": "0199a3c4-7d2e-7a10-9b1c-3f5e8a2d4c61",
      "reference": "DV-2026-0042",
      "produit": "espace",
      "canal": "public",
      "statut": "ready",
      "creeLe": "2026-10-20T09:12:44.512Z",
      "valideLe": "2026-10-20T09:12:44.530Z",
      "annuleLe": null,
      "motifAnnulation": null,
      "devise": "EUR",
      "tiers": {
        "clientId": null,
        "nom": "Atelier Martin",
        "siret": null,
        "numeroTva": null,
        "email": "camille@exemple.fr",
        "telephone": "06 00 00 00 00",
        "adresse": null
      },
      "contact": { "nom": "Camille Dupont", "email": "camille@exemple.fr", "telephone": "06 00 00 00 00" },
      "reservation": {
        "id": "0199a3c4-7d2a-7c41-8e0f-2b9d1e6a7f30",
        "debut": "2026-11-03T08:00:00.000Z",
        "fin": "2026-11-03T12:00:00.000Z",
        "ressource": "Salle Mont Blanc"
      },
      "reponses": [
        { "libelle": "Nombre de participants", "valeur": "8" },
        { "libelle": "Type de rendez-vous", "valeur": "Réunion" }
      ],
      "reponsesBrutes": { "participants": 8, "usage": "reunion" },
      "message": "Besoin d'un paperboard.",
      "noteAccueil": null,
      "lignes": [
        {
          "position": 1,
          "designation": "Salle Mont Blanc — mardi 3 novembre 2026, 09:00 – 13:00",
          "description": null,
          "typeProduit": 1,
          "unite": "demi-journée",
          "quantite": 1,
          "prixUnitaireHtCentimes": 9000,
          "prixUnitaireHt": "90.00",
          "remisePourcent": null,
          "remiseMontantCentimes": null,
          "tauxTva": "20",
          "montantHtCentimes": 9000,
          "ressourceId": "0199a3c4-0000-7000-8000-0000000000b1",
          "serviceId": null
        }
      ],
      "totaux": { "htCentimes": 9000, "tvaCentimes": 1800, "ttcCentimes": 10800 }
    }
  ]
}
```

Champs à connaître :

- **`id`** : à garder côté Dolibarr (extrafield, ou `ref_client`
  complété) — c'est lui qu'on renvoie à `/transmis` et `/issue`.
- **`reference`** (`DV-…`) : numéro du centre, à mettre en **`ref_client`** de
  la proposition : l'accueil retrouve ainsi le devis des deux côtés.
- **`produit`** : `espace` (salle ou bureau), `vehicule`, `domiciliation`.
- **`tiers.clientId`** non nul : entreprise déjà cliente du centre (fiche
  complète, SIRET, adresse). Nul : un **prospect** de la page publique, connu
  seulement par son nom, sa société, son adresse électronique et son
  téléphone ; pour une domiciliation, `tiers.siret` porte le SIREN déclaré
  s'il y en a un.
- **`reponses`** : les réponses au questionnaire, en clair, dans l'ordre —
  à reporter en note privée ou publique de la proposition.
  **`reponsesBrutes`** : les mêmes, en valeurs, si vous voulez des extrafields.
- **Montants** : toujours des entiers en **centimes** (`…Centimes`), plus le
  prix unitaire en décimal à point (`prixUnitaireHt`) pour `subprice`. Les
  taux (`tauxTva`, `remisePourcent`) sont des pourcentages décimaux en texte
  (`"20"`, `"5.5"`).
- **`montantHtCentimes`** : calculé par l'application, arrondi une seule fois
  au centime (`(quantité × prix − remise en montant) × (1 − remise %)`). C'est
  le montant annoncé au client : vérifiez que Dolibarr retombe dessus.

### Correspondance proposée avec l'API REST de Dolibarr

À adapter à votre version et à vos extrafields.

| Application | Dolibarr (`POST /proposals`) |
|---|---|
| tiers retrouvé ou créé | `socid` — chercher par e-mail ou SIRET (`GET /thirdparties?sqlfilters=…`), sinon créer un tiers **prospect** (`client = 2`) |
| `reference` | `ref_client` |
| `creeLe` | `date` (date du devis) |
| `reponses` + `message` + `noteAccueil` | `note_private` (ou `note_public` pour ce que le client doit lire) |
| `lignes[].designation` / `description` | `desc` (désignation + description) |
| `lignes[].quantite` | `qty` |
| `lignes[].prixUnitaireHt` | `subprice` |
| `lignes[].tauxTva` | `tva_tx` |
| `lignes[].remisePourcent` | `remise_percent` |
| `lignes[].typeProduit` (toujours 1) | `product_type` = 1 (service) |
| `reservation.debut` / `fin` | `date_start` / `date_end` de la ligne, si vous les utilisez |

**Remise en montant** (`remiseMontantCentimes`, posée par l'accueil) : les
lignes Dolibarr n'ont qu'une remise en pourcentage. Le plus simple et exact :
ajoutez une ligne de remise à prix négatif de `-remiseMontantCentimes ×
quantite / 100` (même TVA), ou demandez au centre de n'utiliser que des
remises en pourcentage.

## `POST /api/dolibarr/devis/{id}/transmis`

Dès que la proposition existe dans Dolibarr :

```json
{ "dolibarrId": "412", "dolibarrRef": "PR2611-0007" }
```

- `dolibarrId` obligatoire (texte ou nombre, 64 caractères au plus),
  `dolibarrRef` facultatif.
- **200** `{ "ok": true }` : le devis passe « transmis » et sort de la liste
  des devis prêts.
- **Rejouable** : le même appel une seconde fois (après une coupure réseau)
  répond 200 sans rien changer. Créez la proposition, puis appelez
  `/transmis` ; si l'appel échoue, rappelez-le avant de recréer quoi que ce
  soit (cherchez d'abord la proposition par `ref_client`).
- **409** : le devis n'est plus prêt (annulé entre-temps, remis en brouillon
  par l'accueil, ou déjà transmis sous un autre identifiant). Le message dit
  pourquoi ; ne recréez rien.
- **400** : `dolibarrId` absent, ou l'un des deux de plus de 64 caractères.
- **404** : devis inconnu (ou jeton invalide).

## `POST /api/dolibarr/devis/{id}/issue`

Quand la proposition est signée ou refusée dans Dolibarr :

```json
{ "issue": "signe" }
```

`"signe"` ou `"refuse"`. Rejouable. **409** si le devis n'a pas été transmis,
ou a déjà l'autre issue ; **400** pour toute autre valeur d'`issue` ; **404**
pour un devis inconnu.

## Les devis annulés

Un devis est annulé par l'accueil, ou **automatiquement quand sa réservation
est annulée** (demande refusée, annulation par le client ou par le centre) —
y compris après sa transmission. Interrogez régulièrement :

```
GET /api/dolibarr/devis?statut=cancelled&depuis=<date du dernier passage>
```

et fermez dans Dolibarr les propositions correspondantes (`annuleLe`,
`motifAnnulation`). Gardez la date du dernier passage de votre côté.

## Fréquence et reprise

- Interrogez `GET /api/dolibarr/devis` toutes les quelques minutes ; un
  devis prêt y reste tant qu'il n'est pas transmis : rien ne se perd si le
  connecteur s'arrête.
- Traitez les devis un par un, dans l'ordre reçu, et appelez `/transmis`
  après chaque création réussie.

## Les factures : dans Dolibarr seulement

Depuis l'[ADR 046](../decisions/046-dolibarr-commercial-et-facturation-admin-par-produit.md),
**toute la facturation est dans Dolibarr** : factures et avoirs, règlements,
prélèvements, relances, export comptable, et le raccordement à une plateforme
agréée pour la facture électronique (réception obligatoire depuis septembre
2026, émission au 1er septembre 2027). L'application ne facture plus rien :
ses droits de facturation ne sont accordés à aucun rôle, et le lot mensuel
planifié est arrêté (`/api/maintenance/facturation` répond `410`). Une
réservation au devis signé se facture dans Dolibarr, à partir du devis.

## Seconde tranche : tiers, contrats, consommations

Décision et raisons : [ADR 066](../decisions/066-seconde-tranche-dolibarr-tiers-contrats-consommations.md).
Même jeton, même règles d'accès que les devis ; chaque flux s'ouvre à
l'écran « Connexion au CRM », **coupé tant que la direction ne l'ouvre pas** :
dites-lui quand votre connecteur est prêt.

```
Application                                     Connecteur (vous)                Dolibarr
───────────                                     ─────────────────                ────────
fiche client    ◄── POST /api/dolibarr/tiers ────  à chaque création/modification  ◄── tiers
                                                   d'un tiers, et chaque nuit
contrat +       ◄── POST /api/dolibarr/contrats ─  idem, après son tiers           ◄── contrats
occupation
consommations   ◄── GET  /api/dolibarr/consommations ── chaque nuit
« prêtes »                                         ajoute à la facture du mois ───► /invoices
« reprises »    ◄── POST /api/dolibarr/consommations/{id}/transmis
annulées        ◄── GET  /api/dolibarr/consommations?statut=cancelled&depuis=…
                                                   retire ou crédite la ligne ────► /invoices
```

Le site **n'appelle pas Dolibarr** : tiers et contrats, vous les envoyez ;
consommations, vous venez les chercher. Le site ne fait aucune facture.

### `POST /api/dolibarr/tiers`

Un tiers créé, modifié, fermé ou supprimé dans Dolibarr. **Dolibarr fait
référence** (ADR 046) : sur une fiche qu'il tient, raison sociale, forme
juridique, SIRET, TVA, coordonnées, adresse et statut sont les siens — **un
champ absent ou nul est vidé sur le site**. Le reste de la fiche (notes,
accès à l'espace client, courrier, réservations) reste au site.

```json
{
  "dolibarrId": "412",
  "reference": "CU2611-0042",
  "statut": "client",
  "nom": "Atelier Martin",
  "formeJuridique": "SARL",
  "siret": "12345678900012",
  "siren": null,
  "numeroTva": "FR12123456789",
  "email": "contact@atelier-martin.exemple.fr",
  "telephone": "04 00 00 00 00",
  "adresse": { "ligne1": "3 rue des Lilas", "ligne2": null, "codePostal": "69002", "ville": "Lyon", "pays": "FR" },
  "clientId": null,
  "contacts": [
    { "dolibarrId": "88", "nom": "Camille Dupont", "fonction": "Gérante", "email": "camille@exemple.fr", "telephone": null, "facturation": true }
  ]
}
```

| Champ | Dolibarr (objet `Societe`) | Sens |
|---|---|---|
| `dolibarrId` | `id` (`rowid`) | **obligatoire** : la référence commune du tiers, gardée par le site |
| `reference` | `code_client` | facultatif, affiché sur la fiche du site |
| `statut` | `client` 1 ou 3 → `"client"` ; 2 → `"prospect"` ; `status` 0 (fermé) → `"ferme"` | **obligatoire** |
| `nom` | `name` | **obligatoire**, 255 caractères au plus |
| `formeJuridique` | libellé de `forme_juridique_code` | facultatif |
| `siret` | `idprof2` | 14 chiffres (espaces tolérés) |
| `siren` | `idprof1` | 9 chiffres, seulement s'il n'y a pas de SIRET ; sert au rapprochement |
| `numeroTva` | `tva_intra` | |
| `email`, `telephone` | `email`, `phone` | une adresse illisible est écartée, avec un avertissement |
| `adresse` | `address` (ligne1 / ligne2), `zip`, `town`, `country_code` | `pays` : code ISO à deux lettres, `FR` par défaut |
| `clientId` | — | facultatif : la fiche du site que ce tiers est (rapprochement explicite) |
| `contacts` | contacts du tiers (`/thirdparties/{id}/contacts`) : `id`, `lastname` + `firstname`, `poste`, `email`, `phone_pro` | facultatif ; présent, **remplace** les contacts reçus avant |
| `supprime` | `COMPANY_DELETE` | `true` : seul `dolibarrId` est lu |

**Rapprochement** — à quelle fiche du site ce tiers correspond, dans l'ordre :

1. celle déjà reliée à ce `dolibarrId` ;
2. celle que vous désignez par `clientId` (donnée par le site : `tiers.clientId`
   des devis, ou la liste ci-dessous) ;
3. la seule fiche vivante, non reliée, au **même SIRET** ;
4. la seule fiche vivante, non reliée, au **même SIREN** ;
5. aucune : une fiche est **créée** pour un client ; un prospect ou un tiers
   fermé n'en crée pas (`"resultat": "ignore"`).

Jamais deux tiers pour une fiche, ni deux fiches pour un tiers : un doublon
est refusé (`409`), le message dit lequel. Les contacts saisis sur le site,
sans `dolibarrId`, ne bougent pas ; le contact principal reste un choix de
l'accueil. Supprimer un tiers dans Dolibarr ne supprime pas la fiche du site
(courrier, réservations, décision 6) : elle n'est plus tenue par Dolibarr.

Réponses :

| Code | Sens |
|---|---|
| `200` `{"ok":true,"resultat":"cree","clientId":"…","message":"…","avertissements":[]}` | `cree`, `rapproche`, `modifie`, `inchange`, `retire`, ou `ignore` (prospect sans fiche, fiche anonymisée ou archivée sur le site) |
| `400` `{"erreur":"…"}` | envoi illisible : le message dit quel champ corriger |
| `404` | `clientId` inconnu (ou jeton invalide) |
| `409` | doublon : SIRET déjà porté par une autre fiche, plusieurs fiches au même SIREN, fiche ou tiers déjà rapproché ailleurs |

**Rejouable** : le même envoi une seconde fois répond `inchange`. Après avoir
créé un tiers pour un devis dont `tiers.clientId` est connu, envoyez-le avec
ce `clientId` : c'est le rapprochement.

### `GET /api/dolibarr/tiers`

Les fiches vivantes du site, avec leur tiers Dolibarr s'il y en a un : pour
rapprocher **une fois** celles que le site avait avant vous.

| Paramètre | Défaut | Sens |
|---|---|---|
| `rapproche` | — | `non` : les fiches sans tiers ; `oui` : celles qui en ont un |
| `limite` | 500 | 1 à 500 |
| `apres` | — | `clientId` du dernier reçu, pour la page suivante |

```json
{ "tiers": [ { "clientId": "0199…", "dolibarrId": null, "reference": null, "recuLe": null, "nom": "Studio Nord", "statut": "client", "siret": null, "numeroTva": null, "email": null, "telephone": null, "adresse": { "ligne1": null, "ligne2": null, "codePostal": null, "ville": null, "pays": "FR" } } ] }
```

### `POST /api/dolibarr/contrats`

Un contrat créé, validé, modifié, résilié ou supprimé. Le site en garde une
copie pour **l'occupation** : qui occupe quel bureau ou quelle boîte aux
lettres, qui est domicilié, du … au …. Un contrat en cours **occupe sa
ressource au planning** ; la base refuse tout chevauchement (une réservation,
un autre contrat), comme partout.

```json
{
  "dolibarrId": "57",
  "reference": "CT2611-0003",
  "tiersDolibarrId": "412",
  "type": "bureau",
  "statut": "en_cours",
  "debut": "2026-11-01",
  "fin": null,
  "resilieLe": null,
  "motifResiliation": null,
  "ressource": "BUR-12",
  "prix": { "montantHtCentimes": 45000, "periodicite": "mensuel", "tauxTva": "20", "devise": "EUR" },
  "engagementMois": 12,
  "preavisJours": 90,
  "contratId": null
}
```

| Champ | Sens |
|---|---|
| `dolibarrId` | **obligatoire** : le contrat, ou **la ligne de contrat** — un contrat du site a au plus une ressource : un contrat Dolibarr qui loue un bureau et un casier s'envoie en deux, chacun sous l'identifiant de sa ligne |
| `reference` | **obligatoire** : `ref` du contrat Dolibarr |
| `tiersDolibarrId` | **obligatoire** : `socid` ; **le tiers doit être envoyé avant** (`409` sinon) |
| `type` | `domiciliation`, `bureau`, `coworking` ou `autre` |
| `statut` | `brouillon` (non validé), `en_cours`, `termine` |
| `debut`, `fin` | dates `AAAA-MM-JJ`, jours du centre ; `fin` nulle : sans terme |
| `resilieLe`, `motifResiliation` | résiliation datée : le contrat occupe jusqu'à ce jour compris. `termine` sans `resilieLe` prend `fin` |
| `ressource` | **code** de la ressource du site (écran Ressources, ou la référence de tarif `tarif.<type>.<code>.<unité>` de la ligne, ADR 049) ; nul : aucune (domiciliation sans boîte attitrée) |
| `prix` | **obligatoire** : le prix HT par période, en centimes, **que l'espace client affiche** ; `periodicite` : `mensuel`, `trimestriel`, `annuel` ; `tauxTva` en pourcentage (`"20"` par défaut) ; il ne sert à aucune facture |
| `engagementMois`, `preavisJours` | facultatifs : absents, ils ne changent pas |
| `contratId` | facultatif : le contrat du site que ce contrat est (rapprochement explicite) |
| `supprime` | `true` : le contrat est archivé sur le site, sa ressource libérée ; seul `dolibarrId` est lu |

Rapprochement : le contrat déjà relié, celui désigné par `contratId`, sinon
le seul contrat vivant **du même client et de même référence** (repris d'avant
vous sous son numéro), sinon un nouveau. **Pas de reconduction tacite sur le
site** pour un contrat reçu : envoyez la nouvelle `fin` quand Dolibarr le
prolonge.

Réponses : `200` `{"ok":true,"resultat":"cree","contratId":"…","reference":"CT2611-0003","message":"…"}`
(`cree`, `rapproche`, `modifie`, `inchange`, `retire`, `ignore`) ; `400` envoi
illisible ou ressource inconnue ; `404` `contratId` inconnu ; `409` tiers pas
encore reçu, **ressource déjà occupée sur la période**, référence prise par
le contrat d'un autre client. Rejouable.

`GET /api/dolibarr/contrats?rapproche=non` liste les contrats du site sans
contrat Dolibarr (`contratId`, `reference`, `tiers`, `type`, `statut`,
`debut`, `fin`, `resilieLe`, `ressource`), mêmes paramètres que les tiers.

### `GET /api/dolibarr/consommations`

Ce que le centre a fait pour ses clients et que Dolibarr facture : **une
consommation est une donnée, pas une facture**. Elle paraît quand elle ne peut
plus changer :

| `nature` | Ce que c'est | Prête quand | `produit` |
|---|---|---|---|
| `reservation` | réservation **sans devis** (un devis vivant se facture à partir du devis) d'un client, de toute ressource : salle, bureau, camion, matériel… | elle est terminée | `tarif.<type>.<unité>` du devis figé, ou nul |
| `ouverture` | ouverture et numérisation d'un pli | son mois est clos | `courrier.ouverture` |
| `pages` | pages numérisées à l'ouverture au-delà de celles comprises (réglage du centre) | son mois est clos | `courrier.page` (quantité = pages en plus) |
| `numerisation` | numérisation demandée d'un pli déjà ouvert | son mois est clos | `courrier.numerisation` |
| `reexpedition` | réexpédition d'un pli, avec ses frais d'affranchissement | son mois est clos **et** ses frais relevés | `courrier.reexpedition` |

Le courrier part donc **le 1er du mois** pour le mois écoulé, comme le relevé
que l'accueil reportait à la main ; une réservation, dès qu'elle est finie.
Rien d'antérieur à la **date de départ** réglée par la direction à l'écran
(par défaut, le jour où elle ouvre le flux) : ce qui a déjà été facturé à la
main ne repart pas.

| Paramètre | Défaut | Sens |
|---|---|---|
| `statut` | `ready` | `ready` (à reprendre), `sent` (reprises), `cancelled` (annulées) |
| `depuis` | — | instant ISO : seulement celles modifiées depuis |
| `limite` | 100 | 1 à 500 |

```json
{
  "consommations": [
    {
      "id": "0199b1c2-…",
      "nature": "reservation",
      "statut": "ready",
      "faitLe": "2026-10-14T07:00:00.000Z",
      "jour": "2026-10-14",
      "creeLe": "2026-11-01T02:00:03.120Z",
      "transmisLe": null,
      "annuleLe": null,
      "motifAnnulation": null,
      "dolibarrId": null,
      "dolibarrRef": null,
      "tiers": { "clientId": "0199…", "dolibarrId": "412", "nom": "Atelier Martin", "siret": "12345678900012" },
      "produit": "tarif.salle.demi-journee",
      "designation": "Salle Mont Blanc — mercredi 14 octobre 2026, 09:00 – 13:00",
      "quantite": 1,
      "unite": "demi-journée",
      "prix": {
        "prixUnitaireHtCentimes": 9000, "prixUnitaireHt": "90.00", "remisePourcent": null,
        "remiseMontantCentimes": null, "tauxTva": "20", "montantHtCentimes": 9000, "devise": "EUR"
      },
      "frais": null,
      "reservation": {
        "id": "0199…", "debut": "2026-10-14T07:00:00.000Z", "fin": "2026-10-14T11:00:00.000Z",
        "ressource": "Salle Mont Blanc", "ressourceCode": "SAL-MB", "typeRessource": "salle", "produitSite": "salles"
      },
      "contrat": null,
      "courrier": null
    },
    {
      "id": "0199b1c3-…",
      "nature": "reexpedition",
      "statut": "ready",
      "faitLe": "2026-10-20T15:00:00.000Z",
      "jour": "2026-10-20",
      "tiers": { "clientId": "0199…", "dolibarrId": "412", "nom": "Atelier Martin", "siret": "12345678900012" },
      "produit": "courrier.reexpedition",
      "designation": "Réexpédition d’un pli (lettre, reçu le 12/10/2026)",
      "quantite": 1,
      "unite": "unité",
      "prix": null,
      "frais": { "libelle": "Frais d’affranchissement", "montantCentimes": 450, "montant": "4.50", "devise": "EUR" },
      "reservation": null,
      "contrat": null,
      "courrier": { "pliId": "0199…", "typePli": "lettre", "recuLe": "2026-10-12T08:30:00.000Z", "demandeId": "0199…" }
    }
  ],
  "depuisLe": "2026-11-01",
  "enAttente": { "reexpeditionsSansFrais": 0 }
}
```

À savoir :

- **Les actes du courrier partent sans prix** : leur prix, et ce que le
  contrat du client en comprend (dix ouvertures par mois…), sont à vous —
  produit Dolibarr de même référence (ADR 049) et contrat du tiers.
- **Une réservation porte le prix annoncé au client** (`prix`, son devis figé,
  même règle d'arrondi que les devis) ; sans devis figé (réservation interne),
  `prix` est nul : chiffrez-la au tarif `tarif.<typeRessource>.<unité>`.
  `contrat` est renseigné quand elle est faite au titre d'un contrat (heures
  comprises : à vous de voir).
- **`frais`** : l'affranchissement réel d'une réexpédition, au centime, à
  refacturer tel quel (ligne à part, même TVA que la réexpédition, *à valider
  par l'expert-comptable*). Une réexpédition sans frais relevés attend :
  `enAttente.reexpeditionsSansFrais` les compte.
- `tiers.dolibarrId` est nul si le client n'a pas (encore) de tiers rapproché :
  envoyez d'abord le tiers, ou rapprochez-le par `clientId`.
- `produitSite` : le rayon du back-office (`salles`, `bureaux`, `domiciliation`,
  `vehicules`… et ceux qui viendront) ; nul pour un type pas encore rangé.

### `POST /api/dolibarr/consommations/{id}/transmis`

Dès que la consommation est dans Dolibarr (ligne d'une facture brouillon,
par exemple) :

```json
{ "dolibarrId": "1834", "dolibarrRef": "FA2611-0042" }
```

- **200** `{ "ok": true }` : elle passe « reprise » et sort de la liste des prêtes.
- **Rejouable** : le même `dolibarrId` une seconde fois répond 200 sans rien
  changer. Si l'appel échoue, rappelez-le avant de rien recréer.
- **409** : annulée entre-temps (ne pas la facturer), ou déjà reprise sous un
  autre identifiant.
- **400** : `dolibarrId` absent ou trop long ; **404** : inconnue.

### Les consommations annulées

Une consommation s'annule quand sa source change : réservation annulée ou
déplacée, pli retiré (enregistré par erreur), frais d'affranchissement
corrigés, pages recomptées. Une source modifiée en refait une nouvelle,
« prête ». Interrogez :

```
GET /api/dolibarr/consommations?statut=cancelled&depuis=<date du dernier passage>
```

Celles qui portent un `dolibarrId` étaient reprises : retirez la ligne (facture
brouillon) ou faites l'avoir. Au-delà de trois mois clos, une consommation
reprise ne bouge plus : une correction se fait dans Dolibarr.

### Fréquence et reprise

- **Tiers, puis contrats** : à chaque création ou modification dans Dolibarr,
  et un balayage chaque nuit des fiches modifiées depuis le précédent (date
  `tms`), qui rattrape ce qu'une panne aurait laissé. Toujours le tiers avant
  ses contrats.
- **Consommations** : une fois par jour, la nuit, suffit ; un passage de plus
  avant de facturer le mois. Elles restent « prêtes » tant que `/transmis`
  n'est pas appelé : rien ne se perd si le connecteur s'arrête.
- **En cas d'erreur** : tout est rejouable. Un `5xx` ou une coupure : rejouez
  plus tard, en espaçant. Un `400` ou un `409` : ne rejouez pas en boucle, le
  message dit quoi corriger (dans Dolibarr, ou à l'accueil du centre) ; la
  direction le lit aussi au journal des échanges, sur son écran.

## À valider avec le développeur Dolibarr

Choix faits par défaut par le site (ADR 066), à confirmer ou à changer
ensemble avant d'ouvrir les flux :

1. **Référence commune d'un tiers** : l'identifiant Dolibarr (`rowid`), gardé
   par le site ; SIRET puis SIREN ne servent qu'au premier rapprochement, et
   `clientId` pour les cas que le SIRET ne tranche pas. Pas le SIREN seul : une
   entreprise étrangère, une association ou un particulier n'en ont pas, et
   un SIREN couvre plusieurs établissements.
2. **Fréquence** : tiers et contrats à chaque modification et chaque nuit ;
   consommations chaque nuit (le courrier n'est prêt qu'au mois clos).
3. **Reprise après erreur** : tout rejouable, rien ne se perd ; `5xx` rejoué
   plus tard, `400`/`409` corrigé puis renvoyé.
4. **Avis de facture au client** : **Dolibarr** les envoie (facture et PDF par
   e-mail, plateforme agréée en 2027). Le site n'envoie aucun avis de facture ;
   « Mes factures » de l'espace client reste vide.
5. **Contacts** envoyés dans le tiers (liste complète à chaque envoi) ; le
   contact principal reste choisi par l'accueil.
6. **Un contrat du site = une ressource** : un contrat Dolibarr à plusieurs
   ressources s'envoie ligne par ligne (`dolibarrId` de la ligne).
7. **Type et ressource d'un contrat** déduits des références de produit de ses
   lignes (`tarif.<type>.<code>.<unité>`, ADR 049), ou d'un extrafield :
   à choisir.
8. **Où vont les consommations** : lignes d'une facture brouillon mensuelle par
   tiers (proposé), ou interventions, ou autre — à vous ; `/transmis` reçoit
   l'identifiant que vous choisissez.
9. **Frais d'affranchissement** : ligne à part, même TVA que la réexpédition —
   à confirmer avec l'expert-comptable.
10. **Prospects** : le site ne crée pas de fiche pour un prospect Dolibarr ;
    il met à jour celle qui existe.

## Ce qui existe, ce qui reste à faire

| Sens | Échange | État |
|---|---|---|
| application → Dolibarr | devis (ci-dessus) | disponible |
| Dolibarr → application | produits et tarifs, par le module Webhook ([dolibarr-produits.md](dolibarr-produits.md)) | disponible |
| Dolibarr → application | tiers (entreprises, contacts) : `POST /api/dolibarr/tiers` | **côté site prêt** (ADR 066) ; connecteur à écrire, flux à ouvrir à l'écran |
| Dolibarr → application | contrats (qui occupe quel bureau, qui est domicilié) : `POST /api/dolibarr/contrats` | **côté site prêt** (ADR 066) ; idem |
| application → Dolibarr | consommations facturables : réservations sans devis, actes du courrier, pages en plus, frais d'affranchissement : `GET /api/dolibarr/consommations` + `/transmis` | **côté site prêt** (ADR 066) ; idem |

Hors de cette tranche : « Mes factures » de l'espace client et le chiffre
d'affaires des indicateurs, qui liraient ce que Dolibarr facture ; les écrans
Clients et Contrats du site en lecture seule (ils disent déjà, sur une fiche
reçue, qu'une modification faite ici sera remplacée au prochain envoi).
