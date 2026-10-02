# ADR 040 — Anonymisation RGPD des clients, contacts, accès et membres retirés

**Date** : 2026-10-02
**Statut** : accepté — construit la partie code de R29 annoncée par l'ADR 020
et le registre (`docs/rgpd/durees-de-conservation.md`) ; les durées proposées
sont *à valider* par le centre

## Contexte

Le registre des traitements et le tableau des durées (R29, D9) proposent :

- prospect : 3 ans après le dernier contact ;
- client : la durée de la relation, puis 5 ans (prescription commerciale,
  art. L.110-4 du Code de commerce) ;
- contacts : suivent la fiche ;
- plis : l'expéditeur et la note partent avec la relation ;
- accès à l'espace client et membres de l'équipe retirés : la ligne reste,
  car elle signe des actions passées, mais leur nom et leur adresse doivent
  partir « après un délai » — à fixer.

Et une règle commune : **pas de suppression physique** (décision 6). Au
terme, on anonymise. Les factures émises, elles, se conservent 10 ans
(art. L.123-22 du Code de commerce), avec l'identité de l'acheteur figée à
l'émission (ADR 026).

Rien ne l'appliquait : l'anonymisation était « à construire ».

## Décision

### Ce qui est marqué

`anonymized_at` sur `clients`, `client_contacts`, `client_members`,
`staff_members` ; `sender_anonymized_at` sur `mail_items`. Posés par la base
seulement : un garde (`anonymized_rows_guard`, migration 0043) refuse
d'écrire ou d'effacer `anonymized_at` hors des fonctions, et toute
modification d'une ligne anonymisée (`CA012`). Une fiche ou un contact
anonymisés sont archivés ; un accès ou un membre anonymisé est un accès
retiré, détaché de son compte (contraintes).

### Les durées, par centre

| Colonne de `tenants` | Défaut | Départ |
|---|---|---|
| `prospect_retention_months` | 36 | dernière activité d'un prospect |
| `client_retention_months` | 60 | dernière activité d'un client (fin de la relation) |
| `removed_member_retention_months` | 12 | retrait de l'accès ou du membre |

