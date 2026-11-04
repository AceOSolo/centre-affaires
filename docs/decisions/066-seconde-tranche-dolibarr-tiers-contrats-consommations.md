# ADR 066 — Seconde tranche Dolibarr : tiers, contrats et consommations facturables

**Date** : 2026-11-04
**Statut** : accepté — fait la seconde tranche de l'ADR 046 § 5 côté site, sur
le connecteur de l'ADR 065 (les trois flux qu'il prévoyait « à venir » sont
servis, coupés par défaut) ; amende l'ADR 046 § 2 (le site garde la référence
Dolibarr des fiches reçues) et l'ADR 025 (le prix d'un contrat engagé tenu par
le CRM suit le CRM, hors avenant) ; ne touche pas à la facturation du site,
qui reste en sommeil

## Contexte

Recette du 04/11/2026, lot 10. L'ADR 046 confie à Dolibarr le commercial et
la facturation ; le site garde l'opérationnel et fait la passerelle. La
première tranche est faite (devis vers Dolibarr, ADR 043 ; produits et tarifs
depuis Dolibarr, ADR 049) ; l'ADR 065 a rendu la connexion réglable par
centre et prévu trois flux de plus, coupés : tiers, contrats, consommations.

Un développeur Dolibarr écrit la partie Dolibarr. Le site construit son côté —
l'API et la notice (`docs/integrations/dolibarr.md`) — et liste ce qui reste
à valider avec lui. **Aucune facture n'est faite par le site** (`CLAUDE.md`,
Facturation) : les consommations sont des données transmises, et aucun écran
ni aucune tâche de facturation n'est rouvert.

Points ouverts, à trancher par défaut : la référence commune des tiers, la
fréquence des échanges, la reprise après erreur, qui envoie les avis de
facture.

## Décision

### 1. Trois flux, sur le modèle des devis

| Flux | Routes | Sens de l'appel |
|---|---|---|
| Tiers | `POST /api/dolibarr/tiers`, `GET /api/dolibarr/tiers` | le connecteur envoie |
| Contrats | `POST /api/dolibarr/contrats`, `GET /api/dolibarr/contrats` | le connecteur envoie |
| Consommations facturables | `GET /api/dolibarr/consommations`, `POST /api/dolibarr/consommations/{id}/transmis` | le connecteur vient chercher, puis accuse réception |

**Le site n'appelle jamais Dolibarr** (ADR 043, 046 § 2) : il expose son API,
dans un format à lui, stable et documenté, que le connecteur traduit. La clé
d'appel de l'ADR 065 § 8 reste inutilisée hors du test de connexion.

Chaque route passe par `serveCrmCall` (ADR 065) : jeton du centre, flux ouvert
à l'écran, appel servi pour le centre du jeton, journal. Les trois flux sont
servis par le connecteur Dolibarr (`crm/dolibarr.ts`) et **naissent coupés**
(`enabledByDefault: false`) : la direction les ouvre quand le connecteur est
prêt. Coupé : `403`, avec le message qui dit où l'ouvrir.

### 2. La référence du CRM sur chaque fiche reçue : `crm_links`

Une table de liens, par centre et par CRM : `(entity, local_id) ↔
external_id`, pour les entreprises (`client`), les contacts (`contact`) et
les contrats (`contract`). Un objet du CRM n'est qu'une fiche du site, une
fiche n'est reliée qu'à un objet vivant (deux index uniques). Une suppression
dans le CRM pose `removed_at` : la fiche reste (décision 6), le lien dit d'où
elle venait.

Une table à part plutôt qu'une colonne `dolibarr_id` sur `clients` et
`contracts` : elle vaut pour tout CRM (le produit est multi-CRM, ADR 065), et
ne touche ni la table des clients ni celle des contrats.

### 3. Tiers : Dolibarr fait référence, le site rapproche

**Référence commune : l'identifiant Dolibarr** (`rowid`), gardé dans
`crm_links`. Le SIRET, puis le SIREN, ne servent qu'au **premier
rapprochement** ; le CRM peut aussi désigner la fiche (`clientId`). Ordre :
fiche déjà reliée ; fiche désignée ; seule fiche vivante non reliée au même
SIRET ; seule au même SIREN ; sinon une fiche est créée pour un client — **pas
pour un prospect** ni un tiers fermé. Jamais deux tiers pour une fiche ni deux
fiches pour un tiers : un doublon est refusé (`409`), sans deviner.

