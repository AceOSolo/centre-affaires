# ADR 059 — Cloche de l'équipe, courriels Brevo et comptes créés par l'accueil

**Date** : 2026-11-04
**Statut** : accepté — complète l'ADR 038 (moteur de notifications), l'ADR 015
(accès à l'espace client) et l'ADR 045 (comptes du site) ; recette du
04/11/2026, lot 3 ; une migration de structure (tables `staff_notifications`
et `staff_notification_reads`) ; § 1 (la cloche) amendé par l'ADR 070 : elle
montre les demandes à traiter, lues dans les files de « Demandes », et ces
tables sont en sommeil

## Contexte

Recette du 04/11/2026 (`docs/recette/2026-11-04.md`, lot 3) :

- « Notification lorsqu'une demande est effectuée ». Décision du responsable :
  **une cloche dans le back-office et un e-mail au centre**. Jusqu'ici, l'équipe
  n'avait que le courriel à l'adresse du centre (`notify()`, ADR 038), les
  compteurs du menu et « Aujourd'hui » ; `/notifications` n'est que le journal
  des envois.
- « Création des comptes et connexion SMTP / envoi des e-mails ». Décisions :
  **Brevo**, déjà prévu (`src/lib/courriel.ts`, `infra/serveur/README.md` § 8),
  et **l'accueil crée le compte depuis la fiche client** ; le client reçoit un
  e-mail pour choisir son mot de passe.

Constats sur le flux d'invitation existant (ADR 015), vérifié de bout en bout
contre Better Auth et une base de test :

1. le courriel `member_invited` disait « créez votre accès depuis la page de
   connexion, puis confirmez-la » : la personne devait s'inscrire elle-même
   (formulaire, case anti-robot), puis ouvrir un second courriel de
   confirmation, valable une heure ;
2. aucun lien propre à l'invitation, donc aucune durée de validité à
   annoncer ;
3. rien pour renvoyer une invitation ;
4. l'état « Compte activé / En attente de connexion » était déjà sur la fiche,
   sans dire si l'invitation était partie ni quand.

## Décision

### 1. La cloche

**Une ligne par événement, lue membre par membre.**

- `staff_notifications` (`notifications/schema-equipe.ts`) : nature, entreprise
  (`client_id`, nulle pour un visiteur de la page publique), entité concernée
  (`related_id`), résumé, date. Une seule ligne par événement (index unique
  `tenant_id, kind, related_id`) : un déclencheur rejoué ne sonne pas deux fois.
- `staff_notification_reads` : une ligne par notification lue et par membre.
  Lu ou non lu n'engage que le membre ; « Tout marquer comme lu » écrit ses
  lignes à lui.
- Natures : demande de réservation (espace client, ADR 036), **demande de
  devis** (demande par produit de la page publique — salle, bureau, camion —,
  réservation et devis nés ensemble, ADR 043), demande de domiciliation, offre
  demandée, demande de courrier (ouverture, numérisation, réexpédition), état
  des lieux signé par le client.

**Posée aux mêmes endroits que le courriel.** Chaque déclencheur
(`declencheurs-*.ts`) appelle `signalStaff()` juste avant `notify()`, après les
mêmes vérifications : une demande consignée par l'accueil lui-même ne sonne
pas, un devis déjà traité non plus. La cloche ne dépend pas du courriel : elle
sonne même si le modèle du message est désactivé ou si l'envoi n'est pas
configuré. Comme le courriel, elle ne lève jamais.

**Aucune donnée personnelle recopiée.** Le résumé ne cite que la ressource et
le créneau, le numéro du devis, l'offre, la nature et la date du pli, la
nature de l'état des lieux et la ressource. « Qui » se lit à la source au
moment de l'affichage : la fiche du client, sinon le demandeur sur sa
réservation ou son devis. Une anonymisation (ADR 020, ADR 040) vaut donc pour
la cloche sans rien de plus ; un visiteur anonymisé devient « Visiteur du
site ». Ni l'expéditeur d'un pli, ni la consigne d'un client n'y entrent
(ADR 015).

**Droits.** Chaque nature a le droit de l'écran où elle se traite
(`staffNotificationPermissions`, `cloche.ts`) : `demandes.traiter` pour les
demandes de réservation, de devis, de domiciliation et d'offre,
`courrier.gerer` pour le courrier, `etats-des-lieux.gerer` pour les états des
lieux. Les trois rôles les ont aujourd'hui tous ; la règle tient le jour où un
rôle en perdrait un. Un membre ne peut marquer lue qu'une notification qu'il
voit. La cloche elle-même, sa route et ses actions sont gardées par
`notifications.consulter`, que les trois rôles ont déjà : toute action serveur
porte un droit (ADR 019, `gardes.test.ts`), et c'est celui de « consulter les
notifications » ; son libellé le dit désormais.

**Où mène chaque ligne.** À la demande dans « Demandes » (ADR 048), par une
ancre : `#demande-<réservation>`, `#devis-<devis>`, `#offre-<demande d'offre>`,
`#courrier-<demande de courrier>` ; l'élément ciblé est cerclé
(`target:`). L'état des lieux signé mène à sa fiche : ce n'est pas une demande.
L'ancre `courrier-` suppose que le lot 1 (demandes de courrier dans
« Demandes », ADR 057) la pose sur ses lignes ; sans elle, le lien ouvre
« Demandes » en haut de page.

