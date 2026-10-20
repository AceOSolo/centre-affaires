# ADR 052 — Correctifs de la vérification du 20/10/2026 : pages du courrier, relevé, devis refait, mot de passe oublié, adresse du centre, webhook Dolibarr

**Date** : 2026-10-20
**Statut** : accepté — amende l'ADR 044 § 3 (correction des pages), l'ADR 037
et l'ADR 046 § 2 (relevé des demandes de courrier), l'ADR 043 § 3 (devis
refait après annulation), les ADR 048 et 050 (compteur des demandes) et
l'ADR 049 (codes de réponse, suivi d'un renommage) ; complète les ADR 045 et
047 (mot de passe oublié)

## Contexte

Le 20/10/2026, sept sessions ont travaillé en parallèle sur `main` (ADR 043 à
050). Une vérification de fin de journée a confronté chaque demande de
l'exploitant au code, ainsi que les demandes plus anciennes (18/09 au 02/10).
Aucune collision de numéro (migrations, ADR, codes `CAnnn`), CI verte, 2 134
tests au vert. Elle a relevé des défauts, corrigés dans la foulée, dont
certains changent une règle écrite dans un ADR antérieur. Cet ADR consigne
ces changements de règle ; les corrections sans effet sur une décision
(accessibilité, filtres `tenant_id` en lecture, liens, libellés) sont dans
l'historique git.

Le constat qui pèse le plus n'est pas dans le code : **rien n'est en
production depuis le 06/10** (job de déploiement retiré le 15/10, e469801).
La mise en ligne manuelle est décrite dans `infra/serveur/README.md` § 4 ;
le serveur web est nginx (ADR 051).

## Décision

### 1. Le nombre de pages d'un scan ne se corrige plus une fois le mois clos

L'ADR 044 § 3 laissait corriger le nombre de pages « tant qu'aucune facture
ne tient la numérisation ». Depuis l'ADR 046, le site n'émet plus de
facture : la garde ne s'appliquait plus jamais, et le relevé d'un mois déjà
reporté dans Dolibarr changeait en silence.

La correction est désormais refusée **une fois terminé le mois où le contenu
figure au relevé**, en mois civil du fuseau du centre : le mois de la
numérisation demandée si le contenu en vient, sinon celui de l'ouverture du
pli. Refus en code (`PagesLockedError`, `canCorrectPages`) et en base
(`mail_scans_before_update`, `CA017`). Le message renvoie vers Dolibarr, où
la ligne déjà reportée se corrige. La fiche du pli ne propose plus la
correction pour un mois clos.

Écarté : un journal des corrections (aucun journal générique en base, il
aurait fallu une table de plus pour un cas rare).

### 2. Le relevé du courrier porte aussi les demandes faites dans le mois

Les numérisations demandées et les réexpéditions sont facturables (ADR 037,
ADR 046 § 2), mais depuis l'arrêt du lot de facturation elles ne
paraissaient dans aucun relevé. Le relevé mensuel et son export portent
désormais **une ligne par prestation** : ouverture (relevée par le pli, une
seule fois), numérisation demandée, réexpédition (avec ses frais
d'affranchissement). Plis retirés exclus. L'export devient
`releve-courrier-AAAA-MM.csv`, avec les colonnes `Prestation`, `Fait le`,
`Fait par` et `Frais d'affranchissement`.

### 3. « Aucun courrier aujourd'hui » ne termine plus la tournée d'un collègue

Le bouton envoyait un identifiant de tournée vide : une tournée ouverte
entre-temps par un collègue était terminée à sa place, et les avis partaient
sur une saisie incomplète. Il envoie désormais la valeur explicite « aucune »,
et la tournée vide est refusée (`MailBatchOpenedError`) si une tournée s'est
ouverte entre-temps.

### 4. Un devis annulé se refait

L'ADR 043 prévoit « on l'annule et on en refait un » (réservation déplacée
après transmission), mais l'unicité d'un devis par réservation comptait les
annulés. Migration 0004 : colonne générée `proposals.live` (1 tant que le
devis n'est pas annulé, `NULL` sinon) et index unique
`(tenant_id, booking_id, live)` à la place de `(tenant_id, booking_id)`.
MySQL n'a pas d'index partiel ; plusieurs `NULL` ne se heurtent pas. La fiche
de la réservation et celle du devis annulé proposent « Refaire le devis ».

### 5. Mot de passe oublié

Demandé le 30/09, absent jusqu'ici ; l'inscription libre (ADR 045) le rend
indispensable. Better Auth `sendResetPassword` par le SMTP du site
(`src/lib/courriel.ts`), lien valable une heure, pages
`/auth/mot-de-passe-oublie` et `/auth/nouveau-mot-de-passe`. Même réponse que
l'adresse ait un compte ou non. Comme l'inscription (ADR 047), la demande
exige la preuve ALTCHA et un plafond (3 par 15 minutes) : elle fait partir un
courriel vers une adresse saisie par un inconnu. Les sessions ouvertes sont
fermées après la réinitialisation.

### 6. L'adresse e-mail du centre se règle à l'écran

Les alertes à l'équipe partent vers `tenants.email`, qui n'était réglable
nulle part : elles ne partaient jamais. Champ obligatoire dans Configuration
du centre ; `infra/configurer-centre.mjs` lit `CENTRE_EMAIL` et, sans elle,
garde l'adresse saisie à l'écran.

### 7. Le compteur des demandes compte aussi les offres demandées

« Demandes » liste les offres demandées (ADR 048), mais ni le compteur du
menu ni la tuile d'« Aujourd'hui » (ADR 050) ne les comptaient. Un seul
calcul pour les deux : `inboxCount`.

### 8. Webhook des produits Dolibarr : 400, journal, et ce que Dolibarr envoie vraiment

Vérifié dans le code de Dolibarr (`interface_95_modWebhook_WebhookTriggers`) :
le déclencheur « Non bloquant » n'existe qu'à partir de la version 22 (avant,
tout refus annule l'enregistrement du produit), et le message du site n'est
gardé que pour une réponse **400**, à partir de la 23. Les refus répondent
donc 400 au lieu de 422 et 409, et chaque appel laisse une ligne dans le
journal du serveur, sans le jeton. Dolibarr n'envoie jamais `oldcopy` : le
suivi d'un renommage prévu par l'ADR 049 ne fonctionne pas, un produit
renommé arrive comme un nouveau. La notice `docs/integrations/dolibarr-produits.md`
le dit, avec une liste de vérification pour le développeur Dolibarr.

## Laissé en attente, à trancher

- **Rétablir le déploiement automatique** : décision de l'exploitant et du
  développeur qui l'a retiré.
- **Services reçus de Dolibarr** : toute référence sans préfixe `tarif.`
  entre au catalogue du site, services internes compris. Un préfixe dédié
  serait plus sûr.
- **Demande publique non confirmée** : elle occupe le créneau. Un robot
  patient peut en poser beaucoup malgré les plafonds (ADR 047).
- **Durée de conservation des devis** : non fixée dans `docs/rgpd/`.
- **Lectures sans filtre `tenant_id`** : il en reste, notamment dans
  `reservations/queries.ts` (décision 1 de `CLAUDE.md`, avant un second
  centre).

## Conséquences

À la prochaine mise en ligne : `docker compose run --rm migrer` applique les
migrations 0001 à 0004 (et les suivantes) et rejoue les règles, dont la
nouvelle garde de `60-courrier.sql`. L'adresse du centre se saisit dans
Configuration du centre, faute de quoi les alertes à l'équipe restent
« non envoyées » dans le journal.
