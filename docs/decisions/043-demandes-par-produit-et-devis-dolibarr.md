# ADR 043 — Demandes par produit, devis structuré repris par Dolibarr

**Date** : 2026-10-20
**Statut** : accepté — amende l'ADR 016 (Dolibarr devient le logiciel des
devis et des factures ; la bascule de la facturation est renvoyée à un ADR
suivant), précise l'ADR 005 (une demande publique porte désormais un devis) et
l'ADR 036 (une réservation de l'espace client aussi) ; les choix marqués
« à valider » attendent le centre

## Contexte

Demande de l'exploitant (20/10/2026) : la réservation doit différer selon le
produit loué — salle, camion, domiciliation —, chaque produit posant ses
propres questions, et chaque demande doit produire un **devis** que le
développeur de l'exploitant raccorde au **Dolibarr** de l'entreprise.

L'exploitant a précisé deux points (questions posées le même jour) :

- **Dolibarr fait les factures**, pas seulement les devis ;
- le prix est calculé d'office quand c'est possible, sinon établi par
  l'accueil ; le camion se loue **au temps, comme une salle** (heure,
  demi-journée, journée), sans compter les kilomètres.

Ce qui existait :

- une seule page de demande, pensée pour les salles (ADR 005), avec un prix
  figé sur la réservation (`bookings.quote_*`, ADR 023) — c'est le seul
  « devis » de l'application, une ligne de prix sans document ;
- la domiciliation ne se réserve pas : elle se vend par une offre et un
  contrat préparés par l'accueil (ADR 024, 028, 036) ;
- le type de ressource `vehicule` existe, sans véhicule au catalogue ni tarif
  (ADR 009) ;
- **toute la facturation est construite dans l'application** (ADR 016, 026 à
  034) : factures, avoirs, lot mensuel, relances, prélèvements, export FEC.

« Dolibarr fait les factures » contredit ce dernier point, qui était une
décision structurante. `CLAUDE.md` impose de le consigner ici plutôt que de
l'appliquer en silence.

## Décision

### 1. Trois produits, trois questionnaires

`ProposalProduct` : `espace` (salle ou bureau), `vehicule` (camion,
utilitaire), `domiciliation`. Les questions de chacun sont décrites **une
fois**, dans `reservations/questionnaires.ts` : le formulaire de la page
publique, celui de l'espace client et celui du back-office les montent
(`QuestionnaireFields`), le serveur les relit et les valide (`parseAnswers`).
Une valeur hors des choix est refusée ; le SIREN est contrôlé (clé de Luhn) et
exigé seulement pour une société déjà immatriculée.

| Produit | Calendrier | Questions | Validation d'office |
|---|---|---|---|
| Salle ou bureau | oui | participants, type de rendez-vous, disposition, équipements, restauration, accès PMR | oui, si chiffré |
| Camion ou utilitaire | oui | usage, trajet, kilomètres estimés, chargement, permis B depuis deux ans | non |
| Domiciliation | non | situation (création, immatriculée, transfert), raison sociale, forme juridique, SIREN, date de début, traitement du courrier, services en plus, durée envisagée | non |

**Minimisation (RGPD)** : rien n'est demandé au-delà de ce qu'il faut pour
chiffrer. Les pièces d'une domiciliation (identité du dirigeant, justificatif
de domicile, statuts ou Kbis) et le permis du conducteur se vérifient à la
signature et à la remise des clés, pas au devis ; aucun fichier n'est déposé.

**À valider par le centre** : les questions, leurs choix, et quels produits
partent d'office vers Dolibarr. Le camion passe par l'accueil (permis,
caution), la domiciliation aussi (vérifications du domiciliataire avant
contrat).

### 2. Le devis est une donnée structurée de l'application

Tables `proposals` et `proposal_lines` (`facturation/schema-devis.ts`,
migration 0001). Un devis porte :

- un numéro du centre, `DV-AAAA-NNNN`, par `next_document_number('proposal')`
  (ADR 021) — Dolibarr pose le sien, les deux se répondent ;
- son produit, son canal (`public`, `client`, `staff`), l'entreprise cliente
  ou le demandeur tel qu'il s'est présenté (nom, adresse, téléphone, société),
  la réservation qui tient le créneau (espace, véhicule ; aucune pour une
  domiciliation : contrainte `proposals_booking_matches_product`) ;
- les réponses au questionnaire (`answers`, JSON validé par le code), le
  message du demandeur, une note de l'accueil ;
