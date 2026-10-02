# Durées de conservation

Une durée par type de donnée, avec son point de départ, ce qui se passe au
terme, le mécanisme qui l'applique et l'endroit où elle se règle (R29, D9).
Le [registre des traitements](registre-des-traitements.md) renvoie ici.

État au 02/10/2026. Statuts :

- **validé** : durée décidée par le centre ou imposée par un texte ;
- **à valider** : durée proposée, en attente d'une décision du centre ;
- **à fixer** : rien n'est décidé ni appliqué.

Une durée validée doit figurer au contrat avec le client, au contrat de
domiciliation pour le courrier (ADR 015), et dans l'information donnée aux
personnes.

Règle commune : **pas de suppression physique** des entités métier
(décision 6). Au terme d'une durée, on efface le document ou on anonymise les
champs personnels. La ligne reste, pour l'historique et la facturation.

## Tableau

### Courrier (ADR 015, ADR 020)

| Donnée | Durée | Départ | Au terme | Mécanisme | Statut |
|---|---|---|---|---|---|
| Numérisations : enveloppe et contenu (stockage objet, `mail_scans`) | **12 mois** | dépôt de la numérisation | le fichier est effacé du stockage ; la ligne reste, marquée `deleted_at`, sans document | M1, réglage M3 (`mail_scan_retention_months`) | validé le 30/09/2026 |
| Journal des consultations (`mail_scan_views`) | **12 mois** | consultation | lignes effacées | M1, réglage M3 (`mail_access_log_retention_months`) | validé le 30/09/2026 |
| Plis (`mail_items` : expéditeur, type, dates, note, auteurs) | avec l'entreprise : **60 mois** après la fin de la relation (proposition) | dernière activité de l'entreprise, fin de la domiciliation comprise | expéditeur et note effacés, `sender_anonymized_at` posé ; le pli, ses dates et son ouverture restent au relevé | M7, réglage M3 (`client_retention_months`) | à valider ; pas de durée propre aux plis (ADR 040) |

### Réservations (ADR 005, ADR 014, ADR 020)

| Donnée | Durée | Départ | Au terme | Mécanisme | Statut |
|---|---|---|---|---|---|
| Coordonnées d'un demandeur (`bookings.requester_*`) | **12 mois** | fin du créneau, ou annulation si elle est antérieure | coordonnées effacées, `requester_anonymized_at` posé. Sans client rattaché, notes effacées et objet remplacé par « Demande publique anonymisée ». La réservation reste. | M2, réglage M3 (`public_request_retention_months`) | à valider (B4) |
| Réservations : créneau, ressource, statut, canal, client, contrat | historique conservé | — | — | aucun | à valider |
| Objet et notes d'une réservation, saisis librement | comme la réservation ; les notes et les coordonnées d'un demandeur partent avec l'entreprise cliente | dernière activité de l'entreprise | notes effacées ; l'objet reste | M7 pour les réservations d'un client ; aucun sinon | à valider ; consigne de saisie ci-dessous |
| Événements des agendas Google (objet, créneau, lien) | tant que l'agenda existe dans le compte Google du centre | écriture | une annulation retire l'événement ; les événements passés restent chez Google | aucun côté application | à valider avec l'ADR 014 |
| Connexion Google (adresse du compte, jeton chiffré) | jusqu'à la déconnexion | connexion | suppression, jeton révoqué (ADR 014) | action de l'administrateur | validé (ADR 014) |

**Consigne de saisie** : l'objet d'une réservation part dans Google Agenda
(ADR 014) et reste dans l'historique. On n'y écrit pas de nom de personne ni
de motif personnel ; on écrit « Réunion Alpha », pas « Entretien M. Dupont ».

### Clients et contrats (ADR 006, R07)

