# ADR 065 — Connexion au CRM réglée par centre, depuis le back-office

**Date** : 2026-11-04
**Statut** : accepté — amende l'ADR 043 § 5 et l'ADR 049 § 2 (le jeton de
l'API Dolibarr se règle à l'écran, par centre ; `DOLIBARR_API_TOKEN` reste
accepté tant qu'aucun jeton n'y est réglé), amende l'ADR 046 § 2 (le site peut
tenir une clé pour appeler le CRM, chiffrée), complète l'ADR 054 (droit
`crm.gerer`, réservé à la direction) ; prépare la seconde tranche de la
passerelle (lot 10 de la recette du 04/11, ADR 066 à venir)

## Contexte

Recette du 04/11/2026, lot 9 : le produit sera vendu à d'autres centres, et
**chaque centre doit pouvoir brancher son CRM depuis son espace admin**.
Dolibarr est le premier, d'autres viendront.

Ce qui existait :

- l'intégration est propre à Dolibarr : routes `/api/dolibarr/*` (devis,
  ADR 043 ; produits par le module Webhook, ADR 049), code de correspondance
  dans `facturation/` (`propositions.ts`, `produits-dolibarr*.ts`) ;
- **Dolibarr vient chercher, le site n'appelle jamais Dolibarr** (ADR 043,
  ADR 046 § 2) ;
- le jeton d'accès est une variable du serveur, `DOLIBARR_API_TOKEN`, la même
  pour tout le serveur. **La production en dépend** : le connecteur du
  développeur Dolibarr et la cible de son module Webhook la présentent.

## Décision

### 1. Un module `src/modules/crm/`

La connexion au CRM n'appartient à aucun domaine : les devis et les produits
sont rangés dans `facturation/`, les tiers viendront dans `clients/`, les
contrats dans `contrats/`, les consommations du courrier et des réservations.
La recette proposait `clients/` ; c'est un **nouveau module**, qui tient ce qui
est commun à tous les flux et à tous les CRM : réglage par centre, jeton,
flux activés, journal, test, écran. Le format de chaque échange reste dans le
domaine qui en tient les données. `CLAUDE.md` (Structure) est mis à jour.

| Fichier | Rôle |
|---|---|
| `connecteurs.ts` | l'**interface commune** `CrmConnector`, les identifiants de CRM |
| `dolibarr.ts` | le premier branchement |
| `catalogue.ts` | `crmConnectors`, un `Record` exhaustif |
| `flux.ts` | le catalogue des flux |
| `jeton.ts`, `acces.ts` | le jeton présenté, et à quel centre il ouvre quoi |
| `appels.ts` | `serveCrmCall`, la porte commune des routes `/api/<crm>/*` |
| `adresse.ts` | l'adresse du CRM et l'appel sortant sous garde |
| `queries.ts`, `schema.ts` | réglage et journal en base |
| `test-connexion.ts`, `actions.ts`, `connexion-crm-forms.tsx`, `journal-echanges.tsx` | l'écran |

### 2. L'interface de connecteur

Un connecteur dit seulement ce qui change d'un CRM à l'autre : son nom, les
flux qu'il sait servir et leurs routes, sa notice, l'ancienne variable du
serveur qui l'ouvrait (`legacyTokenEnv`), les libellés de la clé pour
l'appeler, et `testConnection`, qui éprouve adresse et clé. Il est pur :
l'appel réseau lui est fourni (`CrmHttp`).

Brancher un autre CRM : un fichier comme `dolibarr.ts`, une ligne dans
`catalogue.ts`, sa valeur dans `crmConnectorIds` (énumération en base : une
migration), ses routes `/api/<crm>/*` servies par `serveCrmCall`.

Les routes de Dolibarr gardent leur adresse et leur format : c'est ce que son
développeur a branché.

### 3. Les flux

Cinq flux au catalogue, identifiés en anglais comme les autres valeurs de la
base :

| Flux | Sens des données | Servi | Ouvert par défaut |
|---|---|---|---|
| `quotes` — Devis | site → CRM (le CRM vient les chercher) | oui | oui |
| `products` — Produits et tarifs | CRM → site | oui | oui |
| `third_parties` — Tiers | CRM → site | **à venir** | non |
| `contracts` — Contrats | CRM → site | **à venir** | non |
| `consumptions` — Consommations facturables | site → CRM | **à venir** | non |