- des lignes : désignation, unité, quantité entière, prix unitaire HT en
  centimes, remise (pourcentage **ou** montant), TVA, montant HT calculé par
  la base par la règle d'arrondi unique (ADR 023), et leur source :
  `booking` (le prix figé de la réservation, repris tel quel), `service` (un
  service du catalogue, ADR 024) ou `manual` (saisie de l'accueil).

Pas de PDF : Dolibarr rend le document (`CLAUDE.md`, Facturation).

### 3. Le cycle est tenu par la base

`src/db/regles/52-devis.sql`, SQLSTATE `CA016` :

```
draft ──► ready ──► sent ──► accepted | refused
  ▲  │      │         │
  └──┼──────┘         │
     └──► cancelled ◄─┘
```

- un devis naît `draft` ; `ready` exige au moins une ligne, `sent`
  l'identifiant Dolibarr ; les dates de chaque étape sont posées par la base ;
- son contenu (destinataire, réponses, lignes) ne change qu'en brouillon : ce
  que Dolibarr a repris est ce que le centre a validé. Un devis prêt et pas
  encore repris peut revenir en brouillon ; transmis, il ne revient plus
  (on l'annule et on en refait un) ;
- une réservation a **au plus un devis vivant** (non annulé) : index unique
  `proposals_tenant_booking_live_key` sur `(tenant_id, booking_id, live)`,
  `live` valant 1 tant que le devis n'est pas annulé (migration 0004, MySQL
  n'ayant pas d'index partiel). Un devis annulé reste consultable et ne
  bloque plus la réservation : l'accueil la rechiffre d'un nouveau devis
  (« Refaire le devis », fiche de la réservation ou du devis annulé) ;
- numéro, produit, canal et réservation ne changent jamais ; ni devis ni
  ligne ne se suppriment (décision 6) ;
- **une réservation annulée annule son devis encore ouvert**, transmis
  compris (`bookings_cancel_proposal`) : refus d'une demande, annulation par
  le client ou par l'accueil. Un devis signé ou refusé reste tel quel ;
- sous portée client (ADR 019), seul le dépôt d'un brouillon de l'entreprise
  passe, et sa validation d'office s'il s'agit d'un espace (`CA015` sinon).

### 4. Chaque demande produit son devis, dans la même transaction

- **Page publique** (ADR 005) : choix du produit, puis le parcours du
  produit. Pour un espace ou un véhicule, `createBookingRequest` écrit la
  demande `pending` et son devis ensemble ; un créneau pris n'écrit ni l'un
  ni l'autre. Pour une domiciliation, le devis seul.
- **Espace client** (ADR 036) : `createPortalBooking` écrit la réservation
  et son devis ensemble, avec les réponses au questionnaire.
- **Back-office** : l'accueil établit un devis depuis une réservation
  (« Établir le devis ») ou de zéro (domiciliation au téléphone), le complète
  (lignes du catalogue ou saisies) et le valide.

Un devis chiffré d'office (une ligne `booking`) d'un produit à validation
d'office passe `ready` à la création ; sinon il attend l'accueil (`draft`,
« À compléter »).

### 5. Dolibarr vient chercher les devis : une API à nous, stable

L'application ne parle pas à Dolibarr ; le développeur de l'exploitant écrit
le connecteur. Elle expose, sous le jeton `DOLIBARR_API_TOKEN` (comme les
routes de maintenance : sans jeton, 404) :

| Appel | Effet |
|---|---|
| `GET /api/dolibarr/devis` | devis prêts, au format documenté, les plus anciens d'abord |
| `GET /api/dolibarr/devis?statut=cancelled&depuis=…` | devis annulés depuis une date (à fermer dans Dolibarr) |
| `POST /api/dolibarr/devis/{id}/transmis` | repris : `{ dolibarrId, dolibarrRef }` ; rejouable sans effet |
| `POST /api/dolibarr/devis/{id}/issue` | `{ issue: "signe" \| "refuse" }` ; rejouable sans effet |

Le format (`toDolibarrProposal`) est décrit pour le développeur dans
`docs/integrations/dolibarr.md` : tiers (fiche client ou prospect), contact,
réservation, réponses en clair et brutes, lignes avec prix en centimes et en
décimal, TVA et remise en pourcentage, totaux.

### 6. Dolibarr facture : en attendant la bascule, pas de double facturation

L'émission des factures par l'application sera mise en sommeil au profit de
Dolibarr. **Cette bascule n'est pas faite ici** : elle touche le lot mensuel,
les loyers et forfaits des contrats, les actes du courrier, les relances, les
mandats SEPA et l'export comptable, et se prépare avec le développeur
Dolibarr. Elle fera l'objet d'un ADR suivant.

Une garde est posée dès maintenant : **le lot de facturation de
l'application laisse de côté toute réservation qui a un devis vivant**
(non annulé) — c'est Dolibarr qui la facture. Une réservation sans devis
(antérieure, interne, ou au devis annulé) reste facturée par le lot.

## Justification

**Une table de devis plutôt qu'un statut de plus sur la réservation.** La
domiciliation n'a pas de créneau, une réservation n'a pas de questionnaire,
et un devis a ses lignes, son cycle et sa référence Dolibarr. Les mêler à
`bookings` aurait rendu la réservation facultative sur le créneau, ou le
devis impossible sans créneau.

**Le questionnaire en code plutôt qu'en base.** Trois produits, une dizaine
de questions chacun, qui changent rarement et que le serveur doit valider :
une description typée, testée et relue suffit. Un éditeur de formulaires à
l'écran serait un produit à lui seul. Si le centre veut changer ses
questions souvent, ce sera un ADR.

**Les réponses en JSON.** Elles diffèrent par produit et ne servent ni de
filtre ni de calcul : une colonne par question ferait une table de quarante
colonnes presque toutes vides. C'est la décision 2 (`attributes`) appliquée
aux demandes.

**Dolibarr vient chercher (pull) plutôt que l'application n'envoie (push).**
L'application ne dépend ni de la version de Dolibarr, ni de sa disponibilité,
ni de ses identifiants ; une coupure ne perd rien (le devis reste « prêt »),
et chaque appel est rejouable. Le développeur choisit sa fréquence et son
outil (tâche planifiée, module Dolibarr).

**Le prix figé repris tel quel.** Le demandeur a vu un montant (ADR 023, R11) ;
la ligne `booking` le recopie, au centime, et Dolibarr facture ce qui a été
annoncé.

**La garde du lot dès maintenant.** Sans elle, une réservation dont Dolibarr
facture le devis serait facturée une seconde fois par le lot mensuel de
l'application, le jour où il est lancé.

## Alternatives écartées

**Un formulaire par type de ressource** (salle, bureau, véhicule, casier,
boîte aux lettres) : la salle et le bureau posent les mêmes questions, et la
domiciliation n'est pas une ressource qu'on réserve.

**L'application crée la proposition dans Dolibarr** (appel de l'API REST de
Dolibarr) : le connecteur est le travail du développeur de l'exploitant, et
l'application aurait à tenir les identifiants, les versions et les reprises
sur erreur d'un logiciel qu'elle ne maîtrise pas.

