# ADR 038 — Notifications : événements, modèles éditables, journal des envois et préférences

**Date** : 2026-10-02
**Statut** : accepté — étend l'ADR 015 (courriels du courrier) à tous les
événements du cahier des charges ; les choix marqués « à valider » attendent
le centre

## Contexte

R26 demande un moteur de notifications : des déclencheurs, des modèles de
messages éditables, un historique des envois. Aujourd'hui (ADR 015), les
courriels du courrier sont écrits en dur (`courrier/notifications.ts`),
envoyés par `sendMessage()` (`src/lib/courriel.ts`) qui ne lève jamais, et
leur issue ne laisse qu'une ligne dans les journaux du serveur. Aucun autre
événement ne prévient personne.

Un courriel prévient, il ne transporte jamais de document (ADR 015) : ni pièce
jointe, ni contenu de pli, ni expéditeur.

## Décision

### Les événements

`notification_event` : dix-sept événements, chacun avec un destinataire fixe
(`notification_audience` : `client`, les personnes de l'entreprise ;
`centre`, l'adresse du centre) et, pour ceux qu'un client peut refuser, une
catégorie (`notification_category`).

| Événement | Destinataire | Catégorie |
|---|---|---|
| `mail_received` — arrivée d'un pli | client | `mail` |
| `mail_scanned` — pli numérisé | client | `mail` |
| `mail_request_submitted` — demande de courrier déposée | centre | — |
| `mail_request_done` — demande de courrier traitée | client | `mail` |
| `mail_request_refused` — demande de courrier refusée | client | `mail` |
| `booking_request_submitted` — demande de réservation déposée | centre | — |
| `booking_request_accepted` — demande de réservation acceptée | client | `bookings` |
| `booking_request_refused` — demande de réservation refusée | client | `bookings` |
| `booking_confirmed` — réservation confirmée | client | `bookings` |
| `booking_cancelled` — réservation annulée | client | `bookings` |
| `invoice_issued` — facture émise | client | `invoices` |
| `invoice_reminder` — relance | client | `invoices` |
| `contract_activated` — contrat activé | client | `contracts` |
| `inspection_to_sign` — état des lieux à valider | client | `inspections` |
| `inspection_signed` — état des lieux validé par le client | centre | — |
| `member_invited` — accès à l'espace client ouvert | client | — |
| `offer_requested` — offre demandée depuis l'espace (ADR 036) | centre | — |

La table est en base (`notification_event_audience()`,
`notification_event_category()`, migration 0039) et recopiée dans le code
(`notificationEventAudience`, `notificationEventCategory`,
`src/modules/notifications/schema.ts`) ; un test vérifie qu'elles
concordent. Un événement ajouté à l'énumération sans être classé fait
échouer l'écriture au lieu de passer.

### Les modèles de messages, par centre et par événement

`notification_templates` : au plus un modèle par centre et par événement —
objet (200 caractères au plus), corps (10 000), `active`, auteur de la
dernière modification. **Sans ligne, le texte par défaut du code
s'applique** : un centre neuf prévient sans rien configurer. Le corps porte
des **variables nommées** entre doubles accolades (`{{client}}`, `{{lien}}`,
`{{date}}`) ; la liste des variables de chaque événement est dans le code,
qui la vérifie à l'enregistrement et les remplace à l'envoi. Un modèle
désactivé n'envoie plus rien.

Réglage du back-office : invisible et non modifiable sous portée client. Il
ne se supprime pas ; revenir au texte par défaut, c'est le réécrire.

### Le journal des envois, sans corps

`notification_deliveries` : un message par ligne — événement, destinataire,
entreprise concernée, adresses (`recipients`), adresses refusées par le
serveur SMTP (`failed_recipients`), **objet**, statut, cause, entité liée
(`related_type`, `related_id`), date (`sent_at`).

**Pas de corps** : il n'y a pas de colonne pour lui. L'objet dit ce qui est
parti ; le corps est recomposable depuis le modèle, et en garder une copie
serait une copie de plus des données du client.

| Statut (`notification_delivery_status`) | Quand |
|---|---|
| `sent` | parti vers chaque destinataire |
| `failed` | au moins un envoi refusé (`failed_recipients`, `error`) |
| `not_configured` | SMTP non configuré : rien n'est parti (développement) |
| `skipped` | rien à envoyer : modèle désactivé, aucun destinataire, toutes les personnes ont renoncé à la catégorie (`error` dit laquelle) |

La base vérifie la cohérence (`notification_deliveries_status_consistent`),
le destinataire fixé par l'événement (`notification_deliveries_audience_matches`)
et qu'un message à un client nomme le client.

Ajout seul : le rôle applicatif n'a ni `UPDATE` ni `DELETE`, les politiques ne
couvrent que la lecture et l'ajout (même double verrou que le journal
d'accès au courrier, migration 0020). Purge au terme de
`tenants.notification_log_retention_months` (12 mois par défaut, *à
valider*), par `purge_expired_notification_deliveries()`, SECURITY DEFINER,
sur le modèle de la migration 0024.

Sous portée client, une entreprise lit les messages **qui lui ont été
adressés** (`audience = 'client'`) ; ceux envoyés au centre à son sujet
restent au back-office. Le journal s'écrit sous `withTenant()`, après la
réponse (`after()`), comme l'envoi.

### Les préférences des personnes de l'espace client

`notification_preferences` : par accès (`client_member_id`, de
l'entreprise `client_id`) et par catégorie, `enabled`. Sans ligne, la
personne reçoit tout. Elle les règle depuis son espace, sous portée client
(`on conflict … do update`, jamais de suppression). Un renoncement ne vaut
que pour cet accès : la même personne peut garder les factures d'une société
et pas d'une autre.

Les événements sans catégorie partent toujours : ouverture d'un accès, et
messages au centre.

## Justification

**Pourquoi des textes par défaut dans le code.** Les messages actuels sont
justes et testés ; un centre ne doit pas avoir à tout réécrire pour être
prévenu. Le modèle en base est une surcharge.

**Pourquoi l'objet et pas le corps.** L'objet suffit à répondre « le client
a-t-il été prévenu, et de quoi ? ». Le corps, avec ses liens et ses noms,
ferait du journal un second registre de données personnelles, à conserver
et à purger.

**Pourquoi un message par ligne, tous ses destinataires ensemble.**
`sendMessage()` envoie un exemplaire par destinataire et agrège les échecs ;
une ligne par envoi garde ce grain, et `failed_recipients` dit qui n'a rien
reçu.

**Pourquoi des catégories et pas un réglage par événement.** Le cahier des
charges demande « au moins courrier, réservations, factures » ; cinq cases
se comprennent, dix-sept non.

## Alternatives écartées

**Un prestataire de notifications.** Une dépendance et un sous-traitant de
plus pour un volume de quelques dizaines de messages par jour.

**Journaliser dans les journaux du serveur seulement.** Ils tournent en
quelques jours et ne se consultent pas depuis l'écran.

**Des préférences par événement.** Possibles plus tard sans migration
destructrice (une catégorie de plus), si le centre le demande.

## Conséquences

- Le module `src/modules/notifications/` porte le schéma ; la tranche
  notifications y construit le catalogue des variables, le rendu, l'envoi
  journalisé, l'écran des modèles (`notifications.gerer`, exploitant), le
  journal (`notifications.consulter`, accueil et exploitant) et les
  préférences dans l'espace client.
- Les envois existants du courrier, des invitations et des relances passent
  par ce moteur ; les nouveaux déclencheurs sont posés par les tranches qui
  font l'événement.
- La purge du journal s'ajoute à la tâche nocturne
  `/api/maintenance/conservation`.
- *À valider par le centre* : la durée du journal (12 mois), la liste des
  événements qu'un client peut refuser, les textes par défaut.