| Donnée | Durée | Départ | Au terme | Mécanisme | Statut |
|---|---|---|---|---|---|
| Fiche d'un prospect (`clients` en `prospect`) | **36 mois** (proposition) | dernière activité (`client_last_activity_on`) : création de la fiche, dernier contact noté par l'équipe, réservation, pli, demande de courrier, facture, paiement, état des lieux | fiche anonymisée (raison sociale « Client anonymisé … », coordonnées, SIRET, notes effacés), archivée ; jamais sous exclusion (M7) | M7, réglage M3 (`prospect_retention_months`) | à valider |
| Fiche d'un client (`clients`) | **60 mois** après la fin de la relation (proposition ; prescription, art. L.110-4 du Code de commerce) | dernière activité : fin du dernier contrat, dernière réservation, dernier pli, dernière facture ou dernier paiement, dernier contact noté | idem ; le compte auxiliaire reste (exports comptables passés) | M7, réglage M3 (`client_retention_months`) | à valider |
| Contacts (`client_contacts`) | suivent la fiche de l'entreprise (ADR 020) | idem | « Contact anonymisé », coordonnées et notes effacées, archivés | M7 | à valider |
| Contrats (`contracts`) | la ligne reste (décision 6) | dernière activité de l'entreprise | notes et motif de résiliation effacés avec l'entreprise ; le reste demeure, documents de contrat compris | M7 | à valider |
| Factures, avoirs, lignes, instantanés de l'acheteur | **10 ans** (art. L.123-22 du Code de commerce) | clôture de l'exercice | archivage ; **jamais anonymisés** : l'identité de l'acheteur est figée à l'émission | aucun effacement ; M7 ne les touche pas (testé) | imposé par la loi |
| Accès à l'espace client (`client_members`) | tant que l'accès est ouvert ; la ligne retirée reste, car elle signe des demandes, des ouvertures et des consultations. Puis **12 mois** (proposition) | retrait de l'accès | nom et adresse anonymisés (« Personne anonymisée », adresse en `.invalid`), compte détaché ; tout de suite si l'entreprise est anonymisée | M7, réglage M3 (`removed_member_retention_months`) ; à la demande sur la fiche client | à valider |

### Règlements (ADR 027, ADR 030)

| Donnée | Durée | Départ | Au terme | Mécanisme | Statut |
|---|---|---|---|---|---|
| Paiements pointés (`payments`) | **10 ans**, comme les pièces comptables (art. L.123-22 du Code de commerce) | clôture de l'exercice | archivage ; la ligne reste (décision 6) | aucun : à construire | imposé par la loi |
| Mandats SEPA (`sepa_mandates` : titulaire, IBAN chiffré, BIC, RUM) | proposition : validité du mandat, puis 14 mois après le dernier prélèvement (un débiteur conteste un prélèvement non autorisé pendant 13 mois) | révocation, caducité ou dernier prélèvement | effacer l'IBAN chiffré et le titulaire ; la RUM reste, elle n'est jamais réattribuée | titulaire d'un mandat non actif : effacé avec l'entreprise (M7). IBAN chiffré : à construire. Un mandat actif empêche l'anonymisation | à valider |
| Fichier de remise de prélèvements (IBAN en clair) | jamais stocké : reconstruit à chaque téléchargement | — | — | ADR 030 | fixé |
| Journal des relances (`invoice_reminders` : palier, canal, adresses des destinataires, texte de la lettre, auteur) | proposition : **10 ans**, comme la facture relancée, dont il prouve le recouvrement | clôture de l'exercice de la facture | archivage ; la ligne reste (décision 6) | aucun : à construire | à valider (ADR 034) |

### Équipe et comptes (ADR 008, ADR 015)

| Donnée | Durée | Départ | Au terme | Mécanisme | Statut |
|---|---|---|---|---|---|
| Membres de l'équipe (`staff_members`) | tant que la personne est dans l'équipe ; la ligne retirée reste, car elle signe des plis, des numérisations, des factures, des consultations. Puis **12 mois** (proposition) | retrait | nom et adresse anonymisés (« Membre anonymisé »), compte détaché | M7, réglage M3 (`removed_member_retention_months`) ; à la demande sur l'écran Équipe | à valider |
| Comptes d'authentification (`neon_auth` : adresse, nom, mot de passe haché) | tant que le compte existe | création | proposition : supprimer un compte jamais rattaché ou sans connexion depuis 12 mois. L'inscription est ouverte, des comptes inutiles s'accumulent (ADR 008). | aucun : à construire | à fixer (B4) |
| Sessions (`neon_auth` : adresse IP, navigateur) | jusqu'à expiration de la session | connexion | réglage de Neon Auth | Neon Auth | à vérifier |