**Arrêter tout de suite la facturation de l'application** : la bascule
demande de décider qui facture les loyers, les forfaits et les actes du
courrier, et comment Dolibarr les apprend. Couper avant d'avoir la réponse
laisserait des contrats sans facture.

**Déposer les pièces de la domiciliation avec la demande** : des documents
d'identité de prospects qui ne donneront pas suite, sans base légale tant
qu'aucun contrat n'est envisagé (minimisation).

## Conséquences

- Toute nouvelle demande produit un devis. Les réservations posées par
  l'accueil au back-office n'en ont pas tant que l'accueil ne l'établit pas
  (« Établir le devis »).
- `DOLIBARR_API_TOKEN` est à poser sur le VPS et à remettre au développeur
  Dolibarr (`.env.example`, `infra/serveur/.env.example`).
- **Déplacer une réservation** refait son prix figé (ADR 023) mais pas la
  ligne de son devis : la fiche du devis le signale si c'est arrivé après la
  transmission. Un devis encore brouillon se corrige à la main. Recalculer la
  ligne d'office est reporté.
- **RGPD** : `proposals` porte les coordonnées de prospects et leurs réponses.
  Leur durée de conservation et leur anonymisation (ADR 040) restent à écrire,
  comme celles des demandes publiques (ADR 005) ; la base laisse déjà passer
  l'effacement sous `@app_anonymization`.
- La limitation du nombre de demandes par adresse (ADR 005) compte les
  réservations, pas les demandes de domiciliation.
- **À trancher avec le développeur Dolibarr** (ADR suivant) : qui facture les
  loyers et forfaits des contrats et les actes du courrier, comment Dolibarr
  apprend les consommations, que deviennent les relances, les prélèvements et
  l'export comptable de l'application, et si la plateforme agréée de la
  réforme 2026-2027 est raccordée à Dolibarr.
- **À valider par le centre** : les questionnaires, la validation d'office
  des seuls espaces chiffrés, la liste des services du catalogue proposés à
  l'accueil pour chiffrer une domiciliation.

## Tests

`questionnaires.test.ts` (validation des réponses, SIREN, réponses en clair),
`propositions.db.test.ts` (création avec la demande et validation d'office,
camion en brouillon, numérotation, cycle et lignes figées, montant par la
règle commune, ni suppression, reprise Dolibarr rejouable et format, issue,
annulation qui suit la réservation, portée client, atomicité réservation et
devis, devis refait après annulation et deux devis vivants refusés),
`lot.db.test.ts` (une réservation au devis vivant n'est pas facturée par le
lot).