La **dernière activité** est `client_last_activity_on(client)`, jour civil
du centre : le plus tardif de la création de la fiche, du dernier contact
noté (`clients.last_contact_on`, saisi par l'équipe), du dernier jour de
chaque contrat (aujourd'hui s'il est sans terme), de la fin de la dernière
réservation, du dernier pli et de la dernière demande de courrier, de la
dernière facture émise et du dernier paiement, du dernier état des lieux.

### Les exclusions

`client_anonymization_blockers(client)` rend, en phrases, ce qui empêche
d'anonymiser — tableau vide : rien. **Jamais anonymisée** une entreprise qui
a :

- une facture non soldée (émise ou partiellement payée), ou un brouillon de
  facture ou d'avoir ;
- un contrat vivant : brouillon, en cours, ou résilié à une date à venir ;
- une réservation à venir ou en cours ;
- un service souscrit en cours ;
- un mandat de prélèvement actif ;
- une demande de courrier en cours ;
- un état des lieux en saisie.

### Les fonctions

Toutes SECURITY DEFINER, `search_path` figé, filtrées sur
`current_tenant_id()`, refusées sous portée client (`CA012`) — le modèle de
`anonymize_expired_public_requests()` (migration 0026) :

| Fonction | Usage |
|---|---|
| `anonymize_client(id)` | à la demande (droit à l'effacement, fin de relation constatée) : sans attendre la durée, jamais contre une exclusion (`CA012`, le message les énumère) |
| `anonymize_expired_clients()` | tâche nocturne : prospects et clients au terme de leur durée, exclusions passées sans erreur ; rend le nombre |
| `anonymize_removed_members()` | tâche nocturne : accès et membres de l'équipe retirés depuis plus que la durée ; rend le nombre |
| `anonymize_client_member(id)`, `anonymize_staff_member(id)` | à la demande, un accès ou un membre **déjà retiré** (`CA012` sinon) |

### Ce qui part, ce qui reste

Pour une entreprise :

| Où | Ce qui part | Ce qui reste |
|---|---|---|
| fiche | raison sociale (« Client anonymisé » et le début de l'identifiant), forme, SIRET, TVA, coordonnées, adresse, notes, dernier contact ; passée `inactive`, archivée | identifiant, compte auxiliaire (les écritures passées le citent), pays |
| contacts | nom, fonction, coordonnées, notes | la ligne, archivée |
| accès | adresse (remplacée par une adresse inexistante en `.invalid`), nom, compte | la ligne, retirée : elle signe des demandes, des consultations, des validations |
| plis | expéditeur, note | type, dates, ouverture, relevé |
| demandes de courrier | consigne, adresse de réexpédition | nature, états, dates, auteurs, frais |
| réservations | coordonnées de demandeur, notes | créneau, objet, statut, canal, devis |
| contrats | notes, motif de résiliation | tout le reste |
| mandats non actifs | nom du titulaire | RUM, IBAN chiffré (durée propre à construire, ADR 034) |
| journal des messages | adresses, objet | événement, statut, date |
| **factures, avoirs, lignes, paiements, instantanés, relances, documents de contrat, états des lieux** | **rien** | tout : pièces comptables et probantes |

Pour un accès ou un membre de l'équipe retiré : adresse, nom, compte. La
ligne reste.

## Justification

**Pourquoi des fonctions en base.** L'application déclenche, la base choisit
quoi effacer, comme pour le journal d'accès et les demandes publiques : une
erreur de code ne peut ni anonymiser une entreprise sous exclusion, ni
effacer ce qu'une obligation légale fait garder.

**Pourquoi ne pas toucher aux factures.** L'instantané de l'acheteur est la
mention obligatoire de la facture, conservée dix ans. Il est figé à
l'émission précisément pour qu'aucune modification de la fiche ne le
change ; l'anonymisation en est une.

**Pourquoi garder le compte auxiliaire.** Les exports comptables des
exercices passés le citent ; le livre d'un exercice clos se conserve comme
ses pièces.

**Pourquoi une date de dernière activité calculée.** Elle ne peut pas se
contredire : une colonne tenue par des déclencheurs sur huit tables
oublierait un jour l'une d'elles. Le dernier contact, lui, ne se déduit de
rien : l'équipe le note.

## Alternatives écartées

**Supprimer les lignes.** Contraire à la décision 6, et cela casserait les
factures, le relevé et les historiques.

**Anonymiser à la main, champ par champ.** Rien ne garantirait l'exhaustivité
ni le respect des exclusions.

**Effacer aussi l'instantané des factures.** Interdit par l'obligation de
conservation.

## Conséquences

- La tranche RGPD construit l'écran d'anonymisation (droit
  `rgpd.anonymiser`, exploitant), qui affiche
  `client_anonymization_blockers()` avant d'appeler `anonymize_client()`,
  la saisie du dernier contact sur la fiche, et l'appel des fonctions
  nocturnes dans `/api/maintenance/conservation`. Elle met à jour
  `docs/rgpd/` (durées, mécanismes).
- Les écrans affichent une ligne anonymisée telle quelle (« Client
  anonymisé … », « Personne anonymisée ») et ne proposent plus de la
  modifier (`CA012`).
- *À valider par le centre* : les trois durées, et le traitement des mandats
  révoqués (IBAN chiffré conservé en attendant leur durée propre).

## Mise en œuvre

Ajoutée par la tranche RGPD de la dernière vague (partie code de R29). Aucune
dépendance, aucune migration : le code appelle les fonctions de la
migration 0043 et rapporte ce qu'elles ont fait. Module
`src/modules/rgpd/`.

### Tâche de nuit

`POST /api/maintenance/conservation` (la purge du courrier, ADR 015, 020)
appelle, après les demandes publiques et avant le stockage, chacune dans sa
transaction :

- `anonymize_expired_clients()` (`anonymizeExpiredClients`) : prospects et
  clients au terme de leur durée, exclusions passées sans erreur ;
- `anonymize_removed_members()` (`anonymizeRemovedMembers`) : accès et
  membres de l'équipe retirés depuis plus que leur durée.

Le détail se compte dans la même transaction : les fonctions posent
`anonymized_at = now()`, et `now()` est l'heure de début de la transaction,
si bien que les lignes marquées à cet instant sont exactement celles du
passage. La réponse de la route et le journal de l'application ne portent
que des nombres :

```json
{ "anonymizedClients": { "clients": 1, "contacts": 2, "accesses": 1, "mailSenders": 14 },
  "anonymizedMembers": { "accesses": 0, "staff": 1 } }
```

et une ligne « Conservation (RGPD) : 1 entreprise anonymisée (2 contacts,
1 accès, 14 plis) ; … » (`src/modules/rgpd/bilan.ts`). Ni nom, ni adresse,
ni identifiant : le journal ne doit pas devenir la copie de ce qu'on vient
d'effacer. Les expéditeurs des plis partent avec l'entreprise : il n'y a pas
de durée propre aux plis (voir « À valider »).

### Durées à l'écran

Les neuf durées de `tenants` (courrier, consultations, demandes publiques,
prospect, client, membres retirés, journal des messages, photos et
consultations des états des lieux) se règlent dans **Configuration du
centre** (`centre.configurer`), section « Durées de conservation »
(`durees.ts`, `durees-form.tsx`). Pour chacune : son départ, ce qui se passe
au terme, sa valeur par défaut, son statut (« validée le 30/09/2026 » pour
le courrier, « à valider » pour les autres) et ses bornes, celles des
contraintes de la base (1 à 120 mois ; un test vérifie que l'écran et la
base refusent les mêmes valeurs).

**Raccourcir une durée se confirme.** Ce qui dépasse la nouvelle durée est
effacé ou anonymisé dès la nuit suivante, données déjà présentes comprises :
l'écran liste les durées raccourcies et demande de cocher une confirmation
avant d'écrire.

La section annonce aussi ce que la prochaine nuit fera avec les durées
enregistrées (`readAnonymizationOutlook`, mêmes critères que les fonctions,
en lecture seule) : nombre d'entreprises et de personnes anonymisées, et les
entreprises **au terme mais retenues** par une exclusion, nommées avec leurs
exclusions : c'est à l'équipe de solder, terminer ou révoquer.

`infra/configurer-centre.mjs` ne pose plus aucune durée : le rejouer ne doit
pas défaire le choix du centre.

### Fiche client

- En-tête : « Anonymisée le JJ/MM/AAAA » ; « Modifier la fiche » disparaît
  (la page de modification le dit aussi).
- Section « Conservation des données (RGPD) » :
  - dernière activité (`client_last_activity_on`), dernier contact noté, et
    la date après laquelle la nuit anonymise la fiche (dernière activité plus
    la durée des prospects ou des clients), ou « suspendue » s'il y a une
    exclusion ;
  - **saisie du dernier contact** (`clients.gerer`) : un jour passé ou
    aujourd'hui, jamais à venir — une date future repousserait
    l'anonymisation sans contact réel (`dernier-contact.ts`, testé) ;
  - **anonymisation à la demande** (`rgpd.anonymiser`, exploitant) : les
    exclusions de `client_anonymization_blockers()` sont affichées avant
    tout geste ; sans exclusion, un dialogue de confirmation dit ce qui part
    et ce qui reste, puis appelle `anonymize_client()`. Un refus de la base
    (exclusion apparue entre-temps) est rendu dans le dialogue, avec la liste
    des exclusions et le conseil de la base (`HINT`) ;
  - **accès retirés** : retirés le, conservés jusqu'au, ou anonymisés le ;
    l'exploitant peut anonymiser l'un d'eux à la demande de la personne
    (`anonymize_client_member()`).
- Écran « Équipe » : section « Membres retirés », même tableau,
  `anonymize_staff_member()`.

Le code ne pose jamais `anonymized_at` ni `app.anonymization` ; un refus
`CA012` est lu hors de la transaction, déjà annulée.

### Tests

- `src/modules/rgpd/anonymisation.db.test.ts` : la nuit anonymise au terme,
  passe une facture impayée et un mandat actif, laisse la facture émise du
  client parti, ses lignes et ses paiements identiques ; un
  second passage ne trouve rien et ne réécrit rien ; la prévision de l'écran
  annonce ce que la nuit fait ; refus motivé à la demande (numéro de facture
  et conseil), puis succès une fois soldée, puis refus « déjà anonymisée » ;
  accès et membres seulement retirés ; dernier contact qui repousse
  l'échéance ; bornes des durées identiques à l'écran et en base.
- `src/app/api/maintenance/conservation/conservation.db.test.ts` : la route
  rapporte et journalise des nombres seulement, une fois.
- `durees.test.ts`, `dernier-contact.test.ts` : règles pures.

### À valider

- Les durées, toutes « à valider » sauf le courrier (registre,
  `docs/rgpd/durees-de-conservation.md`).
- Les plis n'ont pas de durée propre : l'expéditeur et la note partent avec
  l'entreprise, au terme de la durée des clients. Le registre proposait
  « durée du contrat de domiciliation, puis 5 ans » : c'est ce que donne la
  durée des clients quand la domiciliation est le dernier contrat. Une durée
  plus courte pour les seuls plis demanderait une colonne et une fonction.
- Le dernier contact se note à la main ; un échange par courriel ou un appel
  non noté ne repousse rien.
