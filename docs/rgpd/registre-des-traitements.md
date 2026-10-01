# Registre des traitements

Registre au sens de l'article 30 du RGPD, pour les traitements que réalise
l'application de gestion du centre d'affaires (R29, D9). Il se déduit du code
et des ADR à la date indiquée, et s'intègre au registre général de
l'entreprise.

- **Dernière mise à jour** : 01/10/2026.
- **Durées de conservation** : [tableau détaillé](durees-de-conservation.md).
- Ce qui reste « à valider », « à vérifier » ou « à compléter » l'est par
  l'exploitant.

## Responsable du traitement

| | |
|---|---|
| Responsable | **SECUTOP**, personne morale qui exploite le centre d'affaires Handfield |
| Adresse | 6 rue de Copenhague, Pavillon jaune n° 7, 38070 Saint-Quentin-Fallavier |
| Téléphone | 04 28 35 09 31 |
| Représentant légal | *à compléter* |
| Point de contact RGPD (exercice des droits) | *à compléter* : une adresse électronique dédiée |
| Délégué à la protection des données | aucun désigné à ce jour ; désignation non obligatoire a priori (art. 37) |

## Sous-traitants et localisation

| Sous-traitant | Rôle | Données concernées | Localisation | Garanties | État |
|---|---|---|---|---|---|
| **Neon** (Neon, Inc., États-Unis) | Base PostgreSQL, authentification (Neon Auth), stockage objet (bucket `uploads`) | toutes | AWS `eu-central-1`, Francfort (ADR 003, 015) | Accord de traitement (DPA) de Neon. Accès possible du fournisseur depuis les États-Unis : garanties de transfert à vérifier dans le DPA. | DPA à accepter et à archiver ; garanties à vérifier |
| **Neon Auth**, par Neon | Courriels d'authentification (vérification d'adresse, mot de passe) envoyés depuis `auth@mail.myneon.app` tant qu'aucun SMTP propre n'est configuré (ADR 008) | adresse, nom | à vérifier | DPA de Neon | à vérifier |
| **OVHcloud** (OVH SAS, France) | VPS de production : application, Apache, journaux, fichiers en transit pendant la sauvegarde ; zone DNS | toutes, en transit ; journaux | centre de données du VPS : **à vérifier qu'il est en UE** | contrat OVHcloud, accord de traitement inclus | localisation à vérifier |
| **Destination des sauvegardes** (recommandée : OVHcloud Object Storage) | Conservation des sauvegardes, chiffrées avant envoi : le prestataire ne peut pas les lire (ADR 022) | toutes, chiffrées | UE, dans une autre région que le VPS | DPA du prestataire | à choisir |
| **Brevo** (Sendinblue SAS, France) | Envoi des courriels transactionnels par SMTP (ADR 015) | adresse du destinataire, objet, texte | Europe (ADR 015) | DPA à accepter dans le compte Brevo ; suivi des ouvertures et des clics désactivé | DPA à accepter et à archiver |
| **Google** (Google Agenda) | Agendas des salles reliées (ADR 014) | objet de la réservation, ressource, créneau, lien vers la fiche | aucune garantie de localisation pour un compte Gmail : **transfert hors UE possible** | conditions de Google ; transfert à encadrer | ADR 014 au statut « proposé » : compromis à valider |

