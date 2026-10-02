# Décisions d'architecture (ADR)

Un ADR par décision structurante (`CLAUDE.md`). Il dit ce qui a été décidé,
pourquoi, et ce qui a été écarté. Un ADR accepté ne se réécrit pas : une
décision qui change fait l'objet d'un nouvel ADR, et l'ancien indique dans son
statut par quoi il est remplacé.

**Les numéros ne sont jamais réattribués**, y compris quand deux ADR partagent
le même. Le code, les migrations, les commits et les autres ADR les citent :
renuméroter casserait ces renvois sans rien gagner.

## Index

| N° | Décision | Date | Statut |
|---|---|---|---|
| 001 | [Choix de la stack](001-stack.md) | 2026-09-18 | accepté ; hébergement remplacé par l'ADR 013 (VPS), PostgreSQL 17 remplacé par 18 (ADR 003) |
| 002 | [Schéma des ressources et des réservations](002-schema-ressources-reservations.md) | 2026-09-18 | accepté |
| 003 | [Plateforme Neon et rôle applicatif sans BYPASSRLS](003-neon-et-role-applicatif.md) | 2026-09-18 | accepté |
| 004 | [Socle d'interface](004-socle-ui.md) | 2026-09-18 | accepté |
| 005 | [Demandes de réservation publiques](005-demandes-de-reservation-publiques.md) | 2026-09-18 | accepté |
| 006 | [Clients, grilles tarifaires et contrats](006-clients-tarifs-contrats.md) | 2026-09-18 | accepté ; prorata et unité entamée paramétrés par l'ADR 023, échéancier versionné par l'ADR 025 |
| 007 | *absent* : numéro jamais attribué | — | — |
| 008 | [Authentification et accès au back-office](008-authentification-et-acces-au-back-office.md) | 2026-09-18 | accepté |
| 009 | [Catalogue réel du centre et unité « demi-journée »](009-catalogue-reel-et-demi-journee.md) | 2026-09-18 | accepté ; durée de la demi-journée paramétrée par l'ADR 023 |
| 010 | [Calendrier de sélection d'un créneau](010-calendrier-de-selection.md) | 2026-09-18 | accepté — **numéro en double** |
| 010 | [Horaires d'ouverture et disponibilités](010-horaires-et-disponibilites.md) | 2026-09-18 | accepté — **numéro en double** |
| 011 | [Annonces publiques et vue semaine](011-annonces-et-vue-semaine.md) | 2026-09-18 | accepté ; vue semaine amendée par l'ADR 017 |
| 012 | [Les horaires sont portés par la ressource](012-horaires-portes-par-la-ressource.md) | 2026-09-18 | accepté |
| 013 | [Hébergement sur le VPS de production, déployé depuis GitHub](013-hebergement-vps-de-production.md) | 2026-09-30 | accepté — **numéro en double** |
| 013 | [Séries et délais de réservation](013-series-et-delais-de-reservation.md) | 2026-09-21 | accepté — **numéro en double** |
| 014 | [Un agenda Google par ressource](014-agendas-google-par-ressource.md) | 2026-09-30 | **proposé** : le compromis RGPD est à valider |
| 015 | [Espace client, courrier et réservations des entreprises clientes](015-compte-client-et-courrier.md) | 2026-09-30 | accepté |
| 016 | [Tout le cahier des charges DOMOTOP entre dans le périmètre](016-perimetre-du-cahier-des-charges.md) | 2026-10-01 | accepté |
| 017 | [Planning : semaine toutes ressources, vue mois et filtres](017-planning-toutes-ressources-et-vue-mois.md) | 2026-10-01 | accepté ; amende l'ADR 011 |
| 018 | [Occupation des ressources sous contrat, canal et contrat des réservations](018-occupation-sous-contrat-et-canal.md) | 2026-10-01 | accepté ; occupation par segments et changement de ressource par avenant : ADR 025 |
| 019 | [Rôles de l'équipe et isolation des clients entre eux](019-roles-et-isolation-des-clients.md) | 2026-10-01 | accepté |
| 020 | [Chiffrement et conservation des documents](020-chiffrement-et-conservation-des-documents.md) | 2026-10-01 | accepté ; mise en œuvre du chiffrement, du contrôle de région et de la purge ajoutée |
| 021 | [Numérotation des documents](021-numerotation-des-documents.md) | 2026-10-01 | accepté |
| 022 | [Sauvegardes et plan de reprise](022-sauvegardes-et-plan-de-reprise.md) | 2026-10-01 | accepté |
| 023 | [Tarification paramétrable, remises, engagement et devis figé](023-tarification-parametrable-et-devis.md) | 2026-10-01 | accepté ; amende les ADR 006 et 009 ; mise en œuvre du devis, de l'échéancier et de la configuration ajoutée ; reconduction tacite mise en œuvre par l'ADR 033 |
| 024 | [Catalogue de services, services souscrits et offres groupées](024-services-et-offres-groupees.md) | 2026-10-01 | accepté ; mise en œuvre des écrans, du prix des offres et des souscriptions ajoutée |
| 025 | [Contrats versionnés : lignes, avenants, segments d'occupation, documents](025-contrats-versionnes-et-documents.md) | 2026-10-01 | accepté ; amende les ADR 006 et 018 ; mis en œuvre par l'ADR 028 |
| 026 | [Factures structurées : modèle EN 16931, émission, avoirs, double facturation](026-factures-structurees.md) | 2026-10-01 | accepté ; précisé par les ADR 029 et 032 |
| 027 | [Paiements, mandats SEPA chiffrés et export comptable](027-paiements-et-export-comptable.md) | 2026-10-01 | accepté ; précisé par l'ADR 030 |
| 028 | [Contrats tirés d'une offre, avenants à l'écran, échéancier versionné et documents archivés](028-contrats-depuis-offre-avenants-documents.md) | 2026-10-01 | accepté ; choix à valider par le centre ; quantités d'offre alignées sur l'ADR 024 à l'intégration ; reconduction tacite mise en œuvre par l'ADR 033 |
| 029 | [Lot de facturation périodique et écrans de facturation](029-lot-de-facturation-et-ecrans.md) | 2026-10-01 | accepté ; précise l'ADR 026 ; deux conséquences corrigées par l'ADR 032 ; lancement planifié ajouté par l'ADR 033 |
| 030 | [Règlements : pointage, relances, remises de prélèvement, export FEC, représentation EN 16931](030-reglements-prelevements-export-et-en16931.md) | 2026-10-01 | accepté ; précise l'ADR 027 ; contrôle BR-CO-17 d'un avoir précisé par l'ADR 032 |
| 031 | [Indicateurs : définitions de l'occupation et du chiffre d'affaires](031-indicateurs-occupation-et-chiffre-d-affaires.md) | 2026-10-01 | accepté ; définitions à valider par le centre |
| 032 | [Correctifs de la facturation : avenants déjà facturés, avoirs au centime, forfaits sans prorata, motif d'exonération](032-correctifs-de-la-facturation.md) | 2026-10-02 | accepté ; corrige l'ADR 029, précise les ADR 026 et 030 ; choix à valider par l'expert-comptable |
| 033 | [Tâches planifiées de la facturation : lot mensuel et reconduction tacite](033-taches-planifiees-de-la-facturation.md) | 2026-10-02 | accepté ; met en œuvre la reconduction de l'ADR 023 et le lancement planifié de R13 ; choix à valider par le centre |

## Numéros en double et numéro manquant

Deux sessions de travail ont numéroté en parallèle. Le constat est consigné
ici, sans renuméroter (bloquant B5 de [`docs/roadmap.md`](../roadmap.md)) :

- **010, deux fois.** Ailleurs dans le dépôt, « ADR 010 » désigne en pratique
  les horaires (`010-horaires-et-disponibilites.md`) : ADR 011 et 012, code
  des horaires et des annonces.
- **013, deux fois.** « ADR 013 » désigne en pratique l'hébergement
  (`013-hebergement-vps-de-production.md`) : `CLAUDE.md`, `Dockerfile`, CI,
  `infra/serveur/`.
- **007 n'existe pas.** Le numéro a été sauté ; il reste libre et n'est pas
  réutilisé, pour qu'un renvoi ancien ne pointe jamais vers une décision
  qu'il ne visait pas.

Pour citer sans ambiguïté l'un des ADR en double, donner son sujet ou le nom
de son fichier : « ADR 010 (calendrier de sélection) », « ADR 013 (séries) ».

**Vague 2 : pas de doublon.** Trois tranches parallèles avaient chacune pris
le 028 dans leur copie de travail. Aucune n'était encore intégrée : à
l'intégration du 01/10/2026, les contrats gardent le 028, le lot de
facturation devient le 029 et les règlements le 030, renvois du code compris.
Aucun numéro déjà publié n'a été réattribué.

## Écarts connus avec `CLAUDE.md`

- ~~`CLAUDE.md` mentionne PostgreSQL 17~~ : corrigé (commit `1d55ec2`), aligné
  sur l'ADR 003.
- La section Facturation de `CLAUDE.md` dit encore « hors scope de la V1 » :
  l'ADR 016 l'a fait entrer dans le périmètre, et la vague 2 (ADR 023 à 030)
  l'a construite. La correction de `CLAUDE.md` revient au responsable du
  dépôt.

## Écrire un nouvel ADR

1. **Choisir le numéro.** Vérifier qu'aucune autre session n'est en train d'en
   écrire un : `ls docs/decisions`, `git log --all -- docs/decisions` et
   `ListAgents`. Le prochain numéro libre est **034**.
2. **Nommer le fichier** `NNN-sujet-en-minuscules.md`.
3. **En-tête** : titre `# ADR NNN — …`, `**Date**`, `**Statut**` (proposé,
   accepté, remplacé par l'ADR …).
4. **Sections** : Contexte, Décision, Justification, Alternatives écartées,
   Conséquences.
5. **Mettre à jour l'index** ci-dessus dans le même commit.