Sur une fiche reliée, raison sociale, forme juridique, SIRET, TVA, courriel,
téléphone, adresse et statut sont ceux du CRM ; **un champ absent est vidé**.
Le reste — notes, accès à l'espace client, courrier, réservations — reste au
site. Une fiche anonymisée (ADR 040) ou archivée ne se met plus à jour.

Les **contacts** viennent dans l'envoi du tiers : présents, ils remplacent
ceux reçus avant (créés, mis à jour, retirés par `deleted_at`) ; ceux saisis
sur le site ne bougent pas ; le contact principal reste un choix de l'accueil
(son index unique n'est jamais heurté).

Règles : `clients/tiers-crm.ts` (pures), `clients/tiers-crm-queries.ts` (une
transaction par envoi).

### 4. Contrats : une copie pour l'occupation

Le contrat reçu s'écrit dans `contracts`, et **l'occupation suit par la base**
(`apply_contract_occupation`, ADR 018) : un contrat en cours occupe sa
ressource, une résiliation datée la raccourcit, une suppression l'archive et
libère la ressource, un chevauchement est refusé (`CA000`, décision 3). La
disponibilité ne se vérifie jamais en code.

- Le tiers doit être reçu avant (`409` sinon) ; la ressource est désignée par
  son **code** (écran Ressources, ou la référence de tarif de la ligne,
  ADR 049).
- **Une ressource par contrat** : un contrat Dolibarr qui loue un bureau et un
  casier s'envoie ligne par ligne, chacune sous son identifiant.
- **Pas de reconduction tacite** sur le site pour un contrat reçu (la tâche de
  nuit l'ignore) : le terme est celui que le CRM envoie. Un contrat du site
  rapproché (même client, même référence) perd la sienne.
- **Le prix** reçu est celui que l'espace client affiche ; il ne sert à aucune
  facture. Il suit le CRM même sur un contrat engagé : `contracts_before_update`
  laisse passer prix, TVA, périodicité et engagement sous la variable de
  session `@app_crm_sync`, que seul `contrats-crm-queries.ts` pose, le temps
  de sa transaction. Hors de ce chemin, `CA004` tient comme avant.

### 5. Consommations : un registre d'instantanés, `crm_consumptions`

**Ce qui est une consommation** (`crm/consommations.ts`) :

| Nature | Source | Valide tant que | Prête quand |
|---|---|---|---|
| réservation | `bookings` | confirmée, d'un client, **sans devis vivant** | terminée |
| ouverture | `mail_items` | ouvert, pas retiré | son mois est clos |
| pages | `mail_scans` | contenu numérisé à l'ouverture, compté | mois clos, pages au-delà des comprises (`billablePages`) |
| numérisation | `mail_requests` `scan` | faite, pli pas retiré | mois clos |
| réexpédition | `mail_requests` `forward` | faite, pli pas retiré | mois clos, frais relevés |

- **Génériques** : une réservation de toute ressource — salle, bureau, camion,
  matériel (lot 6) — sans liste de types écrite ; le rayon du site se déduit à
  la lecture (`produits.ts`), jamais en base. Les actes se nomment par le code
  de leur service (`courrier.ouverture`…, ADR 049).
- **Un devis vivant exclut sa réservation** : Dolibarr la facture à partir du
  devis (ADR 043) ; la compter aussi la ferait payer deux fois. La règle tient
  en un endroit (`coveredByProposal`, `consommations-queries.ts`).
- **« Prête » = ne peut plus changer** : une réservation se déplace jusqu'à sa
  fin ; les pages se corrigent jusqu'à la fin du mois (`CA017`) — le courrier
  part donc au mois, comme le relevé qu'on reportait à la main.
- **Date de départ** (`crm_connections.consumptions_from`, jour du centre) :
  rien d'antérieur n'est pris, ce qui a été facturé à la main ne repart pas.
  Posée au jour de l'ouverture du flux, réglable à l'écran.
- **Sans prix pour les actes** : leur prix et ce que le contrat du client en
  comprend sont tenus par Dolibarr. Une réservation porte son **devis figé**
  (ADR 023), le prix annoncé au client ; sans devis figé, pas de prix. Les
  frais d'affranchissement partent au centime, à part.
- **Instantané** : pris quand la source est prête, il ne se réécrit jamais
  (`58-consommations.sql`, `CA018`). Chaque passage compare l'empreinte de la
  source : changée (déplacée, recomptée, frais corrigés, client changé), la
  consommation est **annulée et une nouvelle la remplace** ; source annulée ou
  retirée, annulée avec son motif. Les transmises se revoient sur trois mois
  clos ; au-delà, une correction se fait dans Dolibarr.
- **Aucun doublon** : une consommation vivante au plus par source (index
  unique) ; les passages d'un centre se suivent (verrou du réglage du centre).
- **Le passage se fait à la lecture** : `GET …/consommations` met le registre à
  jour, puis le sert. Pas de tâche planifiée de plus sur le serveur.

### 6. Accusé de réception, fréquence, reprise

- `POST …/consommations/{id}/transmis` : `ready` → `sent`, avec l'identifiant
  et la référence Dolibarr. **Rejouable** ; `409` pour une annulée ou un autre
  identifiant. Les annulées se lisent par `?statut=cancelled&depuis=` ; une
  annulée après reprise garde son identifiant Dolibarr.
- **Fréquence** (par défaut) : tiers et contrats à chaque modification dans
  Dolibarr, et un balayage chaque nuit ; consommations chaque nuit.
- **Reprise** : tout est rejouable et rien ne se perd — les envois de tiers et
  de contrats répondent « inchangé » au second passage, une consommation reste
  prête tant qu'elle n'est pas accusée. `5xx` : rejouer plus tard ; `400`,
  `409` : corriger, le message le dit, la direction le lit au journal.

### 7. Les avis de facture : Dolibarr

Dolibarr émet les factures ; **il envoie l'avis au client** (e-mail et PDF,
plateforme agréée en 2027). Le site n'envoie aucun avis de facture : ses
modèles `invoice_issued` et `invoice_reminder` (ADR 038) restent en sommeil
avec la facturation.

### 8. L'écran

- Réglages > Connexion au CRM : les trois flux s'y ouvrent ; sous les
  consommations, « Transmettre les consommations faites à partir du » (date de
  départ), et un compte des prêtes, reprises et annulées.
- Fiches client et contrat : une ligne dit qu'elles sont tenues par Dolibarr
  (n°, dernier envoi) et qu'une modification faite ici sera remplacée au
  prochain envoi (`crm/origine-crm.tsx`).

## Justification

**Le connecteur envoie tiers et contrats dans le format du site, plutôt que le
module Webhook.** Le Webhook suffit aux produits (ADR 049), dont la place se lit
dans la référence. Un contrat, lui, demande la ressource, le tiers et une
période par ligne, que l'objet `Contrat` envoyé tel quel ne porte pas de façon
sûre d'une version à l'autre ; et le connecteur existe déjà pour les devis. Un
format à nous se teste, se documente et ne dépend d'aucune version de
Dolibarr.

**L'identifiant Dolibarr plutôt que le SIREN comme référence.** Toute fiche a
un identifiant, pas toute entreprise un SIREN (étrangère, association,
particulier) ; un SIREN couvre plusieurs établissements, et un SIRET se
corrige. Le SIRET sert là où il est sûr : au premier rapprochement.

**Le contrat dans `contracts`, pas dans une table à lui.** L'occupation, le
planning, « qui est domicilié », l'espace client, les états des lieux lisent
déjà `contracts` ; une autre table aurait demandé de tout doubler.

**Des instantanés plutôt qu'un calcul à chaque lecture.** Le CRM doit savoir ce
qu'il a repris : une réservation déplacée après coup ne doit pas changer en
silence ce qu'il a facturé. L'instantané figé, annulé et remplacé quand la
source change, le dit, et l'index unique interdit le doublon.

**Le passage à la lecture plutôt qu'une tâche de nuit.** Une ligne de crontab
de moins à poser en production, et ce que lit le CRM est toujours à jour.

## Alternatives écartées

- **Le site interroge l'API REST de Dolibarr** (avec la clé de l'ADR 065) :
  contraire au modèle des devis, dépendant de la version de Dolibarr, et une
  tâche planifiée de plus.
