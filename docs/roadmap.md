# Roadmap — couverture du cahier des charges DOMOTOP

État au 30/09/2026. Audit de l'arbre de travail (fichiers non commités compris)
face aux deux documents du 18/09/2026 :

- *DOMOTOP — Application de gestion de centre d'affaires* (support, 25 slides)
- *09-18 Analyse — Cahier des charges application de gestion de centre d'affaires*

Les documents découpent le projet en trois lots : **1. socle d'exploitation**,
**2. monétisation**, **3. autonomie client**. `CLAUDE.md` en fait six tranches.
Les deux ordres concordent, sauf sur la facturation (voir D1).

Statuts : ✅ couvert de la base à l'écran · ◐ partiel · ○ absent ·
⟳ en cours dans une autre session. Effort : S < 1 j, M 1–3 j, L > 3 j.

## Synthèse

**5** exigences couvertes, **18** partielles, **10** absentes, sur 33.

| Réf. | Exigence | Statut | Ce qui manque | Effort | Phase |
|---|---|---|---|---|---|
| R01 | Catalogue multi-types, attributs, capacité | ◐ | Écran de modification d'une ressource ; numéro de casier | S | 1 |
| R02 | Calendrier par ressource, interne et client | ✅ | Les ressources occupées par contrat (bureau, boîte) paraissent libres — voir D6 | M | 1 |
| R03 | Planning back-office | ◐ | Semaine toutes ressources (contre ADR 011), vue mois, filtre par type, filtre par client | L | 1 |
| R04 | Anti-chevauchement | ✅ | Tests de charge ; aucune exclusion sur `contracts.resource_id` | S–M | 1 |
| R05 | Réservation : créneau, statut, canal, client, contrat | ◐ | Colonne canal, `contract_id` (`client_id` migré en 0023) | M | 1 |
| R06 | États des lieux configurables avec photos | ○ | Tout : modèles de champs en base, inspections, photos compressées | L | 4 |
| R07 | CRM : fiche, contacts, historique | ◐ | Services souscrits sur la fiche, avec R18 (place réservée). Faits en vague 1 : contacts CRM distincts des accès, historique des réservations, recherche par SIRET ou contact | S | 2 |
| R08 | Grilles jour / semaine / mois | ◐ | Unité `week` ; dates de validité ignorées | S–M | 2 |
| R09 | Offres groupées ressources + services | ○ | Catalogue de services, offres, lignes d'offre | L | 2 |
| R10 | Remises, engagement, prorata paramétrables | ◐ | Prorata fait mais codé en dur ; remises et engagement absents | L | 2 |
| R11 | Moteur tarifaire unique | ◐ | Aucun total calculé (`priceCents` n'est appelé que par les tests) ; grille du contrat ignorée au portail | M | 2 |
| R12 | Contrat généré, PDF, avenants | ◐ | Saisie manuelle, ni modification ni archivage, pas de PDF ni d'avenant | L | 1–2 |
| R13 | Facturation intégrée | ○ | Factures, numérotation, TVA, génération périodique — voir D1 | L | 2 |
| R14 | Actes à l'acte sur la facture | ◐ | Ouvertures comptées (CSV), pas valorisées ni facturées | M | 2 |
| R15 | Facture = location + forfaits + actes | ○ | Lignes typées reliées à leur source | M | 2 |
| R16 | Export comptable, paiement, e-facturation | ○ | Format d'export, mode de paiement, plateforme agréée | L | 1 (cadrage) – 2 |
| R17 | Contrats et factures côté client | ○ | Pages « Mes contrats », « Mes factures » | S–M | 3 |
| R18 | Forfaits de services souscrits | ○ | Tables `services`, `subscribed_services`, écrans | M | 2 |
| R19 | Réception du courrier, photo d'enveloppe | ✅ | Photo facultative (à rendre obligatoire ?) | S | — |
| R20 | Notification à la réception | ✅ | Courriel à l'arrivée et à la numérisation, alerte au staff sur demande d'ouverture. Effectif en production une fois `SMTP_URL` et `MAIL_FROM` configurés (SMTP en UE) | — | — |
| R21 | Espace courrier client | ◐ | Réexpédition absente ; ouverture et scan fusionnés ; une seule demande par pli | L | 3 |
| R22 | Scans : chiffrement, accès journalisé, purge | ✅ | Accès restreint et journalisé, purge nocturne, chiffrement au repos (ADR 020). Reste en production : créer la clé, lancer la reprise `infra/chiffrer-documents.ts` | — | 0 |
| R23 | Réservation en ligne côté client | ◐ | Réservation depuis le compte, total affiché, « Mes réservations », offre groupée | L | 3 |
| R24 | Traçabilité côté client | ◐ | Historique des demandes (une annulation efface la trace), documents | M | 3 |
| R25 | Responsive | ◐ | Plusieurs cibles sous 44 px sur le portail | S | 3 |
| R26 | Moteur de notifications | ◐ | Envoi SMTP en place (`src/lib/courriel.ts`) ; modèles éditables et historique des envois absents ; déclencheurs limités au courrier | M–L | 3 |
| R27 | Rôles exploitant / accueil / client | ◐ | Exploitant et accueil non distingués ; pas de matrice des droits | M | 1 |
| R28 | Comptes isolés, second facteur staff | ◐ | Isolation entre clients applicative seulement. Second facteur écarté (ADR 016) | M | 1 |
| R29 | Registre RGPD, durées de conservation | ◐ | Registre et tableau des durées écrits (`docs/rgpd/`). Restent : valider les durées proposées, archiver les DPA, évaluer l'AIPD du courrier, construire l'anonymisation des clients, contacts et comptes | S | 0 |
| R30 | Sauvegardes, restauration, reprise | ◐ | Script, procédure, plan de reprise et exercice local faits (ADR 022, `docs/exploitation/`). Restent : installation sur le VPS (rôle `sauvegarde`, destination, clés), premier exercice sur Neon | S | 0 |
| R31 | Indicateurs (occupation, revenu) | ○ | Tableau de bord ; le revenu dépend de la facturation | M–L | 2 |
| R32 | Une seule API métier | ✅ | — | — | — |
| R33 | Stockage documentaire | ◐ | Région UE contrôlée par `stockage.ts` ✅ ; compression et purge des photos (vague 4) | M | 4 |

Le catalogue détaillé des exigences, chacune avec sa source (slide ou section),
se trouve en annexe.

## Bloquants — avant toute nouvelle tranche

- ~~**B1. `bookings.client_id` n'a pas de migration.**~~ Résolu : la migration
  0023 crée la colonne, la clé étrangère et l'index.
- **B2. Courrier, comptes clients, stockage et agenda Google : commités, pas
  encore sur `main`.** Ils sont sur la branche `feat/compte-client-courrier`
  (commits `aea45b0` et `0627417`, migrations 0019 à 0024, ADR 014 et 015).
  → Pull request vers `main`, puis déploiement.
- ~~**B3. Les scans sont stockés en clair et les branches Neon les copient.**~~
  Résolu dans le code : les documents sont chiffrés avant dépôt, avec une clé
  propre à chaque environnement (ADR 020). Reste en production : lancer la
  reprise des objets existants, puis supprimer les branches créées avant elle
  (`infra/serveur/README.md`, « Chiffrement des documents »).
- **B4. Durées de conservation et purge : en cours pour le courrier.** L'ADR 015
  en fait un préalable à la mise en production du courrier.
  - Déjà posé : une durée par centre pour les scans et pour le journal d'accès
    (migration 0023, 12 mois par défaut), la purge du journal (fonction de la
    migration 0024) et `src/modules/courrier/conservation.ts`.
  - Fait : coordonnées des demandes publiques effacées par la tâche nocturne au
    terme de leur durée (12 mois par défaut, `infra/configurer-centre.mjs`,
    ADR 020).
  - Reste à faire : poser la tâche nocturne sur le serveur
    (`infra/serveur/README.md`), et fixer la durée des comptes `neon_auth`.
- **B5. Écarts de gouvernance.**
  - ~~Numéros d'ADR en double (deux 010, deux 013) et pas d'ADR 007.~~ Signalés
    par l'index `docs/decisions/README.md`, sans renuméroter.
  - ~~`rate_plan_items` est supprimé physiquement, contre la décision 6.~~
    Retrait logique (`deleted_at`), ignoré des lectures ; les prix d'une grille
    archivée sont figés.
  - ~~Le commentaire `neon.ts:9` annonce des URL signées, que l'ADR 015 écarte.~~
    Corrigé.
  - `CLAUDE.md` indique PostgreSQL 17, alors que l'ADR 003 et la CI utilisent 18.
    Reste à corriger par le responsable du dépôt.
  - ~~`README.md` est encore celui de create-next-app.~~
  - ~~`docker-compose.yml` monte le volume à l'emplacement que l'image 18 refuse.~~
    Volume neuf sur `/var/lib/postgresql` (README).

## Décisions (tranchées le 01/10/2026 — ADR 016)

Tout le périmètre est retenu. Les recommandations ci-dessous sont adoptées,
sauf D3 (second facteur écarté) et D4 (réglage par ressource). Paiement :
virement et prélèvement suivis à la main.

| # | Question | Conflit | Décision |
|---|---|---|---|
| D1 | La facturation entre-t-elle dans le périmètre ? | `CLAUDE.md` « hors scope V1 » contre le cahier des charges (lot 2, export cadré dès le lot 1) | Oui. Modèle de facture structuré conforme EN 16931 dès sa création, TVA, numérotation continue par centre, émission par une plateforme agréée à choisir maintenant (émission obligatoire au 01/09/2027). Mettre à jour la section Facturation de `CLAUDE.md`. |
| D2 | Planning : semaine toutes ressources et vue mois | ADR 011 écarte la semaine toutes ressources | Semaine multi-ressources **filtrée par type** : le filtre répond à l'objection de l'ADR 011 (50 colonnes). Vue mois en taux d'occupation par jour, pas en créneaux. |
| D3 | Second facteur pour le back-office | Neon Auth géré ne le propose pas (ADR 008) | **Écarté par le centre.** On reste sur Neon Auth géré ; R28 se limite à l'isolation des comptes clients. |
| D4 | Réservation par un client connecté : confirmation automatique ou accord préalable ? | ADR 005 ne tranche que pour le public anonyme | **Réglage par ressource** : confirmation immédiate ou accord de l'accueil. |
| D5 | Remises, engagement, prorata : paramètres en base ou conventions codées ? | ADR 006 et 009 (conventions) contre R10 | Paramètres par centre en base, cohérents avec le multi-centres. Jeu de cas tarifaires figé et validé par l'exploitation avant de coder. |
| D6 | Occupation par contrat (bureau, boîte aux lettres) | Échappe à la contrainte d'exclusion et aux calendriers | Matérialiser la période du contrat en réservation : la contrainte d'exclusion de la décision 3 la protège sans code supplémentaire. |
| D7 | Offres groupées et services | ADR 009 : la grille est liée à un type de ressource | Nouvel objet « catalogue de services » plutôt qu'une extension de la grille ; une offre = lignes (ressource, type ou service) avec prix ou remise. |
| D8 | Champs d'état des lieux par type ; photos | Non tranché (slide 5) | Modèles de champs en JSONB en base, versionnés. Compression à l'upload avec `sharp` (nouvelle dépendance, à justifier). |
| D9 | Durées de conservation par type de donnée | `CLAUDE.md` RGPD, ADR 015 | Tableau des durées plus registre des traitements dans `docs/`. |

## Phases

Une phase = des tranches livrables, de la base à l'écran, déployées.

### Phase 0 — Stabiliser (≈ 1 semaine)
B1 à B5 ; R22 (chiffrement des scans, purge) ; R29 (registre, durées — D9) ;
R30 (PITR, copie du bucket, sauvegarde de `SECRETS_ENCRYPTION_KEY`, restauration
testée et documentée) ; R33 (contrôle de la région UE au démarrage).

### Phase 1 — Terminer le lot 1 « socle d'exploitation »
- R01 : écran de modification d'une ressource.
- R03 : filtres par type et par client, semaine multi-ressources, vue mois (D2).
- R05 : colonne canal, `contract_id` ; R02 / R04 : occupation par contrat (D6).
- R07 : contacts CRM, historique des réservations sur la fiche client.
- R12 (première partie) : modification d'un brouillon, archivage, numérotation
  automatique.
- R27 : rôles exploitant et accueil ; R28 : second facteur (D3), isolation par
  client en RLS.
- R16 (cadrage) : format d'export comptable fixé par ADR, sans intégration.

### Phase 2 — Lot 2 « monétisation » (tranche 3 de `CLAUDE.md`)
Préalable : D1, D5, D7.
- R08 : unité semaine, dates de validité.
- R18 : catalogue de services et services souscrits.
- R11 : fonction de devis partagée par le portail et le back-office, montant figé
  sur la réservation.
- R10 : remises et engagement paramétrés, jeu de cas de test figé.
- R09 : offres groupées.
- R13 / R15 : factures et lignes, TVA, numérotation, génération périodique
  (planificateur sur le VPS).
- R14 : actes courrier valorisés, qui deviennent des lignes de facture.
- R12 (seconde partie) : contrat généré depuis une offre, PDF rendu depuis les
  données, avenants versionnés (amende l'ADR 006).
- R16 : export comptable, mode de paiement, raccordement à la plateforme agréée.
- R31 : taux d'occupation, puis revenu par ressource.

### Phase 3 — Lot 3 « autonomie client » (déjà engagé côté courrier)
- R26 : modèles de messages éditables, historique des envois, déclencheurs
  hors courrier (demande de réservation acceptée, échéance, facture).
- R21 : table des demandes (ouverture, scan, réexpédition, avec état et frais).
- R23 : réservation depuis le compte (D4), total affiché, « Mes réservations »,
  offre groupée.
- R17 / R24 : mes contrats, mes factures, historique des demandes.
- R25 : cibles de 44 px, vérification à 375 px.

### Phase 4 — États des lieux (tranche 6)
R06 (D8) et le reste de R33 (compression, purge des photos).

## Règles pour les sessions qui prennent une tranche

- Vérifier `git status`, `ls src/db/migrations docs/decisions` et `ListAgents`
  avant de générer une migration ou de numéroter un ADR. Prochain ADR libre :
  voir l'index `docs/decisions/README.md`.
- Chaque règle métier listée ici (devis, remises, engagement, prorata, purge,
  droits) arrive avec son test.
- Mettre à jour le statut de l'exigence dans le tableau de synthèse en fin de
  tranche.

## Annexe — catalogue des exigences

**A. Ressources et planning**
- R01 : types salle, bureau, casier, véhicule, boîte aux lettres ; attributs
  propres à chaque type ; capacité (slides 5, 18).
- R02 : disponibilité individuelle, visible en interne et côté client (slide 5).
- R03 : toutes les ressources sur une semaine ; création dans une case ; créneaux
  occupés visibles ; filtres par type et par client ; bascule jour / semaine /
  mois (slide 15).
- R04 : pas d'écrasement ; verrou au niveau de la ressource ; tests de charge
  (slides 19, 22).
- R05 : créneau, statut, canal (client ou accueil), liens vers ressource, client
  et contrat (slide 18).
- R06 : entrée et sortie, champs configurables par type en base, photos
  compressées, liens vers ressource et réservation (slides 5, 18, 19, 22).

**B. Commercial**
- R07 : fiche client (société, contacts, coordonnées, statut), historique des
  locations et des services souscrits (slides 6, 18).
- R08 : tarifs jour / semaine / mois modulables selon la ressource (slide 6).
- R09 : combos ressources et services (slides 6, 18).
- R10 : remises, engagement, prorata paramétrables ; jeu de cas de test
  (slides 6, 19, 22).
- R11 : le prix du portail vient du moteur, sans duplication (slides 14, 16).
- R12 : contrat généré depuis l'offre et les réservations ; PDF depuis un modèle,
  archivé ; avenants (slides 7, 10, 18, 19).

**C. Facturation**
- R13 : échéances et factures sans ressaisie (slide 7).
- R14 : actes (scan…) remontés sur la facture (slides 7, 17).
- R15 : une facture regroupe location, forfaits et actes (slides 10, 18).
- R16 : export comptable cadré dès le lot 1 ; paiement ; e-facturation
  (slides 7, 22).
- R17 : contrats et factures consultables par le client (slides 14, 19).
- R18 : forfaits (assistante, standard, campagnes) ; service souscrit = forfait
  ou acte, quantité, période (slides 8, 18).

**D. Courrier**
- R19 : lettres, recommandés, colis ; photo de l'enveloppe (slide 8).
- R20 : notification automatique à la réception (slide 8).
- R21 : photo visible, types distingués, ouverture / scan / réexpédition, suivi,
  historique (slide 17).
- R22 : chiffrement au repos, accès restreint et journalisé, conservation, purge
  (slides 8, 21, 22).

**E. Portail**
- R23 : filtres par type et date, tarif avant réservation, offre groupée,
  confirmation sans l'accueil, réservations en cours (slide 16).
- R24 : demandes et documents consultables (slide 9).
- R25 : web responsive d'abord (slide 20).

**F. Transverse**
- R26 : déclencheurs, modèles éditables, historique des envois (slides 14, 19).
- R27 : exploitant, accueil, client, socle de permissions commun (slide 19).
- R28 : comptes clients isolés, second facteur pour le back-office (slide 21).
- R29 : registre, base légale, durées de conservation (slide 21).
- R30 : sauvegardes testées, restauration documentée, plan de reprise
  (slide 21).
- R31 : occupation, revenu par ressource, rentabilité des services (slide 12).
- R32 : une API métier, deux interfaces (slide 14).
- R33 : stockage objet, compression, purge (slides 14, 22).