### Technique (ADR 013, ADR 022)

| Donnée | Durée | Départ | Au terme | Mécanisme | Statut |
|---|---|---|---|---|---|
| Journaux Apache (adresse IP, URL, navigateur) | 14 jours avec la rotation par défaut de Debian | écriture | fichier effacé | M6 | à vérifier sur le serveur, puis à valider. La CNIL recommande 6 mois à 1 an pour les journaux de sécurité. |
| Journaux de l'application (erreurs ; une adresse électronique peut y figurer) | jusqu'au déploiement suivant, 50 Mo au plus | écriture | effacés | M5 | fixé par l'ADR 022 |
| Journaux d'envoi de Brevo (destinataire, objet, statut) | durée fixée par Brevo | envoi | — | Brevo | à vérifier dans le compte Brevo |
| Sauvegardes (tout ce qui précède) | 7 lots quotidiens, 4 hebdomadaires, 12 mensuels | lot | lot effacé de la destination | M4 | fixé par l'ADR 022, à valider |
| Journal des sauvegardes (`sauvegardes.log`) | sans limite | — | — | — | sans donnée personnelle |

**Sauvegardes et durées.** Une donnée effacée ou anonymisée en base reste dans
les sauvegardes jusqu'à 12 mois de plus. Sa durée effective est donc sa durée
en base, plus 12 mois au plus. Par exemple, une numérisation peut survivre
jusqu'à 24 mois dans le plus ancien lot mensuel. Deux règles en découlent :

- la sauvegarde tourne **après** la purge nocturne ;
- toute restauration relance la purge avant de rouvrir l'application
  ([restauration](../exploitation/restauration.md), étape 3).

Si le centre veut raccourcir cette survie, il réduit
`SAUVEGARDE_GARDER_MENSUELLES` : à 3, une donnée survit au plus 3 mois.

## Mécanismes

**M1. Purge nocturne du courrier.**

- Ce qu'elle fait : la route `POST /api/maintenance/conservation`, protégée
  par `MAINTENANCE_TOKEN`, appelle `purgeExpiredMail`
  (`src/modules/courrier/conservation.ts`). Celle-ci efface les fichiers
  échus, par lots de 200 par passage, puis purge le journal par
  `purge_expired_mail_scan_views()` (migration 0024). Le rôle applicatif ne
  peut rien effacer d'autre dans le journal.
- Quand : chaque nuit à 3 h 15, par la crontab du compte `deploy`
  (`infra/serveur/README.md`, « Conservation du courrier »).
- Preuve : testée par `src/modules/courrier/courrier.db.test.ts`.

**M2. Anonymisation des demandes de réservation.**

- Ce qu'elle fait : `anonymize_expired_public_requests()` (migration 0026,
  `SECURITY DEFINER`) traite le centre courant et rend le nombre de demandes
  anonymisées.
- Quand : chaque nuit, par la route de M1, qui l'appelle avant la purge du
  courrier et dans sa propre transaction (`src/modules/reservations/conservation.ts`).
  La réponse de la route en donne le nombre (`publicRequests`).
- Preuve : testée par
  `src/modules/reservations/conservation-demandes.db.test.ts`, et par la route
  elle-même dans `src/app/api/maintenance/conservation/conservation.db.test.ts`.

**M3. Durées par centre.**

- Où : colonnes de `tenants`, en mois, de 1 à 120 (contraintes
  `tenants_*_retention_valid`) :
  - `mail_scan_retention_months`, `mail_access_log_retention_months` ;
  - `public_request_retention_months` ;
  - `prospect_retention_months`, `client_retention_months`,
    `removed_member_retention_months` (ADR 040) ;
  - `notification_log_retention_months` (ADR 038) ;
  - `inspection_photo_retention_months`,
    `inspection_access_log_retention_months` (ADR 039).