Un flux « à venir » s'affiche grisé, sans case cochable, et le serveur refuse
de l'activer. Les flux activés sont une liste JSON (`enabled_flows`) : un flux
nouveau n'exige pas de migration, et naît coupé. L'énumération du journal
porte déjà les cinq.

### 4. Un réglage par centre

Table `crm_connections`, une ligne au plus par centre (`tenant_id` unique) :
CRM choisi, adresse, empreinte du jeton et qui l'a posé quand, clé d'appel
chiffrée et sa date, flux activés, auteur de la dernière modification.

**Sans ligne, rien ne change** : Dolibarr, jeton du serveur, devis et produits
ouverts. La migration ne crée aucune ligne.

Changer de CRM retire le jeton d'écran et la clé : ils étaient ceux de
l'ancien.

### 5. Le jeton que le CRM présente au site

- **Généré à l'écran** : `crm_` suivi de 32 octets aléatoires en base64url —
  il passe tel quel dans une adresse (`?jeton=` du webhook). **Montré une
  seule fois**, avec l'adresse du webhook prête à copier.
- **Gardé par son empreinte SHA-256**, jamais en clair ni chiffré : le site
  n'a jamais à le relire. Un jeton de 256 bits n'a pas besoin d'un hachage
  lent.
- **L'empreinte est unique sur toute la base** : c'est elle qui **désigne le
  centre** d'un appel. Relue et comparée à temps constant.
- **Renouveler** remplace l'empreinte : l'ancien jeton cesse aussitôt.
  **Retirer** efface l'empreinte.

**Le jeton du serveur, `DOLIBARR_API_TOKEN`**, vaut pour le centre unique
**tant qu'aucun jeton n'y est réglé à l'écran**, jamais pour un autre centre.
Générer un jeton à l'écran le remplace ; le retirer le rétablit. Il est lu
exactement comme avant : `Authorization: Bearer`, l'en-tête nu, `?jeton=` pour
le webhook, le « + » d'un jeton base64 collé tel quel.

Sans jeton valide, toutes les routes répondent **404**, comme avant.

### 6. L'appel est servi pour le centre du jeton

`lib/tenant.ts` reçoit `runForTenant(tenantId, …)` : un contexte asynchrone
que `currentTenantId()` lit avant le centre unique. Toutes les requêtes déjà
écrites pour les devis et les produits — elles lisent `currentTenantId()` —
servent alors le centre du jeton sans qu'on les touche. C'est la première
porte de l'application qui ne passe pas par le centre unique.

**Une seule lecture sans filtre de centre**, voulue : la recherche de
l'empreinte (`crmAccessStore.byTokenHash`), puisque le centre n'est pas connu
avant elle.

### 7. Flux coupé

Jeton valide, flux coupé pour ce centre : **403** et
`{ "erreur": "Flux « Devis » désactivé dans les réglages du centre (Réglages > Connexion au CRM)." }`
sur les routes des devis ; **400** au webhook des produits, parce que Dolibarr
ne garde le message du site que pour un 400 (ADR 049, ADR 052).

### 8. Les identifiants pour appeler le CRM