GitHub (code source, intégration continue, registre d'images) ne traite
aucune donnée personnelle de ces traitements : l'image est construite sans
secret ni donnée. Il ne figure ici que pour mémoire.

## Mesures de sécurité communes (art. 32)

- **Localisation** : base et stockage en UE. Polices, logos et photos servis
  depuis le domaine du centre, jamais chez un tiers : aucun appel du
  navigateur ne transmet l'adresse IP d'un visiteur à un tiers (ADR 004).
- **Transport** : HTTPS (Let's Encrypt), HTTP redirigé, cookies `Secure`.
  Courriels toujours chiffrés (STARTTLS exigé).
- **Authentification et droits** :
  - Neon Auth gère les comptes ;
  - un compte ne donne aucun droit : l'accès est accordé par une liste
    (`staff_members`, `client_members`), sur une adresse vérifiée (ADR 008,
    015) ;
  - le contrôle a lieu dans chaque action serveur, pas seulement à l'entrée
    des pages.
- **Isolation en base (RLS)** :
  - par centre, fermée par défaut ;
  - par entreprise cliente, sous la portée client (ADR 019) ;
  - l'application se connecte avec un rôle sans `BYPASSRLS` ni droit de
    modifier le schéma ;
  - le propriétaire de la base n'est pas sur le serveur (ADR 003, 013).
- **Rôles** : exploitant et accueil (ADR 019).
- **Traçabilité** : journal des consultations de numérisations, que
  l'application ne peut ni modifier ni effacer (ADR 015). Les plis, les
  numérisations et les ouvertures portent leur auteur.
- **Chiffrement** :
  - secrets confiés par un tiers (jeton Google) en AES-256-GCM, clé propre à
    chaque environnement ;
  - numérisations chiffrées au repos : modèle posé, mise en œuvre en cours
    (ADR 020, R22) ;
  - sauvegardes chiffrées avant de quitter le serveur, pour des clés privées
    gardées hors du serveur (ADR 022).
- **Pas de données réelles en développement** : la branche de base `dev` sert
  au travail quotidien. Aucune branche ne doit être créée depuis
  `production` tant que les numérisations ne sont pas toutes chiffrées (B3,
  ADR 020).
- **Secrets du serveur** : hors du dépôt, dans un `.env` en `chmod 600`. Clé
  de déploiement réservée à la CI.
- **Continuité** : sauvegarde nocturne testée, procédure de restauration,
  plan de reprise (ADR 022).
- **Durées de conservation** appliquées par des purges planifiées (voir le
  tableau).

## Traitements

### T1. Accès de l'équipe au back-office

| Rubrique | Contenu |
|---|---|
| Finalité | Authentifier les membres de l'équipe, leur ouvrir le back-office selon leur rôle (exploitant, accueil), et tracer qui enregistre, numérise et consulte. |
| Base légale | Intérêt légitime (art. 6-1-f) : sécuriser l'outil et ses données. |
| Personnes | Membres de l'équipe du centre. |
| Données | Adresse électronique, nom, rôle, identifiant de compte. Mot de passe haché et sessions (adresse IP, navigateur, dates), chez Neon Auth. Auteur des plis, des numérisations et des consultations. |
| Destinataires | Exploitant. |
| Sous-traitants | Neon (base, Neon Auth), OVHcloud (serveur). |
| Transferts hors UE | Aucun prévu ; garanties de Neon à vérifier. |
| Conservation | Tant que la personne est dans l'équipe. Le retrait est logique : la ligne reste, car elle signe les actions passées. Durée de cette trace et des comptes Neon Auth : **à fixer**. |
| Code | `src/db/staff.ts`, `src/lib/auth/`, ADR 008, 019 |

### T2. Clients, prospects et contrats

| Rubrique | Contenu |
|---|---|
| Finalité | Gérer la relation avec les entreprises locataires et domiciliées : fiche, interlocuteurs, contrats, et facturation à partir de la vague 2. |
| Base légale | Clients : exécution du contrat (art. 6-1-b). Prospects : mesures précontractuelles (art. 6-1-b). Interlocuteurs des entreprises : intérêt légitime (art. 6-1-f), pour joindre la bonne personne. Les justificatifs que la domiciliation impose au centre relèvent d'une obligation légale (art. R.123-168 du Code de commerce ; art. L.561-2 du Code monétaire et financier) ; l'application ne les stocke pas aujourd'hui. *À confirmer par le conseil du centre.* |
| Personnes | Dirigeants et interlocuteurs des entreprises clientes et prospects. Entrepreneurs individuels, pour qui la fiche de l'entreprise est une donnée personnelle. |
| Données | Fiche : raison sociale, forme, SIRET, n° de TVA, adresse, courriel, téléphone, statut, notes. Contacts : nom, fonction, courriel, téléphone, rôles (principal, facturation), notes. Contrats : référence, type, ressource, dates, montant, résiliation, notes. |
| Destinataires | Équipe du centre. Plateforme agréée de facturation électronique à partir de la vague 2 (à choisir, ADR 016). |
| Sous-traitants | Neon, OVHcloud. |
| Transferts hors UE | Aucun prévu. |
| Conservation | Prospects : 3 ans après le dernier contact. Clients : durée de la relation, puis 5 ans. Contrats : durée, puis 5 ans. Factures : 10 ans. **À valider** sauf les factures, imposées par la loi. Mécanisme d'anonymisation à construire. |
| Code | `src/modules/clients/`, `src/modules/contrats/`, ADR 006, 021 |

### T3. Accès des clients à leur espace

| Rubrique | Contenu |
|---|---|
| Finalité | Permettre aux personnes que désigne une entreprise cliente de consulter son courrier et ses réservations, et d'y déposer des demandes. |
| Base légale | Intérêt légitime (art. 6-1-f) : ouvrir à l'entreprise cliente, partie au contrat, l'accès par les personnes qu'elle désigne. |
| Personnes | Personnes inscrites sur la fiche d'une entreprise cliente. |
| Données | Adresse électronique, nom, identifiant de compte, entreprise(s) rattachée(s). Mot de passe haché et sessions, chez Neon Auth. Demandes d'ouverture déposées. |
| Destinataires | Équipe du centre. Les autres personnes inscrites sur la même fiche voient le même courrier. |
| Sous-traitants | Neon, OVHcloud, Brevo (courriel d'invitation). |
| Transferts hors UE | Aucun prévu. |
| Conservation | Tant que l'accès est ouvert. Le retrait est logique : la ligne reste, car elle signe les demandes d'ouverture. Durée de cette trace : **à fixer**. |
| Mesures propres | Isolation entre entreprises par la RLS, sous portée client (ADR 019). Rattachement du compte sur une adresse vérifiée. |
| Code | `src/modules/clients/schema.ts` (`client_members`), `comptes.ts`, ADR 015, 019 |

### T4. Réservations et demandes de réservation

| Rubrique | Contenu |
|---|---|
| Finalité | Planifier l'occupation des salles, bureaux et boîtes aux lettres. Traiter les demandes de la page publique et de l'espace client. Matérialiser l'occupation des contrats. |
| Base légale | Demandes : mesures précontractuelles prises à la demande de la personne (art. 6-1-b). Réservations des clients : exécution du contrat (art. 6-1-b). |
| Personnes | Demandeurs (prospects, particuliers, représentants d'entreprises), clients, équipe. |
| Données | Nom, adresse électronique et téléphone du demandeur. Objet et notes saisis librement. Créneau, ressource, statut, canal, client, contrat. Dates de création et d'annulation, motif. |
| Destinataires | Équipe du centre. Le client voit ses propres réservations. Le public ne voit que des créneaux occupés, sans identité. |
| Sous-traitants | Neon, OVHcloud. Google, pour l'objet et le créneau des réservations confirmées des salles reliées (T8). |
| Transferts hors UE | Voir T8. |
| Conservation | Coordonnées du demandeur : 12 mois après la fin du créneau ou l'annulation, puis anonymisation par la tâche nocturne (ADR 020). Durée **à valider**. Le créneau est conservé (historique, statistiques). |
| Mesures propres | Au plus 5 demandes par adresse sur 24 heures. Préavis, horizon et durée maximale contrôlés côté serveur. Aucune identité exposée au public. |
| Code | `src/modules/reservations/`, ADR 005, 013 (séries), 018, 020 |

### T5. Courrier des entreprises domiciliées

| Rubrique | Contenu |
|---|---|
| Finalité | Enregistrer le courrier reçu pour chaque entreprise domiciliée et l'en prévenir. Numériser l'enveloppe et, sur demande, le contenu. Le mettre à disposition dans l'espace client. Relever les ouvertures à facturer. |
| Base légale | Exécution du contrat de domiciliation (art. 6-1-b). Pour les tiers (expéditeurs, personnes citées dans les courriers) : intérêt légitime (art. 6-1-f), nécessaire à l'exécution de ce contrat. |
| Personnes | Entreprises domiciliées et leurs représentants. Expéditeurs. Toute personne citée dans un courrier numérisé. |
| Données | Expéditeur, type de pli, dates de réception, de demande et d'ouverture, note du centre, auteurs des actions. Images de l'enveloppe et du contenu (PDF, JPEG, PNG). |
| Données sensibles | Un courrier numérisé peut contenir des données de toute nature, y compris des catégories particulières (art. 9) ou un numéro de sécurité sociale. Le centre ne les exploite pas : il les transmet à leur destinataire, sur sa demande. **Analyse d'impact (AIPD) à évaluer.** |
| Destinataires | Équipe du centre ; personnes inscrites sur la fiche de l'entreprise destinataire. |
| Sous-traitants | Neon (base et stockage objet, Francfort), OVHcloud (transit), Brevo (notification, sans document ni expéditeur). |
| Transferts hors UE | Aucun. Les numérisations ne sont jamais envoyées par courriel. |
| Conservation | Numérisations : 12 mois, puis effacement du fichier (validé le 30/09/2026). Plis : **à valider**. |
| Mesures propres | Jamais d'URL directe ni signée : chaque lecture passe par l'application, qui vérifie le droit et journalise (T6). Type de fichier lu dans le contenu. Chiffrement au repos en cours (ADR 020). Isolation par entreprise (ADR 019). |
| Code | `src/modules/courrier/`, ADR 015, 019, 020 |

### T6. Journal des consultations de numérisations

| Rubrique | Contenu |
|---|---|
| Finalité | Tracer chaque consultation d'une numérisation, par l'équipe comme par le client, pour détecter un accès anormal et en apporter la preuve. |
| Base légale | Intérêt légitime (art. 6-1-f) et obligation de sécurité (art. 32). |
| Personnes | Membres de l'équipe, personnes de l'espace client. |
| Données | Numérisation consultée, date et heure, type de lecteur, membre ou accès client, identifiant de compte. |
| Destinataires | Exploitant. |
| Sous-traitants | Neon. |
| Transferts hors UE | Aucun. |
| Conservation | 12 mois (validé le 30/09/2026), puis effacement par la seule fonction de purge. |
| Mesures propres | L'application ne peut qu'ajouter des lignes : ni modification, ni effacement. L'inscription précède l'envoi du fichier ; si elle échoue, rien n'est envoyé. |
| Code | `src/modules/courrier/schema.ts` (`mail_scan_views`), migration 0024 |

### T7. Courriels transactionnels

| Rubrique | Contenu |
|---|---|
| Finalité | Prévenir sans transporter : arrivée et numérisation d'un courrier, invitation à l'espace client, et, vers le centre, demande d'ouverture. |
| Base légale | Exécution du contrat (art. 6-1-b) ; intérêt légitime pour l'invitation (art. 6-1-f). |
| Personnes | Personnes de l'espace client, équipe du centre. |
| Données | Adresse du destinataire. Objet, qui contient le nom de l'entreprise. Texte, sans document ni expéditeur. Chaque destinataire reçoit un message séparé. |
| Destinataires | Le destinataire du message. |
| Sous-traitants | Brevo, par SMTP. Neon pour les courriels d'authentification (T1, T3). |
| Transferts hors UE | Aucun prévu. |
| Conservation | L'application ne garde pas d'historique des envois. Journaux d'envoi chez Brevo : durée **à vérifier**. |
| Code | `src/lib/courriel.ts`, `src/modules/courrier/notifications.ts`, `src/modules/clients/invitation.ts` |

### T8. Agendas Google des salles

| Rubrique | Contenu |
|---|---|
| Finalité | Montrer l'occupation des salles reliées dans Google Agenda, où l'équipe la suit. |
| Base légale | Intérêt légitime (art. 6-1-f) : organisation interne. |
| Personnes | Toute personne nommée dans l'objet d'une réservation. Titulaire du compte Google du centre. |
| Données | Objet de la réservation, ressource, créneau, lien vers la fiche. **Ni nom, ni courriel, ni téléphone du demandeur, ni notes** : un test le vérifie. Adresse du compte Google connecté, jeton chiffré. |
| Destinataires | Personnes avec qui l'agenda est partagé dans Google. |
| Sous-traitants | Google. |
| Transferts hors UE | **Possibles** : Google ne garantit pas la localisation pour un compte Gmail. À encadrer, ou à éviter par un compte Google Workspace avec localisation des données. |
| Conservation | Tant que l'agenda existe dans le compte Google. Une annulation retire l'événement. Déconnexion : jeton révoqué et connexion supprimée. |
| Statut | ADR 014 « proposé » : le compromis sur l'objet est à valider. Consigne : ne pas écrire de nom de personne dans l'objet. |
| Code | `src/modules/reservations/agenda-google*.ts` |

### T9. Journaux techniques

| Rubrique | Contenu |
|---|---|
| Finalité | Sécurité du service et diagnostic des pannes. |
| Base légale | Intérêt légitime (art. 6-1-f) ; obligation de sécurité (art. 32). |
| Personnes | Visiteurs du site, utilisateurs. |
| Données | Apache : adresse IP, date, URL demandée, navigateur, page d'origine, code de réponse. Application : messages d'erreur, qui peuvent citer une adresse électronique en cas d'échec d'envoi. |
| Destinataires | Opérateur technique. |
| Sous-traitants | OVHcloud. |
| Transferts hors UE | Aucun, sous réserve de la localisation du VPS. |
| Conservation | Apache : 14 jours avec la rotation par défaut de Debian, **à vérifier puis à valider**. Application : jusqu'au déploiement suivant, 50 Mo au plus. |
| Code | `infra/serveur/apache-handfield.conf`, `infra/serveur/compose.yml` |

### T10. Sauvegardes

| Rubrique | Contenu |
|---|---|
| Finalité | Pouvoir rétablir les données et le service après un incident (art. 32-1-c). |
| Base légale | Obligation de sécurité (art. 32) ; intérêt légitime (art. 6-1-f). |
| Personnes | Toutes celles des traitements T1 à T7. |
| Données | Toute la base (comptes compris), le stockage objet (numérisations) et la configuration du serveur. |
| Destinataires | Opérateur technique, et seulement pour une restauration. |
| Sous-traitants | Hébergeur de la destination (à choisir). Il reçoit des fichiers chiffrés qu'il ne peut pas lire. |
| Transferts hors UE | Aucun : destination en UE. |
| Conservation | 7 lots quotidiens, 4 hebdomadaires, 12 mensuels. Une donnée effacée de la base y reste jusqu'à 12 mois de plus. Toute restauration relance la purge avant la réouverture. |
| Mesures propres | Chiffrement sur le serveur pour des clés publiques ; les clés privées sont détenues par deux personnes, hors du serveur. Rôle de base en lecture seule. Empreintes vérifiées après l'envoi. Exercice de restauration trimestriel. |
| Code | `infra/serveur/sauvegarde.sh`, ADR 022, `docs/exploitation/` |

## Reste à faire

1. **Compléter** le représentant légal et le point de contact RGPD.
2. **Accepter et archiver les DPA** :
   - Neon, en vérifiant ses garanties de transfert ;
   - Brevo ;
   - OVHcloud ;
   - le prestataire de la destination des sauvegardes.
3. **Vérifier** que le VPS est dans un centre de données en UE.
4. **Trancher l'ADR 014** (Google Agenda) : valider le compromis et encadrer
   le transfert, ou passer par un compte avec localisation en UE.
5. **Valider ou fixer** les durées marquées comme telles
   ([durées de conservation](durees-de-conservation.md)).
6. **Évaluer la nécessité d'une AIPD** pour le courrier numérisé (T5).
7. **Rédiger l'information des personnes** :
   - mentions du formulaire public ;
   - clauses du contrat de domiciliation (durées, numérisation, journal) ;
   - page de l'espace client.
8. **Organiser l'exercice des droits** : accès, rectification, effacement et
   opposition. L'effacement prend la forme d'une anonymisation (décision 6),
   sauf conservation imposée par la loi.
9. **Tenir le registre des violations de données** (art. 33-5). La procédure
   est dans le [plan de reprise](../exploitation/plan-de-reprise.md),
   étape 4.
