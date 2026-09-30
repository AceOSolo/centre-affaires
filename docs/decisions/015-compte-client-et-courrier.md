# ADR 015 — Espace client, courrier et réservations des entreprises clientes

**Date** : 2026-09-30
**Statut** : accepté

## Contexte

Le centre domicilie des entreprises : il reçoit leur courrier. Jusqu'ici, rien
dans l'application ne le représentait, et les clients n'avaient aucun accès.

Le besoin exprimé par le centre :

- depuis le back-office, l'équipe enregistre chaque pli reçu pour le client de
  son choix, en le numérisant ;
- le client dispose d'un espace personnel, « ma boîte aux lettres », où il voit
  son courrier ;
- il peut y demander l'ouverture et la numérisation d'un pli ;
- chaque ouverture est remontée, avec son détail, par client, pour être
  facturée.

C'est le module courrier de `CLAUDE.md`, qui impose déjà ses contraintes RGPD
(scans de courrier = documents sensibles) : hébergement en EU, durées de
conservation, journal d'accès sur la consultation des scans, pas de données
réelles en développement.

L'ordre de construction de `CLAUDE.md` place le portail client en tranche 4 et
le courrier en tranche 5, après la facturation récurrente (tranche 3). Cette
tranche est avancée à la demande du centre : la domiciliation est l'usage qui
appelle un accès client en premier. La facturation n'est pas construite ici ;
le relevé des ouvertures en sera la source.

## Décision

### Les comptes clients suivent le modèle de l'équipe

Une table `client_members` dans le module `clients` : une ligne par personne et
par entreprise, inscrite par son adresse depuis la fiche client, rattachée à son
compte Neon Auth à la première connexion. Mêmes règles que `staff_members`
(ADR 008) : l'existence d'un compte ne donne rien, le rattachement exige une
adresse que le service ne déclare pas non vérifiée, un retrait est une
suppression logique.

Une adresse peut figurer sur plusieurs fiches : un gérant qui domicilie sa
holding et sa SCI relève les deux boîtes avec un seul compte.

Un seul écran de connexion pour les deux populations. `/auth/suite` oriente
après coup : l'équipe vers le planning, les clients vers `/compte`.

### Le courrier : trois tables