**À l'écran.** Une cloche (icône Lucide « bell ») en haut de la barre latérale,
à côté du logo, et dans le bandeau du haut sur écran étroit, à côté de
« Menu » : visible sans ouvrir le menu. Pastille du nombre de non lues
(« 99+ » au-delà), juste dès le rendu serveur, sans saut de mise en page. Le
panneau liste les vingt dernières notifications des trente derniers jours :
quoi, qui, résumé, quand (« il y a 12 min », « hier à 17:02 », à l'heure du
centre). Une non lue porte le texte « Non lue » en plus de son fond : jamais la
couleur seule. Clavier : le bouton porte `aria-expanded` et `aria-controls`,
Échap referme et rend le focus, un clic dehors referme, focus visible partout.
Le compteur est annoncé poliment (`aria-live`). État vide : ce qui s'affichera,
et le lien vers « Demandes ».

**Rafraîchissement.** Interrogation de `GET /api/equipe/notifications` toutes
les minutes quand l'onglet est visible, à chaque navigation et à l'ouverture du
panneau ; les deux cloches de la coque partagent une seule interrogation.
Marquer lu passe par des actions serveur (protégées contre les requêtes d'un
autre site). Pas de websocket, pas de dépendance.

**Conservation.** La cloche ne montre que trente jours. Les lignes sont
purgées par la tâche de nuit au terme du journal des messages
(`tenants.notification_log_retention_months`, ADR 038), dont elles sont le
pendant pour l'équipe ; leurs « lu » partent avec elles (clé étrangère en
cascade). Nouvelle étape `staffNotifications` du bilan de
`/api/maintenance/conservation`.

### 2. Courriels : SMTP Brevo

- **Port 587 en STARTTLS**, déjà exigé (`requireTLS`). Délais bornés à 10 s
  pour la connexion : un serveur injoignable se dit en secondes.
- **Erreurs lisibles au journal** (`explainSmtpError`) : la cause en français
  — identifiant ou clé refusés (en rappelant que la clé SMTP n'est pas la clé
  d'API), expéditeur refusé (`MAIL_FROM` d'un domaine non authentifié),
  serveur introuvable ou injoignable, STARTTLS en échec —, suivie de la réponse
  du serveur, bornée. Jamais le message.