- Valeurs du centre : réglées à l'écran **Configuration du centre**,
  section « Durées de conservation » (exploitant, droit `centre.configurer`,
  `src/modules/rgpd/durees.ts`). Chaque durée y rappelle son départ, son
  effet au terme, son défaut et son statut. `infra/configurer-centre.mjs` ne
  les pose plus : le rejouer ne défait pas le choix du centre.
- Pour changer une durée : la régler à l'écran, puis reporter la nouvelle
  durée au contrat. La purge suivante applique la nouvelle durée, y compris
  aux données déjà présentes : une durée raccourcie se confirme avant
  l'enregistrement. L'écran annonce ce que la prochaine nuit anonymisera.
- Preuve : les bornes de l'écran et de la base sont éprouvées ensemble
  (`src/modules/rgpd/anonymisation.db.test.ts`).

**M4. Rétention des sauvegardes.** `SAUVEGARDE_GARDER_QUOTIDIENNES`,
`_HEBDOMADAIRES` et `_MENSUELLES`, dans `sauvegarde.env` sur le serveur
(ADR 022). La règle est testée par `infra/serveur/sauvegarde.test.sh`.

**M5. Journaux de l'application.** Section `logging` de
`infra/serveur/compose.yml` : cinq fichiers de 10 Mo, effacés aussi quand un
déploiement recrée le conteneur.

**M6. Journaux Apache.** `/etc/logrotate.d/apache2` sur le serveur
(`rotate` × période).

**M7. Anonymisation RGPD (ADR 040).**

- Ce qu'elle fait : les fonctions `SECURITY DEFINER` de la migration 0043.
  `anonymize_expired_clients()` anonymise les prospects et les clients au
  terme de leur durée, comptée depuis leur dernière activité ;
  `anonymize_removed_members()` les accès à l'espace client et les membres
  de l'équipe retirés depuis plus que la leur. La ligne reste, les champs
  personnels partent : fiche, contacts, accès, expéditeur et note des plis,
  consignes et adresses des demandes de courrier, coordonnées et notes des
  réservations, notes des contrats, titulaire des mandats non actifs,
  destinataires et objet des messages journalisés.
- Exclusions (`client_anonymization_blockers()`) : une entreprise n'est
  jamais anonymisée tant qu'elle a une facture non soldée ou un brouillon de
  facture ou d'avoir, un contrat vivant, une réservation à venir ou en
  cours, un service souscrit en cours, un mandat de prélèvement actif, une
  demande de courrier en cours ou un état des lieux en saisie.
- Jamais touchés : factures, avoirs, lignes, paiements, instantanés de
  l'acheteur, relances, documents de contrat, états des lieux.
- Quand : chaque nuit, par la route de M1, chacune dans sa transaction,
  avant la purge du stockage. La réponse et le journal de l'application
  n'en donnent que des nombres (`anonymizedClients`, `anonymizedMembers`).
- À la demande (droit à l'effacement) : sur la fiche client pour une
  entreprise ou un accès retiré, sur l'écran Équipe pour un membre retiré
  (droit `rgpd.anonymiser`, exploitant). Mêmes exclusions : un refus les
  énumère.
- Le dernier contact se note sur la fiche client : un prospect qu'on
  rappelle ne s'anonymise pas.
- Preuve : `src/modules/clients/anonymisation.db.test.ts` (règles en base),
  `src/modules/rgpd/anonymisation.db.test.ts` (exclusions, idempotence,
  factures intactes, refus motivé) et la route dans
  `src/app/api/maintenance/conservation/conservation.db.test.ts`.

## Reste à faire

1. **Faire valider** par le centre les durées « à valider », à l'écran
   Configuration du centre. Les reporter ensuite au contrat et dans
   l'information des personnes.
2. **Fixer** la durée des comptes `neon_auth` (B4) : les accès et les
   membres retirés ont la leur (M7), pas les comptes d'authentification.
3. ~~Construire l'anonymisation des fiches clients, contacts, contrats et
   plis~~ : fait (M7, ADR 040). Reste l'IBAN chiffré des mandats révoqués
   (durée propre, ADR 034).
4. **Vérifier** sur le serveur la rotation Apache et, chez Brevo, la durée
   des journaux d'envoi.
