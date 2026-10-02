# ADR 038 — Notifications : événements, modèles éditables, journal des envois et préférences

**Date** : 2026-10-02
**Statut** : accepté — étend l'ADR 015 (courriels du courrier) à tous les
événements du cahier des charges ; manques de schéma tranchés par l'ADR 041 ;
les choix marqués « à valider » attendent le centre

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

## Mise en œuvre (dernière vague) — moteur, écrans, déclencheurs

Ajoutée le 2026-10-02, sans changer la décision ni le schéma : elle dit
comment le code l'applique, et les choix par défaut qu'il a dû faire.

### Un seul point d'envoi : `notify()` (`notifications/moteur.ts`)

Pour un événement et ses valeurs, le moteur :

1. lit, dans une transaction courte sous `withTenant()`, le centre (nom,
   adresse), son modèle pour l'événement et les destinataires ;
2. rend l'objet et le corps — le modèle du centre, ou le texte par défaut ;
3. écarte les personnes qui ont renoncé à la catégorie ;
4. envoie par `sendMessage()`, **hors de toute transaction** : un serveur
   SMTP lent ne retient pas de connexion à la base ;
5. inscrit l'issue au journal, dans sa propre transaction.

Il **ne lève jamais** : une panne du transport vaut `failed` (journalisé),
une panne de la base rend `failed` non journalisé et laisse une trace dans
les journaux du serveur. Il rend l'issue — statut, objet, corps rendu,
adresses servies et refusées — à l'appelant, qui n'en a besoin que pour la
relance (ci-dessous). Les appelants le lancent après la réponse (`after()`).

`sendMessage()` (`lib/courriel.ts`) rend désormais cette issue au lieu de
rien : `sent`, `failed` (adresses refusées, cause bornée à 500 caractères,
jamais le texte du message), `not_configured`, `no_recipient`. Il ne lève
toujours pas.

| Issue au journal | Quand |
|---|---|
| `sent` | parti vers chaque adresse |
| `failed` | au moins une adresse refusée ; `failed_recipients` dit lesquelles |
| `not_configured` | SMTP absent : les adresses qui auraient été servies sont gardées |
| `skipped` | modèle désactivé ; aucune adresse (accès, centre sans adresse) ; toutes les personnes ont renoncé. `recipients` est vide : rien n'est parti ; `error` dit pourquoi |

**Destinataires.** Un message au centre part à `tenants.email` (sans adresse :
`skipped`, « renseignez-la dans la configuration »). Un message au client part
aux accès de l'entreprise — ni retirés, ni anonymisés, fiche non archivée —,
ou à ceux que l'appelant désigne (`memberIds`, restreints à l'entreprise), ou
à des adresses données telles quelles (`addresses`). Les préférences ne
s'appliquent qu'aux accès : une adresse sans accès (contact « factures »)
est toujours servie, et une adresse servie si l'une au moins de ses entrées
n'a pas renoncé.

### Modèles et variables (`catalogue.ts`, `rendu.ts`)

- Le **catalogue** donne, pour chaque événement, son nom, sa description, ses
  variables (nom, sens, exemple fictif, facultative ou non) et son texte par
  défaut. Les textes du courrier et de l'invitation reprennent ceux de
  l'ADR 015. Un test vérifie que chaque texte par défaut passe la
  vérification de son propre événement.
- **Rendu** en une seule passe : une valeur qui contient `{{…}}` n'est
  jamais réinterprétée. Les messages sont en texte brut, sans HTML à
  échapper ; les caractères de contrôle sont retirés, et l'objet tient sur une
  ligne (sauts et retours remplacés par une espace : pas d'injection
  d'en-tête). **Une ligne du corps qui cite une variable manquante** (nulle,
  vide, ou lien sans `APP_URL`) **n'est pas envoyée** ; les lignes vides
  qui se suivent alors sont réduites à une. Dans l'objet, une variable
  manquante est remplacée par rien ; un objet vide prend le nom de
  l'événement. L'objet est borné à 200 caractères.
- **Vérification à l'enregistrement** : objet non vide, une ligne, 200
  caractères ; corps non vide, 10 000 ; accolades bien formées ; variables
  connues de l'événement, avec la liste des variables possibles dans le
  message d'erreur.
- `centre` est fourni par le moteur à tous les événements (signature).
- Un pli enregistré **déjà ouvert** part comme `mail_scanned` (« Votre
  courrier a été numérisé ») : il est lisible dès l'arrivée. L'objet
  « Nouveau courrier numérisé pour … » de l'ADR 015 disparaît.
