# ADR 060 — Message aux domiciliés, et catégories personnelles du courrier

**Date** : 2026-11-04
**Statut** : accepté — complète l'ADR 038 (moteur de notifications : un
événement, une catégorie de préférence, un type d'entité liée), l'ADR 044
(classement du courrier côté client) et l'ADR 054 (droit
`notifications.diffuser`) ; recette du 04/11/2026, lot 4 ; une migration de
structure (tables `client_broadcasts`, `client_broadcast_recipients`,
`mail_member_categories`, colonne `mail_item_member_states.custom_category_id`,
trois énumérations des notifications)

## Contexte

Recette du 04/11/2026 (`docs/recette/2026-11-04.md`, lot 4) :

- « Réponse en masse : une info envoyée aux domiciliés ». Décision du
  responsable : un **message libre envoyé à tous les domiciliés** — fermeture,
  travaux, nouveau service. Jusqu'ici, rien ne permettait d'écrire aux
  clients hors des messages automatiques du moteur (ADR 038).
- « Côté client : ajout de catégories de courrier ». Décision : le client
  **crée ses propres catégories**, en plus de la liste de départ
  (`courrier/categories.ts`, ADR 044), qui reste.

## Décision

### 1. Le message aux domiciliés

**Écran.** « Messages aux domiciliés » (`/messages`), dans le rayon
Domiciliation du menu (`menu.ts`) : l'historique, et « Nouveau message »
(`/messages/nouveau`). Chaque message a sa page (`/messages/{id}`) :
avancement, texte, issue entreprise par entreprise.

**Destinataires**, au choix :

| Choix | Entreprises visées |
|---|---|
| Tous les domiciliés (par défaut) | contrat de domiciliation `active`, en cours le jour du centre (début passé, sans fin ou fin à venir), fiche non archivée — la règle de « pas de courrier aujourd'hui » (ADR 044) |
| Tous les clients des bureaux | même règle, contrat de bureau ou de coworking |
| Une sélection | les fiches non archivées cochées une à une ; la liste montre les domiciliés d'abord, avec leur contrat en cours et le nombre de personnes de leur espace, et se filtre par le nom |

C'est le « selon ce qui est simple » de la recette : les produits à contrat
ont une clientèle « en cours ». Salles et camion se louent ponctuellement :
on atteint leurs clients par la sélection.

**Saisie.** Un objet (150 caractères) et un texte (5 000), en texte brut, sans
pièce jointe (ADR 015). Le modèle met « Bonjour, » avant et la signature du
centre après ; les doubles accolades sont refusées, le texte n'étant jamais
réinterprété.

**Aperçu, puis confirmation.** L'aperçu montre le message tel que la première
entreprise le recevra, et dit à combien d'entreprises et de personnes il
partira, combien ont décoché « Informations du centre », combien
d'entreprises n'ont personne pour le recevoir (aucun accès à l'espace client,
ou toutes ont décoché), et ce qui l'empêcherait de partir (modèle désactivé,
SMTP non configuré). Le bouton dit « Envoyer à 12 entreprises, 18
personnes ». L'aperçu porte une empreinte du message et des destinataires :
si l'un a changé entre l'aperçu et la confirmation — un texte retouché, un
contrat activé entre-temps —, la confirmation est refusée et un nouvel aperçu
s'affiche. On n'envoie que ce que l'on a relu.