- `mail_items` : un pli, son destinataire, son état. Trois états :
  `received` (fermé), `opening_requested` (le client a demandé l'ouverture),
  `opened` (ouvert et numérisé). La demande et l'ouverture portent chacune leur
  date et leur auteur ; des contraintes `check` empêchent l'état et les dates de
  se contredire.
- `mail_scans` : les numérisations, enveloppe et contenu, une de chaque au plus.
  La base ne garde que la clé de stockage.
- `mail_scan_views` : le journal d'accès, une ligne par consultation.

### Ce qui est facturé : l'ouverture, une seule fois

Une ouverture est facturable qu'elle vienne du client (depuis son espace) ou du
centre (numérisation systématique prévue au contrat, consigne par téléphone).
Le relevé montre l'origine ; c'est au centre de décider ce qu'il facture.

Le relevé est calculé depuis `mail_items.opened_at` sur un mois **du centre** —
pas un mois UTC. Il s'affiche par client et s'exporte en CSV pour la facturation.

Un pli ne s'ouvre qu'une fois : la transition est rejouée dans le `where` de la
mise à jour, deux clics simultanés ne produisent qu'une ouverture. Un pli retiré
(attribué au mauvais client, par exemple) sort du relevé.

### Stockage : Neon Object Storage, jamais d'URL directe

Le bucket `uploads`, déjà déclaré privé dans `neon.ts`. Neon Object Storage
existe en `aws-eu-central-1` (Francfort) et suit les branches comme la base.

Les numérisations ne sont **jamais** servies par une URL signée ou publique.
L'application lit le fichier et le renvoie, après avoir vérifié le droit
d'accès et inscrit la consultation au journal. Une URL signée, même courte,
peut être transmise, et sa consultation échappe au journal.

Le type de fichier est lu dans ses premiers octets (PDF, JPEG, PNG), jamais
dans ce que déclare le navigateur : un HTML déguisé en PDF, servi depuis notre
domaine, s'y exécuterait.

### Les réservations d'un client

`bookings.client_id`, facultatif, rattache une réservation à une entreprise :
elle apparaît alors dans « Mes réservations ». L'équipe choisit le client à la
saisie ou depuis la fiche de la réservation. Une demande déposée depuis le site
par une personne connectée à son espace est rattachée à son entreprise — à
condition qu'elle n'en représente qu'une : deviner laquelle, pour quelqu'un qui
en gère plusieurs, serait attribuer la facture au hasard.

Le client annule lui-même une demande **en attente**, tant qu'elle n'a pas
commencé. Une réservation confirmée s'annule auprès du centre : délais et frais
d'annulation relèvent du contrat, et les écrire dans le code serait décider à la
place du centre.

### Le journal d'accès ne se corrige pas

Le rôle applicatif n'a ni `UPDATE` ni `DELETE` sur `mail_scan_views`, et les
politiques RLS ne couvrent que la lecture et l'ajout. L'inscription au journal
précède l'envoi du fichier ; si elle échoue, le fichier n'est pas envoyé.

Les consultations par l'équipe y sont inscrites comme celles des clients.

### Conservation : durée par centre, purge nocturne

`tenants.mail_scan_retention_months` et `mail_access_log_retention_months`,
12 mois par défaut, entre 1 et 120. Une route protégée par `MAINTENANCE_TOKEN`
(`/api/maintenance/conservation`), appelée chaque nuit par une tâche du
serveur, efface les numérisations échues — le fichier du stockage, la ligne
restant marquée `deleted_at` — et purge le journal échu.

Le rôle applicatif ne peut toujours pas effacer le journal. La purge passe par
une fonction `SECURITY DEFINER` (migration 0024) qui n'efface que ce qui a
dépassé la durée du centre courant : l'application peut purger, jamais choisir
quoi. La durée est affichée au client dans sa boîte aux lettres.

### Courriels : ils préviennent, ils ne transportent pas

À l'arrivée d'un pli, à sa numérisation, à l'inscription d'une personne, et —
vers l'adresse du centre — à chaque demande d'ouverture. Ni le document ni
l'expéditeur n'y figurent. Envoi par le SMTP de **Brevo** (`SMTP_HOST`,
`SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM`), toujours chiffré
(STARTTLS exigé, ou TLS sur le port 465), après la réponse (`after()`) : un
courriel qui échoue est journalisé et ne fait jamais échouer
l'enregistrement. Sans configuration complète, rien ne part — c'est le cas du
développement.

Brevo, choisi par le centre, est un prestataire français qui héberge ses
données en Europe. Il est sous-traitant des adresses des clients : son accord
de traitement est à inscrire au registre, et le suivi des ouvertures et des
clics est désactivé — il ajouterait un pixel aux messages et ferait transiter
les liens vers l'espace client par son domaine.

## Justification

**Pourquoi `client_members` dans le module `clients`, alors que
`staff_members` est dans `src/db/`.** L'ADR 008 a sorti `staff_members` des
modules parce que l'accès au back-office n'est pas un domaine métier. L'accès
d'une personne à l'espace d'une entreprise cliente, lui, n'a pas de sens sans
cette entreprise : il appartient au domaine client.

**Pourquoi l'état sur le pli et pas une table d'événements.** Un pli s'ouvre au
plus une fois. Une table d'ouvertures séparée permettrait d'en enregistrer deux,
qu'il faudrait ensuite empêcher ; une date sur le pli rend le doublon
impossible par construction.

**Pourquoi relire le fichier plutôt que rediriger vers une URL signée.** Le
journal d'accès est une exigence de `CLAUDE.md`. Avec une redirection, on
journalise la délivrance d'un lien, pas la consultation. Le coût — le fichier
transite par le serveur de l'application — est négligeable pour des
documents de quelques mégaoctets consultés à l'unité.

**Pourquoi exiger l'endpoint du stockage explicitement.** Sans endpoint, le SDK
AWS s'adresse à AWS S3 dans sa région par défaut. Une variable manquante ne doit
pas envoyer du courrier numérisé hors d'Europe : l'application refuse de
démarrer le client de stockage plutôt que d'improviser.

**Dépendances nouvelles.** `@aws-sdk/client-s3` : Neon Object Storage parle S3 ;
c'est le client que documente Neon, maintenu par AWS, et il fonctionnera sans
changement avec tout stockage S3 européen (Scaleway, OVHcloud) si l'on quitte
Neon. Le client de présignature n'est pas ajouté : aucune URL signée n'est
émise. Écrire la signature SigV4 à la main aurait évité la dépendance au prix
d'un code de sécurité maison. `nodemailer` : SMTP standard, sans
dépendance, maintenu depuis quinze ans. Le fournisseur de courriel reste un
choix de configuration ; l'API HTTP de Brevo l'aurait figé dans le code.

## Conséquences

**Les réservations passées restent sans client.** Celles saisies avant cette
tranche n'ont pas de `client_id` ; l'équipe les rattache une à une depuis leur
fiche si elle veut les voir dans l'espace client.

**Le domaine expéditeur est à authentifier chez Brevo.** Sans les
enregistrements DKIM, DMARC et SPF dans la zone OVH, les messages finissent en
indésirables. Procédure : `infra/serveur/README.md`, étape 8. Tant que la clé
SMTP n'est pas posée, l'application fonctionne mais ne prévient personne, et
l'écran d'inscription le dit.

**Douze mois, validés par le centre le 2026-09-30**, pour les numérisations
comme pour le journal d'accès. Ils se règlent dans
`infra/configurer-centre.mjs` et doivent figurer au contrat de
domiciliation. La tâche nocturne doit être posée sur le serveur
(`infra/serveur/README.md`), sans quoi rien n'est purgé.

**Le relevé compte, il ne tarife pas.** La facturation est hors V1
(`CLAUDE.md`) : le prix d'une ouverture n'est porté nulle part, le relevé et son
export servent à la reporter à la main.

**Identifiants de stockage en production.** `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL_S3` et `AWS_REGION` sont écrits par
`neon env pull` en développement ; sur le VPS (ADR 013), ils doivent être
renseignés à la main, ceux de la branche `production`.

**Taille des envois.** Une action serveur est limitée à 1 Mo par défaut, et le
filtre `proxy.ts` tronque silencieusement au-delà de 10 Mo. Les deux limites
sont portées à 21 Mo dans `next.config.ts` : deux fichiers de 10 Mo au plus.
Apache plafonne à 22 Mo (`LimitRequestBody`).

**Accès refusé.** L'écran d'accès refusé vaut désormais pour les deux
populations ; un client arrivé sur le back-office y trouve un lien vers son
espace.

## Alternatives écartées

**Réutiliser `staff_members` avec un rôle `client`.** Une seule table d'accès.
Écarté : un membre de l'équipe voit tout le centre, un client ne voit que son
entreprise. Un rôle mêlé aux deux aurait mis la frontière la plus sensible du
produit dans une condition `if` au lieu d'une table.

**Envoyer les numérisations par courriel.** Ce que font beaucoup de centres. Une
pièce jointe échappe au journal d'accès, à la durée de conservation et au
retrait en cas d'erreur de destinataire. Le courriel servira à prévenir, pas à
transporter.

**URL signées vers le stockage.** Plus simple et sans passage par le serveur.
Écarté pour la raison donnée plus haut : le journal d'accès est une exigence.