- **Le SIREN comme seule référence** : voir ci-dessus.
- **Créer une fiche pour chaque prospect Dolibarr** : chaque devis public en
  crée un ; le site s'en encombrerait sans usage (ADR 040 les anonymise).
- **Chiffrer les actes sur le site** (règle `priceActs` du lot en sommeil) :
  prix et inclus sont dans les contrats Dolibarr ; les chiffrer ici, c'est
  facturer deux fois la même règle.
- **Envoyer les actes du courrier au fil de l'eau** : leurs pages se corrigent
  jusqu'à la fin du mois (`CA017`).
- **Un contrat à plusieurs ressources** : `contracts.resource_id` n'en porte
  qu'une ; une ligne par ressource suffit.
- **Accusé de réception par lots** : un appel par consommation, comme les
  devis ; quelques centaines par mois.

## Écarts avec `CLAUDE.md` et les ADR, assumés

- **ADR 046 § 2, « le site ne tient ni identifiant ni version de Dolibarr »** :
  il tient désormais l'identifiant des fiches reçues, comme le demande l'ADR
  046 § 5 ; toujours aucune version.
- **ADR 025, « un contrat engagé change par avenant » (`CA004`)** : pas la
  copie d'un contrat tenu par le CRM, qui suit le CRM. L'exception tient à une
  variable de session posée par un seul module.
