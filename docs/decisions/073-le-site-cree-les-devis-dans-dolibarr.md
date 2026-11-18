# ADR 073 — Le site crée lui-même ses devis dans Dolibarr

**Date** : 2026-11-17
**Statut** : accepté — amende l'ADR 043 § 5 (« Dolibarr vient chercher, le
site n'appelle jamais Dolibarr ») et l'ADR 065 § 8 (« aucun flux ne pousse
vers le CRM »). Le mode d'avant reste le mode par défaut : rien ne change pour
un centre qui n'active pas l'envoi. Les choix marqués « à valider » attendent
l'exploitant.

## Contexte

Demande de l'exploitant (17/11/2026) : à chaque demande, le devis doit exister
dans Dolibarr, avec le modèle JSON de ses devis (tiers, contact, dates du jour,
fin de validité, lignes, champs `options_*`) et le rattachement du contact par
`POST /proposals/{id}/contact/{contactId}/CUSTOMER`.

Ce que dit le code aujourd'hui : le site expose `GET /api/dolibarr/devis` et le
connecteur du développeur de l'exploitant crée la proposition (ADR 043 § 5).
La raison donnée alors : le site ne dépend ni de la version de Dolibarr, ni de
sa disponibilité, ni de ses identifiants. L'ADR 065 a pourtant déjà posé ce
qu'il faut pour appeler Dolibarr — adresse, clé d'API chiffrée, appel sortant
sous garde, journal — et ne les employait qu'au test de connexion.

`CLAUDE.md` impose de consigner la contradiction plutôt que de l'appliquer en
silence : c'est cet ADR.

## Décision

### 1. Un choix par centre, coupé par défaut

Colonne `crm_connections.push_quotes` (faux par défaut), case « Le site crée les
devis dans le CRM » sous Réglages > Connexion au CRM, droit `crm.gerer`. Elle
exige l'adresse et la clé du CRM. Coupée, tout se passe comme avant : le CRM
vient chercher les devis prêts. Le flux « Devis » (ADR 065 § 3) reste le
coupe-circuit des deux modes.

### 2. Quand le devis part

Un devis « prêt » (validé d'office, ou validé par l'accueil) part **après la
réponse faite à l'utilisateur** (`after()`), jamais avant : la demande aboutit
même si Dolibarr est en panne. Points d'appel : demande publique d'une salle ou
d'un bureau, demande de l'espace client, devis validé ou créé par l'accueil.

Un devis qui n'est pas parti **reste « prêt »**. Il repart :

- au passage suivant (toute demande suivante relance l'envoi des prêts) ;
- par `POST /api/maintenance/devis-dolibarr` (`MAINTENANCE_TOKEN`), à planifier
  toutes les quelques minutes (`infra/serveur/README.md`) ;
- ou par `GET /api/dolibarr/devis`, si la direction coupe l'envoi : la route
  d'avant sert toujours les devis prêts.

Un seul passage à la fois par processus ; 25 devis au plus par passage.

### 3. Ce que fait un envoi

Dans l'ordre, sur l'API REST de Dolibarr (`DOLAPIKEY`) :

1. chercher une proposition de **même `ref_client`** (le numéro `DV-AAAA-NNNN`)
   — trouvée, rien n'est recréé : un envoi interrompu après la création se
   rejoue sans doublon ;
2. **le tiers** : le lien reçu de Dolibarr (`crm_links`, ADR 066) s'il existe,
   sinon recherche par SIRET, SIREN, puis adresse e-mail ; à défaut, création
   d'un tiers **prospect** (`client = 2`, code client automatique) ;
3. **le contact** : recherche par adresse e-mail dans les contacts du tiers,
   sinon création ;
4. **les produits** : chaque ligne est cherchée par la référence de son produit
   Dolibarr (`GET /products/ref/…`) — `tarif.<type>.<code>.<unité>` puis
   `tarif.<type>.<unité>` pour un prix de la grille, le code d'un service du
   catalogue (ADR 049). Sans produit trouvé, ligne libre ;
5. `POST /proposals` avec le modèle JSON ci-dessous ;
6. `POST /proposals/{id}/contact/{contactId}/CUSTOMER` ;
7. lecture de la référence donnée par Dolibarr, puis le devis passe
   « transmis » avec ce `dolibarrId` et cette `dolibarrRef` (comme
   `POST …/transmis`, qui reste servi).

Un échec au rattachement du contact n'annule pas la proposition (la refaire la
doublerait) : il est signalé au journal. Un échec ailleurs laisse le devis
« prêt ». Si Dolibarr est injoignable, le passage s'arrête (inutile d'essayer
les suivants).

### 4. Le modèle de proposition

`socid`, `contactid`, `ref_client`, `datec`, `date`, `date_creation`, `datev`,
`date_validation` — le **jour de la demande au fuseau du centre** (décision 4),
pas celui de l'envoi : un envoi repris le lendemain garde la date à laquelle le
demandeur a écrit — `fin_validite` = ce jour + **90 jours**, `lines`,
`array_options`.