**Envoi par le moteur.** Nouvel événement `client_broadcast` (« Message du
centre aux clients »), destinataire le client, catégorie de préférence
`centre_info`, entité liée `client_broadcast` (`70-notifications.sql`,
`notifications/schema.ts`). Chaque entreprise passe par `notify()` : son
envoi est inscrit au journal des messages, les préférences de ses personnes
s'appliquent, chacune reçoit son exemplaire sans voir les autres. Le modèle
est éditable comme les autres (`/notifications/modeles/client_broadcast`),
avec `{{objet}}`, `{{message}}`, `{{client}}`, `{{centre}}` et `{{lien}}`
(les préférences de l'espace client).

**Par paquets.** 25 entreprises par paquet, deux secondes de pause entre deux
paquets (`diffusion-regles.ts`) : Brevo limite le débit et, selon le
forfait, le nombre de courriels par jour (300 sur le forfait gratuit à la
date de cet ADR — à vérifier sur le forfait du centre avant un premier envoi
à tous). L'envoi est lancé après la réponse (`after()`), comme les autres
messages ; la page du message suit son avancement et se relit d'elle-même.
Un paquet prend ses entreprises (`claim_token`, `claimed_at`) avant de les
servir : si le serveur redémarre en plein envoi, « Reprendre l'envoi »
apparaît dix minutes plus tard, et reprend les seules entreprises encore en
attente. Une entreprise servie ne l'est jamais deux fois.

**Historique.** `client_broadcasts` garde l'objet, le texte, le choix des
destinataires, l'auteur et les dates ; `client_broadcast_recipients`, une
ligne par entreprise visée, figée à la confirmation : son issue (envoyé,
échec, non envoyé, SMTP non configuré), les adresses servies et refusées, la
raison, l'heure. L'historique dit donc date, auteur, nombre de destinataires
et échecs, et le dit encore après la purge du journal (12 mois). Aucune
adresse n'y est recopiée : elles sont au journal, et partent avec sa purge.

La base tient l'historique : aucune écriture sous portée client, un message
envoyé ne se réécrit pas (`CA017`), une entreprise servie ne repasse pas en
attente, rien ne se supprime (décision 6).

**Le texte se garde**, à la différence du corps des messages du journal
(ADR 038) : c'est le texte du centre, le même pour tous, qui ne recopie la
donnée d'aucun client — et l'historique « ce qui a été dit » le demande.

**Préférence « Informations du centre »** (`centre_info`). Active par défaut
— sans ligne, la personne reçoit —, elle se décoche dans « Préférences des
messages » de l'espace client, entreprise par entreprise, comme les autres
catégories. Le message rappelle comment la couper, avec le lien.

**Droit d'envoi** : nouveau droit `notifications.diffuser`, donné à
l'**exploitant et à la direction**, pas à l'accueil. Un message à tous les
domiciliés engage le centre auprès de tous ses clients, comme les modèles de
messages (`notifications.gerer`, même répartition). L'ouvrir à l'accueil est
une ligne de `permissions.ts`, et son test.

La cloche de l'équipe (ADR 059) ne sonne pas : le message va aux clients.

### 2. Les catégories personnelles du courrier

**Ce qu'elles sont.** Une personne de l'espace client crée, renomme et
supprime ses catégories (`/compte/courrier/categories`, « Gérer mes
catégories » depuis les rubriques de la boîte aux lettres et la fiche d'un
pli). Elles se mêlent aux catégories proposées : dans les rubriques (après
elles, toujours montrées, même vides), dans le filtre
(`?categorie=<identifiant>`), dans la barre de sélection et dans « Mon
classement » (groupe « Mes catégories »).

**Portée : celle du classement** (ADR 044), l'accès d'une personne à une
entreprise. Deux associés n'ont pas le même suivi : c'était la raison du
classement par personne, elle vaut pour les catégories qui le servent. Une
portée par entreprise ferait apparaître chez l'un les dossiers de l'autre, et
n'est pas nettement meilleure. Une personne de deux sociétés a deux listes :
la création demande alors l'entreprise, et une catégorie ne range que le
courrier de la sienne.

**En base.** `mail_member_categories` (`tenant_id`, entreprise, personne,
nom) ; le classement la vise par `mail_item_member_states.custom_category_id`,
à la place d'une catégorie proposée — l'une ou l'autre, jamais les deux
(contrainte `mail_item_member_states_one_category`). La clé étrangère porte
la personne et l'entreprise : un classement ne peut viser que la catégorie de
sa personne. Portée client tenue par des triggers (`60-courrier.sql`), comme
le classement ; une catégorie reste celle de sa personne (`CA017`).

**Limites.** Vingt catégories par personne et par entreprise, 40 caractères
par nom ; un nom unique pour la personne, à la casse près ; ni le nom d'une
catégorie proposée, ni « Non classé ».

**Suppression.** Ses plis redeviennent « non classés », dans la même
transaction ; la catégorie est effacée. La clé étrangère refuse d'effacer une
catégorie encore visée : un oubli du code échouerait, il ne laisserait pas de
classement orphelin.

**Catégorie ou étiquette.** Les étiquettes (ADR 044) restent du texte libre,
plusieurs par pli. L'écran des catégories le dit : « Une catégorie range un
courrier dans une seule rubrique, comme un dossier ; les étiquettes
s'ajoutent librement, plusieurs par courrier. »

**RGPD.** Le nom est du texte libre, comme une étiquette : à l'anonymisation
de la personne ou de l'entreprise (`90-rgpd.sql`), il devient « Catégorie »
suivi d'un repère neutre ; le classement reste, comme la catégorie proposée.

## Justification

**Pourquoi un message par entreprise, par le moteur.** C'est ce que demande la
recette (« journalisé ») et ce que le moteur sait faire : préférences par
personne, issue par entreprise, causes d'échec lisibles (ADR 059). Un seul
courriel en copie cachée ne dirait pas qui l'a reçu, et une adresse refusée
le ferait échouer pour tous.

**Pourquoi figer les entreprises à la confirmation.** L'aperçu a annoncé un
nombre ; l'envoi par paquets dure plusieurs minutes. Sans liste figée, un
contrat activé pendant l'envoi changerait les destinataires, et une reprise
ne saurait pas qui reste à servir.

**Pourquoi l'exploitant et la direction.** La recette laissait le choix entre
« l'équipe qui gère la domiciliation » et la direction. L'accueil tient le
courrier au quotidien, mais un texte libre à toute la clientèle relève de ce
qui engage le centre — la même ligne que les modèles de messages.

**Pourquoi une suppression physique des catégories.** La décision 6 de
`CLAUDE.md` vise les entités métier qui doivent rester consultables (contrat,
facture, état des lieux). Une catégorie personnelle est un réglage, comme une
étiquette, que l'on efface librement ; la garder « supprimée » bloquerait son
nom (index unique) sans rien conserver d'utile.

## Alternatives écartées

**Une campagne chez Brevo (API marketing).** Une copie des contacts chez un
tiers, des préférences en double, et une dépendance de plus.

**Une tâche planifiée pour l'envoi.** L'application n'a pas de file de tâches ;
`after()` et la reprise suffisent pour quelques centaines d'entreprises.

**Des variables dans le texte libre (`{{client}}`).** Une faute d'accolade
partirait telle quelle chez tous les clients ; le modèle, lui, cite déjà le
client et se vérifie à l'enregistrement.

**Garder les adresses dans l'historique.** Elles sont au journal, purgé au
terme de sa durée ; l'historique n'en a pas besoin pour compter.

**Des catégories par entreprise.** Voir la portée, ci-dessus.

**Remplacer la liste de départ par une table pour tous.** Migrer le classement
existant pour un gain nul : la liste proposée reste une énumération, les
catégories personnelles s'y ajoutent.

## Conséquences

- Migration de structure : `client_broadcasts`, `client_broadcast_recipients`,
  `mail_member_categories`, `mail_item_member_states.custom_category_id` (avec
  sa contrainte et sa clé étrangère), et les énumérations
  `notification_event` (+ `client_broadcast`), `notification_category`
  (+ `centre_info`) et `notification_related_type` (+ `client_broadcast`).
  Règles rejouées : `60-courrier.sql`, `70-notifications.sql`, `90-rgpd.sql`.
- Droit `notifications.diffuser` (exploitant, direction) ; entrée « Messages aux
  domiciliés » dans le rayon Domiciliation : le menu compte vingt entrées, la
  limite de `menu.test.ts`.
- Le journal des messages mène d'un envoi à son message (`/messages/{id}`).
- Les préférences de l'espace client ont une case de plus, « Informations du
  centre ».
- Reste, si le centre le demande : renvoyer aux seules entreprises en échec ;
  programmer un envoi à une date ; un message par produit pour les salles et le
  camion (clients des derniers mois). Jamais de pièce jointe (ADR 015).