- `invoice_reminder` : la lettre de relance reste celle de la facturation
  (`reminderMessage`, mentions légales comprises) ; le modèle l'entoure par
  `{{objet}}` et `{{lettre}}` (texte par défaut : rien d'autre), il ne la
  réécrit pas.

### Déclencheurs (`notifications/declencheurs-*.ts`)

Chacun relit l'état en base et ne prévient que si l'événement a bien eu
lieu : un double clic, une action rejouée ou un état changé entre-temps ne
font pas partir un message faux. Ils rendent `null` quand il n'y a rien à
dire, et ne lèvent jamais.

| Événement | Posé où | Destinataires |
|---|---|---|
| `mail_received`, `mail_scanned` | enregistrement et ouverture d'un pli (`courrier/actions.ts`, inchangé : `courrier/notifications.ts` délègue au moteur) | accès de l'entreprise |
| `mail_request_submitted` | demande d'ouverture de l'espace (`notifyOpeningRequested`, inchangé) ; `notifyMailRequestSubmitted(id)` prêt pour la numérisation et la réexpédition | centre ; rien pour une demande consignée par l'accueil |
| `mail_request_done`, `mail_request_refused` | **prêts** (`notifyMailRequestDone`, `notifyMailRequestRefused`), à brancher par la tranche courrier | accès de l'entreprise ; une demande d'ouverture faite ne donne pas de second message (l'ouverture envoie `mail_scanned`) |
| `booking_request_submitted` | page publique (`requestBookingAction`) ; prêt pour l'espace client en mode « accord de l'accueil » | centre |
| `booking_request_accepted`, `booking_request_refused` | `/demandes` (validation, refus) | la personne qui a réservé depuis son espace ; sinon le demandeur (avec les préférences de son accès s'il en a un) ; sinon les accès |
| `booking_confirmed` | réservation de l'équipe pour une entreprise (`createBookingAction`) ; prêt pour l'espace client en mode « confirmation immédiate » | idem |
| `booking_cancelled` | annulation par l'équipe d'une réservation d'entreprise encore active | idem |
| `invoice_issued` | émission d'une facture, d'un lot de brouillons, d'un avoir total | accès de l'entreprise ; lien vers `/compte/factures`, **jamais de pièce jointe** |
| `invoice_reminder` | relance par courriel (`sendRemindersAction`) | contacts « factures », sinon l'adresse de la fiche |
| `contract_activated` | activation d'un contrat | accès de l'entreprise |
| `inspection_to_sign`, `inspection_signed` | **prêts** (`notifyInspectionToSign`, `notifyInspectionSigned`), à brancher par la tranche des états des lieux | accès de l'entreprise ; centre. Ni document, ni photo, ni texte des remarques |
| `member_invited` | ajout d'un accès sur la fiche client (`sendInvitation`, inchangé) | la personne inscrite seulement |
| `offer_requested` | **prêt** (`notifyOfferRequested`), à brancher par la tranche portail | centre, si l'offre est montrée aux clients |

Les messages ne portent jamais l'expéditeur ni la note d'un pli, l'adresse
ou la consigne d'une demande de courrier, les remarques d'un état des lieux.

**Une demande anonyme de la page publique ne prévient pas son demandeur** :
le journal exige l'entreprise d'un message au client
(`notification_deliveries_client_audience`), et l'équipe répond elle-même
au demandeur (ADR 005). Rattachée à une entreprise, elle le prévient.

**Relances (amende la mise en œuvre de l'ADR 034).** La relance part par le
moteur, puis s'inscrit au journal des relances **telle qu'elle est partie**
(objet et texte rendus) **et à qui l'a reçue**. Elle n'y figure pas si
personne ne l'a reçue (refus SMTP, modèle désactivé) : la liste des envois
de l'action le dit, facture par facture.

### Écrans

- **`/notifications`** — « Messages » dans la navigation, `notifications.consulter`
  (accueil et exploitant) : journal filtrable par message, issue, période
  (jours du centre, convertis en UTC, décision 4) et partie d'adresse
  (`ILIKE`, `%` et `_` saisis restent des caractères) ; 50 lignes par page ;
  liens vers la réservation, la facture, le contrat, le pli, l'offre ou la
  fiche client quand le rôle peut les ouvrir. Il rappelle la durée de
  conservation et dit quand le SMTP n'est pas configuré.
- **`/notifications/modeles`** et **`/notifications/modeles/[evenement]`** —
  `notifications.gerer` (exploitant) : liste par destinataire (clients,
  centre) avec la catégorie qui permet de refuser, « Personnalisé » ou
  « Texte par défaut », « Actif » ou « Désactivé » en toutes lettres ;
  éditeur avec objet, texte, activation, variables (insérables au curseur
  du dernier champ utilisé) et **aperçu rendu à la saisie** avec les données
  d'exemple, par le même rendu que l'envoi. « Revenir au texte par défaut »
  réécrit la ligne avec le texte du code (confirmation par dialogue),
  l'activation restant celle choisie. Un modèle est « personnalisé » quand
  son texte diffère de celui du code.
- **`/compte/preferences`** — « Préférences » dans l'espace client : une
  case par catégorie, pour chaque entreprise de la personne (une légende par
  entreprise quand elle en a plusieurs). Toutes les catégories sont écrites
  à chaque enregistrement (`on conflict … do update`). L'accès réglé est
  pris parmi ceux du compte, jamais dans le formulaire ; l'écriture se fait
  sous portée client, et la clé étrangère composite refuse un accès d'une
  autre entreprise. Mobile d'abord : lignes et bouton de 44 px. La page dit
  que l'ouverture d'un accès part toujours, et que les relances vont aux
  contacts de facturation quels que soient ces choix.

### Purge

`/api/maintenance/conservation` appelle `purge_expired_notification_deliveries()`
dans sa propre transaction, avant la purge du courrier : une panne du
stockage ne la retient pas. Le nombre de lignes purgées est rendu
(`notificationDeliveries`).

### Tests

`rendu.test.ts` et `catalogue.test.ts` (variables, valeurs manquantes,
réinterprétation, objet sur une ligne, vérification, textes par défaut
valides), `journal-filtres.test.ts`, `courriel.test.ts` (issue sans SMTP),
`moteur.db.test.ts` (texte par défaut et modèle du centre, modèle désactivé,
préférences, accès retirés et fiche archivée, message au centre, échec SMTP
journalisé avec ses adresses, SMTP non configuré journalisé, transport qui
lève, base injoignable, **aucune donnée du corps dans aucune colonne du
journal**), `declencheurs.db.test.ts` (chaque déclencheur, l'état attendu, les
destinataires, l'absence d'expéditeur, d'adresse, de consigne et de
remarques), `queries.db.test.ts` (modèles, filtres et pagination du journal,
préférences sous portée client), et la route de conservation.

### À valider par le centre

- Une facture émise prévient les **accès** de l'espace client, pas les
  contacts « factures » sans accès : le message mène à l'espace.
- Une réservation saisie par l'équipe pour une entreprise la prévient
  (`booking_confirmed`) ; les réservations posées en masse et les séries ne
  préviennent pas.
- Un message non envoyé (`skipped`) ne garde pas les adresses qu'il aurait
  servies.
- La durée du journal reste celle du centre (`notification_log_retention_months`) ;
  son réglage à l'écran relève de la configuration des durées.

### Intégration de la vague (02/10/2026)

Les déclencheurs marqués **prêts** ci-dessus sont branchés ; plus aucun
envoi ne contourne `notify()` (`sendMessage()` n'est appelé que par le
moteur) :

| Événement | Branché dans |
|---|---|
| `mail_request_submitted` (numérisation, réexpédition) | `courrier/demandes-compte-actions.ts`, par `courrier/notifications.ts` |
| `mail_request_done` (numérisation, réexpédition), `mail_request_refused` | `courrier/demandes-actions.ts`, par `courrier/notifications.ts` |
| `booking_request_submitted` (espace client, « accord de l'accueil ») | `reservations/portail-actions.ts` |
| `booking_confirmed` (espace client, « confirmation immédiate ») | `reservations/portail-actions.ts` |
| `offer_requested` | `facturation/offres-portail.ts` (`requestOffer`), qui échoue si le journal n'est pas écrit : il est la trace de la demande |
| `inspection_to_sign` | clôture d'un état des lieux (`etats-des-lieux/actions.ts`) |
| `inspection_signed` | validation par le client (`etats-des-lieux/compte-actions.ts`) |

Les chemins parallèles des autres tranches sont retirés
(`notifications/message-centre.ts`, `reservations/portail-notifications.ts`,
`courrier/notifications-demandes.ts`). Le refus d'une demande de courrier
porte son motif et la réexpédition faite son numéro de suivi, comme les
textes par défaut ci-dessus : la tranche courrier les laissait hors du
message (ADR 037), le choix est **à valider par le centre**, qui peut
retirer ces lignes de ses modèles.

La tâche de nuit appelle, chacune dans sa transaction : demandes publiques,
anonymisation des entreprises puis des personnes retirées (ADR 040), journal
des messages, courrier, journal des consultations des photos puis photos
d'états des lieux (ADR 039).
