# Durées de conservation

Une durée par type de donnée, avec son point de départ, ce qui se passe au
terme, le mécanisme qui l'applique et l'endroit où elle se règle (R29, D9).
Le [registre des traitements](registre-des-traitements.md) renvoie ici.

État au 01/10/2026. Statuts :

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
| Plis (`mail_items` : expéditeur, type, dates, note, auteurs) | proposition : durée du contrat de domiciliation, puis 5 ans | fin du contrat | anonymiser l'expéditeur et la note | aucun : à construire | à valider |

### Réservations (ADR 005, ADR 014, ADR 020)

| Donnée | Durée | Départ | Au terme | Mécanisme | Statut |
|---|---|---|---|---|---|
| Coordonnées d'un demandeur (`bookings.requester_*`) | **12 mois** | fin du créneau, ou annulation si elle est antérieure | coordonnées effacées, `requester_anonymized_at` posé. Sans client rattaché, notes effacées et objet remplacé par « Demande publique anonymisée ». La réservation reste. | M2, réglage M3 (`public_request_retention_months`) | à valider (B4) |
| Réservations : créneau, ressource, statut, canal, client, contrat | historique conservé | — | — | aucun | à valider |
| Objet et notes d'une réservation, saisis librement | comme la réservation | — | — | aucun | à valider ; consigne de saisie ci-dessous |
| Événements des agendas Google (objet, créneau, lien) | tant que l'agenda existe dans le compte Google du centre | écriture | une annulation retire l'événement ; les événements passés restent chez Google | aucun côté application | à valider avec l'ADR 014 |
| Connexion Google (adresse du compte, jeton chiffré) | jusqu'à la déconnexion | connexion | suppression, jeton révoqué (ADR 014) | action de l'administrateur | validé (ADR 014) |

**Consigne de saisie** : l'objet d'une réservation part dans Google Agenda
(ADR 014) et reste dans l'historique. On n'y écrit pas de nom de personne ni
de motif personnel ; on écrit « Réunion Alpha », pas « Entretien M. Dupont ».

### Clients et contrats (ADR 006, R07)

| Donnée | Durée | Départ | Au terme | Mécanisme | Statut |
|---|---|---|---|---|---|
| Fiche d'un prospect (`clients` en `prospect`) | proposition : 3 ans | dernier contact | anonymiser coordonnées et notes | aucun : à construire | à valider |
| Fiche d'un client (`clients`) | proposition : durée de la relation, puis 5 ans (prescription, art. L.110-4 du Code de commerce) | fin du dernier contrat | anonymiser coordonnées et notes | aucun : à construire | à valider |
| Contacts (`client_contacts`) | suivent la fiche de l'entreprise (ADR 020) | idem | idem | aucun : à construire | à valider |
| Contrats (`contracts`) | proposition : durée du contrat, puis 5 ans | fin ou résiliation | la ligne reste (décision 6) ; anonymiser les notes | aucun : à construire | à valider |
| Factures (vague 2) | **10 ans** (art. L.123-22 du Code de commerce) | clôture de l'exercice | archivage | à construire avec la facturation | imposé par la loi |
| Accès à l'espace client (`client_members`) | tant que l'accès est ouvert ; la ligne retirée reste, car elle signe des demandes d'ouverture | retrait | à fixer : anonymiser nom et adresse après un délai | aucun : à construire | à fixer |

### Équipe et comptes (ADR 008, ADR 015)

| Donnée | Durée | Départ | Au terme | Mécanisme | Statut |
|---|---|---|---|---|---|
| Membres de l'équipe (`staff_members`) | tant que la personne est dans l'équipe ; la ligne retirée reste, car elle signe des plis, des numérisations, des consultations | retrait | à fixer : anonymiser nom et adresse après un délai | aucun : à construire | à fixer |
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
  `tenants_mail_retention_valid` et `tenants_public_request_retention_valid`) :
  - `mail_scan_retention_months` ;
  - `mail_access_log_retention_months` ;
  - `public_request_retention_months`.
- Valeurs du centre : posées par `infra/configurer-centre.mjs`, qui est
  idempotent.
- Pour changer une durée : modifier le script, le rejouer sur la production,
  puis reporter la nouvelle durée au contrat. La purge suivante applique la
  nouvelle durée, y compris aux données déjà présentes.

**M4. Rétention des sauvegardes.** `SAUVEGARDE_GARDER_QUOTIDIENNES`,
`_HEBDOMADAIRES` et `_MENSUELLES`, dans `sauvegarde.env` sur le serveur
(ADR 022). La règle est testée par `infra/serveur/sauvegarde.test.sh`.

**M5. Journaux de l'application.** Section `logging` de
`infra/serveur/compose.yml` : cinq fichiers de 10 Mo, effacés aussi quand un
déploiement recrée le conteneur.

**M6. Journaux Apache.** `/etc/logrotate.d/apache2` sur le serveur
(`rotate` × période).

## Reste à faire

1. **Faire valider** par le centre les durées « à valider ». Les reporter
   ensuite au contrat et dans l'information des personnes.
2. **Fixer** les durées des comptes `neon_auth`, des accès clients et des
   membres retirés (B4).
3. **Construire** les mécanismes d'anonymisation des fiches clients, contacts,
   contrats et plis, une fois les durées validées : une fonction
   `SECURITY DEFINER` par type, sur le modèle de M2, avec son test.
4. **Vérifier** sur le serveur la rotation Apache et, chez Brevo, la durée
   des journaux d'envoi.