- **Encart « Courriels » dans Réglages**, pour qui configure le centre
  (`centre.configurer`) : configuré ou non (serveur, port, chiffrement,
  expéditeur ; ni l'identifiant ni la clé), variables manquantes nommées,
  bouton « Envoyer un e-mail d'essai » à l'adresse du membre connecté (jamais
  une adresse saisie : l'essai ne sert pas à écrire à n'importe qui), issue
  dite aussitôt, et les cinq derniers échecs du journal avec leur cause. L'essai
  n'est pas un message du centre : il n'entre pas au journal (il faudrait un
  événement de plus à l'énumération ; l'issue à l'écran suffit).
- **Capteur de développement : Mailpit**, profil `courriel` de
  `docker-compose.yml` (ports 1025 et 8025 sur la boucle locale). Il reçoit
  tout et ne remet rien : on voit les invitations et les liens sans écrire à
  personne, comme le veut `CLAUDE.md` (pas de donnée réelle en
  développement). Choisi parce qu'il tient en une image, sans configuration ni
  dépendance du projet, et qu'il ne sort jamais de la machine. Pour l'admettre,
  `smtpSettings` accepte le clair **vers la boucle locale seulement**
  (`localhost`, `127.x`, `::1`) ; partout ailleurs, STARTTLS reste exigé.
  Démarré seulement à la demande (`docker compose --profile courriel up -d
  mailpit`).

### 3. Comptes clients créés par l'accueil

- L'accueil donne l'accès depuis la fiche du client (« Accès à l'espace
  client »), comme avant. À l'envoi de l'invitation, le compte Better Auth est
  créé s'il n'existe pas (`lib/auth/invitation.ts`), **sans mot de passe** et
  adresse non confirmée : personne n'y entre sans le lien.
- Le courriel `member_invited` porte un **lien pour choisir son mot de passe**,
  celui du mot de passe oublié de Better Auth (`/api/auth/reset-password/…`),
  **valable une fois et sept jours** (`INVITATION_JOURS`) au lieu d'une heure,
  et en dit la fin de validité (variable `{{echeance}}`, à l'heure du centre).
  Il mène à `/auth/nouveau-mot-de-passe?invitation=1`, aux textes d'accueil.
- **Choisir son mot de passe confirme l'adresse** (`onPasswordReset`,
  `lib/auth/server.ts`) : le lien n'est parti qu'à elle. Plus de second
  courriel de confirmation. Vaut aussi pour « Mot de passe oublié », pour la
  même raison.
- **Première connexion** : adresse et mot de passe ; le rattachement à
  l'entreprise se fait à la connexion, sur l'adresse, comme avant
  (`resolveClientAccounts`). L'accès passe alors « Compte activé ».
- **Renvoi** : bouton « Renvoyer l'invitation » sur chaque accès qui ne s'est
  pas encore connecté : un nouveau lien, de nouveau sept jours, issue dite
  aussitôt. Un accès retiré entre-temps ne crée pas de compte.
- **État sur la fiche** : « Compte activé », « Invitée » (envoyée le …, lien
  valable jusqu'au …), « Invitation expirée », « Invitation non envoyée »
  (envoi non configuré), « Échec de l'invitation », ou « En attente de
  connexion » pour un accès sans invitation au journal. Lu au journal des
  messages (`member_invited`), sans nouvelle colonne.
- Une personne qui a déjà un compte (accès à une autre entreprise) le garde :
  le courriel lui dit de se connecter comme d'habitude ; le lien ne lui sert
  qu'à changer de mot de passe si elle le veut.

## Justification

- **Une ligne par événement, et non une par membre** : les droits se lisent à
  l'affichage, si bien qu'un rôle qui change voit aussitôt ce qui lui revient ;
  un membre arrivé après coup voit aussi les demandes du jour.
- **Le déclencheur, pas le moteur, pose la cloche** : le moteur ne sait pas
  distinguer une demande de réservation d'une demande de devis, et une cloche
  liée au courriel se tairait avec un modèle désactivé.
- **Le lien de Better Auth plutôt qu'un jeton maison** : vérification,
  expiration, usage unique et fermeture des sessions sont ceux, éprouvés, du
  mot de passe oublié (`mot-de-passe-oublie.db.test.ts`) ; seule la durée
  change.

## Alternatives écartées

- **Websocket ou Server-Sent Events** : la recette les exclut ; une minute
  suffit à une file que l'accueil traite dans l'heure.
- **Recopier le nom du demandeur dans la notification** : une copie de plus
  d'une donnée personnelle, que l'anonymisation aurait dû suivre.
- **Rattacher le compte à l'accès dès l'invitation** : l'état « actif »
  dirait alors « a reçu un courriel », pas « s'est connecté ».
- **Écrire la configuration SMTP en base, à l'écran** : la clé SMTP est un
  secret du serveur (`.env`), comme les autres ; l'encart constate, il ne
  modifie pas. Le lot 9 (connexion au CRM) pourra revoir la question pour le
  multi-centres.
- **Journaliser l'e-mail d'essai** : il faudrait un événement de plus, classé
  en base ; l'issue est dite à l'écran.

## Conséquences

- Migration de structure : deux tables (`staff_notifications`,
  `staff_notification_reads`), avec leurs gardes de centre générées par le
  migrateur. Aucune règle nouvelle dans `src/db/regles/`.
- Production : rien de nouveau dans le `.env` ; les variables Brevo
  (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM`) sont
  celles de `infra/serveur/README.md` § 8, mis à jour (vérification par
  l'encart « Courriels »).
- Un centre qui aurait réécrit le modèle `member_invited` garde son texte :
  `{{lien}}` y devient le lien du mot de passe. Les nouvelles variables
  `{{echeance}}` et `{{connexion}}` sont proposées par l'éditeur.
- Le lot 4 (message aux domiciliés) ajoute un événement au moteur ; il ne
  concerne que les clients et ne sonne pas dans la cloche.
- Le compte d'une personne invitée paraît dans « Comptes » (ADR 045) dès
  l'invitation, adresse non confirmée et sans entreprise : il s'y rattache seul
  à sa première connexion. Inutile de le rattacher à la main.
- Tests : `cloche.test.ts`, `cloche.db.test.ts` (chaque déclencheur, droits,
  lu par membre, trente jours, autre centre), `courriel.test.ts` (envoi réel
  vers un serveur SMTP de la boucle locale, refus d'authentification et
  d'expéditeur lisibles), `invitation-etat.test.ts`, `invitation.db.test.ts`
  (de l'invitation à la première connexion, lien expiré, renvoi, compte
  existant), `conservation.db.test.ts` (purge).