Une adresse (https, publique, sans identifiant ni paramètre, normalisée sans
barre finale) et une clé — pour Dolibarr, la clé d'API d'un utilisateur dédié,
envoyée dans `DOLAPIKEY`. La clé est **chiffrée au repos** par `sealSecret`
(`SECRETS_ENCRYPTION_KEY`, comme le jeton Google de l'ADR 014), jamais
réaffichée : l'écran dit « Clé enregistrée le … ». Chiffrée par une autre clé
de serveur (restauration, rotation), elle est dite illisible, à ressaisir.

Elles ne servent aujourd'hui qu'au test : **aucun flux ne pousse vers le
CRM**. Les envois à venir les trouveront là.

### 9. « Tester la connexion »

Le CRM appelle le site, le site ne peut pas déclencher cet appel : le test
regarde les deux sens séparément.

- **Du CRM vers le site** : quel jeton est en vigueur (écran, serveur, aucun),
  et le dernier appel reçu, tiré du journal.
- **Du site vers le CRM**, si l'adresse et la clé sont réglées : pour
  Dolibarr, `GET /api/index.php/status` avec la clé, qui rend la version et
  n'ouvre aucune donnée. Seule la version est lue dans la réponse.

L'appel sortant est **sous garde** (`adresse.ts`), parce que l'adresse est
saisie par un centre et appelée par le serveur : https seulement, **adresse
publique seulement** (refus de `localhost`, des adresses privées, locales, de
lien, réservées, saisies en clair ou obtenues par le DNS, IPv4 glissées dans
une IPv6 comprises), aucune redirection suivie, 8 s au plus, 16 Kio lus au
plus. Le résultat va au journal.

### 10. Le journal des échanges

Table `crm_exchanges`, par centre : chaque appel reçu dont le jeton désigne
le centre — réussi, refusé (flux coupé, paramètre illisible, devis déjà
transmis) ou en panne — et chaque test. Il garde le sens, le flux,
l'opération (un modèle sans identifiant : `POST /api/dolibarr/devis/{id}/transmis`),
le code, une phrase (« 3 devis au statut « ready » », ou le message d'erreur
rendu au CRM), le jeton utilisé (écran ou serveur) et la durée. **Ni corps,
ni jeton, ni adresse IP.**

Un appel au jeton inconnu n'a pas de centre : il ne laisse rien en base (une
ligne au journal du serveur pour le webhook, comme avant). Le journal ne fait
jamais échouer un appel : une écriture refusée est seulement signalée au
journal du serveur.

**Purgé au-delà de 90 jours**, à chaque écriture du centre (index
`tenant_id, created_at`). L'écran montre les 30 derniers.

### 11. Droit et écran

Droit `crm.gerer`, **réservé à la direction** (ADR 054) : le jeton ouvre au
CRM les devis, les coordonnées des demandeurs et la grille de prix du centre.
Écran `/reglages/crm`, dans Réglages, section « Équipe et configuration » :
le CRM et ses identifiants, le jeton, les flux, le test, le journal.

### 12. Le point d'entrée du lot 10

Pour chaque flux de la seconde tranche :

1. la route `/api/dolibarr/<…>` écrit son travail dans
   `serveCrmCall(request, { connector: 'dolibarr', flow: 'third_parties', operation: '…' }, …)` ;
2. le flux s'ajoute à `flows` et à `routes` dans `dolibarr.ts` ;
3. sa description (`flux.ts`) et la notice `docs/integrations/dolibarr.md`
   sont relues.

Jeton, centre, activation à l'écran, journal et test suivent sans autre code.
Un flux qui pousserait vers le CRM trouvera l'adresse et la clé par
`crmOutboundCredentials()` et l'appel sous garde par `guardedHttp()`.

## Écarts avec `CLAUDE.md` et les ADR, assumés

- **Décision 1, « les lectures portent leur filtre `tenant_id` »** : la
  recherche de l'empreinte du jeton n'en porte pas, puisqu'elle trouve le
  centre. C'est la seule, et l'unicité de l'empreinte sur toute la base la
  rend sûre.
- **ADR 046 § 2, « le site ne tient ni identifiant ni version de
  Dolibarr »** : il peut désormais tenir une clé d'appel, chiffrée, à la
  demande de la recette. Les flux existants restent en lecture par le CRM
  (pull) ; rien ne part du site vers le CRM hors du test.
- **Décision 6** : le réglage se remplace sur place et le journal se purge.
  Ce sont un réglage et un journal technique, pas des entités métier — comme
  la connexion Google (ADR 014) et le journal des envois (ADR 038).

## Justification

**L'empreinte plutôt qu'un jeton chiffré.** Le site n'a jamais à relire le
jeton ; « affiché une seule fois » le veut. Une copie de la base, même avec la
clé du serveur, n'ouvre pas l'API ; et le jeton ne dépend pas de
`SECRETS_ENCRYPTION_KEY`.

**Le jeton d'écran remplace celui du serveur, il ne s'y ajoute pas.** Sinon
un renouvellement laisserait l'ancien jeton valide, et le centre ne saurait
pas ce qui ouvre son API.