- **ADR 046 § 5, « écrans Clients et Contrats en lecture seule »** : pas fait.
  Les écrans restent modifiables ; une fiche reçue dit qu'une modification
  faite ici sera remplacée au prochain envoi. À faire, avec la disparition des
  écrans Offres, Services et Tarifs.
- **ADR 046 § 5, « arrêt de la reconduction tacite de nuit »** : pas pour tous ;
  les contrats reçus n'en ont pas, ceux du site seul la gardent.
- **ADR 046 § 2, « services ponctuels »** : aucun n'existe sur le site hors
  devis ; rien n'est transmis pour eux.
- **Code `CA018`** : pris pour les consommations ; d'autres lots en cours
  peuvent l'avoir pris aussi, à renuméroter à la fusion.

## Conséquences

- **Migration 0009** (`crm_links`, `crm_consumptions`,
  `crm_connections.consumptions_from`) et règles rejouées
  (`58-consommations.sql`, `40-contrats.sql`) : `docker compose run --rm
  migrer` (`infra/serveur/README.md` § 4). Aucune variable nouvelle, aucune
  tâche planifiée nouvelle.
- **Rien ne change en production** tant que la direction n'ouvre pas les flux.
  Ouvrir les consommations pose leur date de départ au jour même.
- **Pour le développeur Dolibarr** : la notice (§ « Seconde tranche ») et la
  liste « À valider avec le développeur Dolibarr ».
- Hors périmètre, inchangés : « Mes factures » (R17), vide ; le chiffre
  d'affaires des indicateurs (R31), vide — la lecture ne tombe pas d'elle-même
  (il faudrait recevoir les factures de Dolibarr).
- **Lot 6 (matériel)** : une réservation de matériel est une consommation
  comme une autre. Un appareil ajouté à une salle **dont le devis porte le
  prix** doit être exclu : l'ajouter à `coveredByProposal`.
- **Lot 5 (plusieurs jours)** : la désignation d'une réservation est celle des
  devis (`describeSlot`, « du … au … »).
- **RGPD** : les instantanés ne portent ni expéditeur ni titre de réservation ;
  les messages au journal désignent les fiches par leur identifiant, jamais par
  leur nom (ADR 065 § 10). Les consommations, pièces de facturation, se
  gardent comme les devis.

## Tests

`crm/consommations.test.ts` (ce qui en est une, quand elle est prête — date de
départ, mois clos au fuseau du centre, réservation terminée, pages, frais —,
annulations et remplacement, empreinte, instantané, format lu par le CRM, type
de ressource quelconque), `crm/consommations.db.test.ts` (chaque nature une
fois, rien en double au second passage, devis vivant exclu, mois en cours et
date de départ, annulation et remplacement, accusé rejouable et refusé,
identifiant du tiers, filtre de centre, garde `CA018` et unicité par source),
`clients/tiers-crm.test.ts` et `.db.test.ts` (lecture, rapprochement par lien,
fiche désignée, SIRET, SIREN, doublons refusés, prospect, contacts,
suppression, fiche anonymisée, deux centres), `contrats/contrats-crm.test.ts`
et `.db.test.ts` (lecture, occupation au fuseau du centre, résiliation, prix
suivi et `CA004` intact hors du CRM, chevauchement refusé sans rien écrire,
tiers manquant, ressource inconnue, suppression, rapprochement par référence,
deux centres), `api/dolibarr/seconde-tranche.db.test.ts` (404 sans jeton,
flux nés coupés, formats, journal sans raison sociale, envois illisibles),
`crm/connecteurs.test.ts` (les trois flux servis, coupés par défaut).
