# Raccorder Dolibarr aux devis de l'application

Pour le développeur qui écrit le connecteur Dolibarr. Décision et raisons :
[ADR 043](../decisions/043-demandes-par-produit-et-devis-dolibarr.md).

Les produits et les tarifs vont dans l'autre sens, de Dolibarr vers le site,
par le module Webhook de Dolibarr et sans code : voir
[dolibarr-produits.md](dolibarr-produits.md) (ADR 049).

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
- Jeton : `Authorization: Bearer <DOLIBARR_API_TOKEN>`. L'exploitant le génère
  (`openssl rand -base64 32`), le pose dans le `.env` du VPS et vous le remet.
- Sans jeton valide, ou si le jeton n'est pas configuré, **toutes les routes
  répondent 404** : c'est voulu, elles n'existent pas pour les autres.
- Réponses en JSON, UTF-8. Instants en UTC, ISO 8601 (`2026-11-03T08:00:00.000Z`).

## `GET /api/dolibarr/devis`

| Paramètre | Défaut | Sens |
|---|---|---|
| `statut` | `ready` | `ready`, `sent`, `accepted`, `refused`, `cancelled` (ou `draft`, sans intérêt pour vous) |
| `depuis` | — | instant ISO : seulement les devis modifiés depuis |
| `limite` | 100 | 1 à 500 |

Tri : du plus ancien au plus récent (par date de dernière modification).

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
- **404** : devis inconnu (ou jeton invalide).

## `POST /api/dolibarr/devis/{id}/issue`

Quand la proposition est signée ou refusée dans Dolibarr :

```json
{ "issue": "signe" }
```

`"signe"` ou `"refuse"`. Rejouable. **409** si le devis n'a pas été transmis,
ou a déjà l'autre issue.

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

## La suite : les factures

L'exploitant a choisi de faire aussi **les factures** dans Dolibarr. Ce
premier raccordement ne couvre que les devis. Dès aujourd'hui, la facturation
interne de l'application **ne facture plus une réservation qui a un devis**
(c'est Dolibarr qui la facture à partir du devis signé).

Restent à décider ensemble, avant d'arrêter la facturation de l'application
(un ADR suivant) : qui facture les loyers et forfaits des contrats (bureaux,
domiciliation) et les actes du courrier (ouvertures, numérisations,
réexpéditions), et comment Dolibarr apprend ces consommations ; ce que
deviennent les relances, les prélèvements SEPA et l'export comptable ; et le
raccordement de Dolibarr à une plateforme agréée pour la facture électronique
(réception obligatoire depuis septembre 2026, émission au 1er septembre 2027).