**Un contexte d'appel plutôt qu'un centre passé en paramètre.** Les requêtes
des devis et des produits lisent déjà `currentTenantId()`, seul endroit prévu
pour changer de centre ; les reprendre une à une aurait été un écart large
pour le même résultat.

**Le flux coupé en 403, sauf pour le webhook.** Le connecteur des devis lit
le code ; Dolibarr ne garde le message que d'un 400.

## Alternatives écartées

- **Ranger la connexion dans `clients/`** : elle sert aussi les devis, les
  produits, les contrats et les consommations.
- **Des routes génériques `/api/crm/*`** : elles casseraient le connecteur
  déjà branché, pour un gain nul tant qu'il n'y a qu'un CRM.
- **Retirer `DOLIBARR_API_TOKEN` tout de suite** : la production s'arrêterait
  jusqu'à ce que le développeur Dolibarr pose un nouveau jeton.
- **Un jeton par flux** : plus de secrets à remettre et à renouveler ; un
  jeton par centre et des flux qu'on ouvre ou coupe suffisent.
- **Garder la clé d'appel en clair, ou la montrer en partie** : contraire à
  l'ADR 020 ; la date d'enregistrement suffit à savoir qu'elle est là.
- **Épingler l'adresse résolue (contre le rebond DNS)** : il faudrait un agent
  HTTP à part, donc une dépendance. Le risque restant est faible : l'appel ne
  rapporte qu'un code et une version.

## Conséquences

- **Migration 0008** (`crm_connections`, `crm_exchanges`), à appliquer en
  production par `docker compose run --rm migrer` (`infra/serveur/README.md`
  § 4). Les gardes de centre (`CA014`) et `updated_at` sont posés par le
  migrateur, comme pour toute table qui porte `tenant_id`.
- **Aucune variable nouvelle.** `DOLIBARR_API_TOKEN` reste lu tant qu'aucun
  jeton n'est réglé à l'écran ; il pourra être retiré du `.env` ensuite.
  `SECRETS_ENCRYPTION_KEY` (déjà posée pour Google) n'est nécessaire que pour
  enregistrer une clé d'appel. `APP_URL` compose l'adresse du webhook
  affichée.
- **Pour le développeur Dolibarr, rien ne change** tant que la direction ne
  génère pas de jeton. Le jour où elle le fait, il remplace le jeton dans
  l'en-tête de son connecteur **et** dans l'adresse de la cible du module
  Webhook, en même temps : l'ancien ne vaut plus.
- Chaque appel du connecteur écrit une ligne et purge les anciennes : quelques
  centaines de lignes par jour à une interrogation toutes les cinq minutes.
- **Multi-centres** : un second centre peut avoir son jeton, et ses appels
  sont servis pour lui. Le back-office, lui, sert encore le centre unique : le
  centre de la session reste à faire (`lib/tenant.ts`).
- **RGPD** : le journal ne porte pas de donnée personnelle (opérations,
  codes, codes de produits et messages du site). L'auteur du jeton est un
  membre de l'équipe, anonymisable comme ailleurs (ADR 040).

## Tests

`crm/jeton.test.ts` (forme, empreinte, comparaison à temps constant, lecture
de la requête comme avant), `crm/acces.test.ts` (ancien jeton, nouveau jeton,
jeton d'un autre centre, jeton d'un autre CRM, aucun jeton, flux coupé),
`crm/appels.test.ts` (404, centre de l'appel, journal, 403 ou 400, panne),
`crm/adresse.test.ts` (adresses refusées, IPv6, garde de l'appel),
`crm/connecteurs.test.ts` (catalogue, flux par défaut, test Dolibarr),
`crm/test-connexion.test.ts`, `crm/crm.db.test.ts` (clé chiffrée et illisible
ailleurs, empreinte unique sur toute la base, garde `CA014`, flux par centre,
journal par centre et purge), `api/dolibarr/acces.db.test.ts` (les routes
telles que Next les appelle : ancien jeton, nouveau jeton qui ferme l'ancien,
retrait, jeton d'un autre centre servi pour lui seul, aucun jeton, flux coupé,
erreur au journal), `lib/auth/permissions.test.ts` (`crm.gerer` à la direction
seule), `(admin)/menu.test.ts` (la page existe).