Champs `options_*` **calculés** par le site : `options_date_dde`,
`options_date_dde_client`, `options_datretsouh` (jour de la demande),
`options_ville` et `options_code_postal_lieu_intervention` (le centre),
`options_dateapartir` et `options_dateavant` (début et fin de la réservation,
ou date de début d'une domiciliation), `options_nb_participant`,
`options_preciplanning` (message, réponses au questionnaire, réservation,
numéro du devis).

Champs **réglés par la direction** (`crm_connections.quote_extrafields`, JSON à
l'écran) : tous les autres — `options_typage_devis`, `options_origine_dde`,
`options_quiindiquelestatut`, `options_mode`, `options_numero_demande`… Ce sont
des codes des listes de son Dolibarr : le site ne les devine pas, il les
recopie, et ils l'emportent sur ceux qu'il calcule. Aucune valeur n'est livrée
par défaut. **À valider** : la liste des champs obligatoires du centre.

### 5. Le prix du devis est envoyé, même pour un produit Dolibarr

Le modèle d'origine laissait `subprice` à `null` pour que Dolibarr applique son
tarif. Le site envoie **toujours le prix du devis** : l'API REST de Dolibarr ne
complète pas le prix d'une ligne à la création, et le demandeur a vu un montant
figé (ADR 023, R11) — contrat, remise ou grille changée depuis. Le produit
(`fk_product`) relie la ligne à son tarif et à sa comptabilité, pas le montant.
Une remise en pourcentage suit la ligne ; une remise en montant devient une
ligne négative de même TVA, comme la notice le conseillait au connecteur.

### 6. Ce qui n'est pas fait

- **La proposition reste brouillon dans Dolibarr** : ni validation, ni envoi au
  client. Les champs `datev` et `date_validation` du modèle sont posés mais
  c'est l'accueil qui valide dans Dolibarr. **À valider** : valider d'office ?
- **L'issue** (signé, refusé) et **l'annulation** restent le travail du
  connecteur : `POST …/issue` et `GET /api/dolibarr/devis?statut=cancelled`.
- Aucune facture, aucune relance : l'ADR 046 tient.

## Justification

**Pousser plutôt que laisser chercher, pour ce centre.** L'exploitant veut le
devis dans Dolibarr à la demande, sans attendre le passage d'un connecteur ni
dépendre de son hébergement. Les identifiants, la garde réseau et le journal
existent déjà (ADR 065).

**Garder le mode d'avant et le coupe-circuit.** La disponibilité de Dolibarr
reste la raison de l'ADR 043 : le devis « prêt » est l'état stable, l'envoi
n'est qu'une tentative, la route `GET` la reprend. Un centre qui ne veut pas
confier l'écriture dans son CRM au site coche rien.

**`ref_client` pour l'idempotence.** Dolibarr n'a pas de clé d'idempotence ;
la référence du site est déjà « à porter en référence client » depuis l'ADR 043.

**Un prospect créé, jamais un client.** Le site ne sait pas si la demande
aboutira ; l'accueil transforme le tiers à la signature.

## Alternatives écartées

**Remplacer le mode « Dolibarr vient chercher »** : le connecteur de
production en dépend (ADR 065). Les deux coexistent.

**Les champs `options_*` dans le code, en dur** : les codes sont ceux du
Dolibarr de l'exploitant ; un second centre aurait les siens (produit
multi-centres, décision 1).

**Valider la proposition dans Dolibarr** : irréversible côté Dolibarr (numéro
définitif consommé) pour une demande que l'accueil n'a pas relue.

## Conséquences

- **Un seul des deux modes doit tourner pour les devis.** Si le connecteur de
  pull tourne encore pendant que l'envoi est actif, il ne verra plus aucun devis
  « prêt » (ils passent « transmis ») ; s'il y en a un en cours à ce moment, la
  recherche par `ref_client` évite le doublon, et son `…/transmis` répond 200 ou
  409 selon l'identifiant. À dire au développeur du connecteur.
- L'utilisateur Dolibarr de la clé d'API doit avoir le droit de **créer tiers,
  contacts et devis** ; le test de connexion (`/status`) n'éprouve pas ce droit,
  c'est le premier envoi qui le dit, au journal.
- Un second processus (grappe pm2) pourrait envoyer deux fois le même devis au
  même instant : la recherche par `ref_client` l'évite sauf coïncidence à la
  milliseconde. Pas de verrou en base tant qu'un processus suffit.
- `GET /api/dolibarr/devis` porte un champ de plus par ligne, `produitRefs` :
  les références des produits Dolibarr candidats, utiles au connecteur.
- La clé d'API sert désormais à **écrire** : elle reste chiffrée au repos et
  jamais réaffichée (ADR 065 § 8) ; l'utilisateur Dolibarr dédié doit n'avoir
  que les droits utiles.

## Tests

`devis-dolibarr.test.ts` (dates au fuseau du centre, fin de validité, champs
calculés et surchargés, lignes, remises, tiers prospect, contact, SIRET/SIREN,
enchaînement des appels, reprise sans doublon, échecs),
`dolibarr-api.test.ts` (appels, 404 = rien trouvé, filtres protégés, erreurs
lisibles, appel sortant qui écrit sous la même garde). L'envoi de bout en bout
(`pushReadyProposals` sur une base) n'a pas de test de base : à ajouter avec
l'environnement MySQL.
