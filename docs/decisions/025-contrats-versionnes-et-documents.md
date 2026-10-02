# ADR 025 — Contrats versionnés : lignes, avenants, segments d'occupation, documents

**Date** : 2026-10-01
**Statut** : accepté — amende l'ADR 006 (« l'échéancier est calculé, jamais
stocké ») et l'ADR 018 (« une occupation par contrat » ; « la ressource ne
change qu'avant le début du contrat »)

## Contexte

Le cahier des charges veut un contrat généré depuis l'offre, rendu en PDF
depuis un modèle et archivé, et des avenants (R12, seconde partie). Le contrat
porte aujourd'hui un seul montant par période (`amount_cents`) et une seule
ressource (`resource_id`).

Trois besoins ne tiennent pas dans ce modèle :

- **le détail du prix** : un bureau, deux postes de coworking remisés, un
  forfait de domiciliation, des frais de dossier — et la facture doit les
  reprendre ligne à ligne (R15) ;
- **le changement en cours de contrat** : une indexation au 1er juillet, un
  déménagement du bureau 1 au bureau 2 au 1er mai. L'ADR 018 l'interdit après
  le début du contrat, faute de pouvoir garder la trace de l'ancienne
  ressource : son occupation couvre toute la période et serait réécrite
  depuis le premier jour ;
- **le document remis** : ce que le client a signé doit rester lisible tel
  quel, même si le contrat évolue ensuite.

## Décision

### Un contrat est une suite de versions

- **La version initiale** : le contrat lui-même et ses lignes sans avenant.
- **Une version par avenant signé**, à sa date d'effet.

`contract_price_versions(contract_id)` rend les versions de prix :
l'initiale, puis chaque avenant signé qui porte un montant, chacune de sa date
d'effet à la veille de la suivante, la dernière jusqu'au dernier jour du
contrat (nul : sans terme). `contract_segments(contract)` rend, de la même
façon, les segments de ressource.

### Les lignes d'un contrat : `contract_lines`

Une ligne vise au plus un de : une ressource, un type de ressource (un poste de
coworking), un service, une offre entière — ou rien (ligne libre). Elle porte
une désignation, une quantité, une unité, un prix unitaire HT, une remise
(ADR 023), un taux de TVA, et dit si elle est récurrente (`is_recurring`) ou
ponctuelle (frais de dossier). Son montant net par période est calculé par la
base (`line_net_amount_cents`).

`amendment_id` nul : ligne de la version initiale ; sinon, ligne de l'avenant,
qui **remplace toutes les lignes précédentes** à sa date d'effet.

**Le montant d'une version suit ses lignes.** Quand un brouillon de contrat a
des lignes récurrentes, la base tient `contracts.amount_cents` égal à la somme
de leurs montants nets ; la valeur écrite par le code est ignorée. Même chose
pour `contract_amendments.amount_cents`. Un contrat sans ligne garde son
montant saisi, facturé en une ligne au taux `contracts.vat_rate_bp` (20 % par
défaut) : c'est le cas de tous les contrats antérieurs.

**Seul un brouillon s'écrit** (SQLSTATE `CA004`). Les lignes de la version
initiale ne s'écrivent que tant que le contrat est un brouillon non archivé ;
celles d'un avenant, tant qu'il est un brouillon non abandonné. Hors
brouillon, le prix, la TVA, la période de facturation, la devise et
l'engagement du contrat sont figés : ils changent par avenant. Une ligne ne se
supprime pas, elle se retire d'un brouillon (`deleted_at`).

Conséquence : un contrat se crée en brouillon, reçoit ses lignes, puis est
activé — dans la même transaction pour une reprise.

### Les avenants : `contract_amendments`

Un avenant a un numéro (1, 2, 3… par contrat, attribué par la base à la
création), une date d'effet, un objet, un statut (`draft`, `signed`), et ce
qu'il change :

- **le prix** : ses propres lignes, ou un `amount_cents` ; nul et sans ligne,
  le prix ne change pas ;
- **la ressource** : `changes_resource` vrai, la ressource devient
  `resource_id` à la date d'effet (nul : retirée).

Règles, tenues par la base :

| Règle | Refus |
|---|---|
| Un avenant s'établit sur un contrat en cours (`active`, non archivé) | `CA005` |
| Sa date d'effet suit strictement le premier jour du contrat, et ne dépasse pas son dernier jour | `CA005` |
| Elle suit strictement celle du dernier avenant signé : les avenants se succèdent | `CA005` |
| Un avenant qui ne change ni le prix ni la ressource ne se signe pas | `CA005` |
| Signé, il ne change plus, ni ses lignes | `CA004` |
| Un contrat qui a des avenants signés ne change plus de date de début | `CA004` |
| Un avenant ne se supprime pas ; un brouillon s'abandonne (`deleted_at`) | `42501` |

### L'occupation suit par segments

L'ADR 018 matérialise un contrat en **une** ligne de `bookings`. Avec les
avenants, un contrat en a **une par segment de ressource** :

- `bookings.contract_amendment_id` : l'avenant qui a ouvert le segment, nul
  pour le segment initial ;
- l'index unique `bookings_contract_occupation_key` porte désormais sur
  `(tenant_id, contract_id, coalesce(contract_amendment_id, …))`.

Un avenant qui fait passer un contrat du bureau 1 au bureau 2 au 1er mai :

- le bureau 1 reste occupé du premier jour du contrat au 30 avril inclus — la
  période passée reste vraie au planning et dans les indicateurs ;
- le bureau 2 est occupé à partir du 1er mai, sous le titre « Contrat X —
  avenant n° 1 ».

`apply_contract_occupation(contract)` est réécrite (migration 0031) : elle
compare les segments voulus aux lignes existantes et procède en deux passes —
annuler ce qui disparaît et mettre de côté ce qui se déplace, puis écrire les
segments voulus — pour que la contrainte d'exclusion ne voie jamais deux
segments du même contrat se chevaucher en cours de route. Elle est appelée par
le trigger de `contracts`, comme avant, et par celui de `contract_amendments` à
la signature d'un avenant qui change la ressource.

La contrainte d'exclusion (décision 3) protège le nouveau segment : si le
bureau 2 est déjà pris après le 1er mai, la signature échoue (`23P01`) et
l'avenant reste un brouillon.

Tout le tableau de l'ADR 018 reste vrai, segment par segment :

| Événement | Effet |
|---|---|
| Contrat sans avenant de ressource | Un seul segment, une seule occupation : rien ne change |
| Résiliation | Le dernier segment s'arrête au soir de la résiliation ; un segment qui commencerait après est annulé (« Contrat résilié avant la date d'effet de l'avenant ») |
| Archivage, désarchivage | Tous les segments sont annulés, puis rétablis |
| Avenant qui retire la ressource | Le segment précédent s'arrête la veille ; aucun segment après |
| Changement de ressource avant le début (`changeContractResource`) | Inchangé : le segment initial suit |

La limite de l'ADR 018 (« la ressource ne change qu'avant le début du
contrat ») est levée : après le début, on signe un avenant.

### L'échéancier se calcule depuis les versions

L'ADR 006 voulait un échéancier calculé, jamais stocké, « tant qu'aucune
facture n'est émise ». Il reste calculé, mais depuis les versions de prix :
chaque période est découpée aux dates d'effet, chaque morceau facturé aux
lignes de sa version, au prorata (ADR 023). Ce qui est stocké, et figé, c'est
la facture (ADR 026).

### Les documents remis : `contract_documents`

Chaque version remise au client — le contrat, puis chaque avenant — est
figée en données structurées : un instantané JSONB (contrat, parties, lignes,
ressource, conditions), une version (1, 2, 3… par contrat, attribuée par la
base), une empreinte SHA-256, une date, un auteur.

- **L'empreinte est calculée par la base**, sur la forme canonique de
  l'instantané (`snapshot::text`, UTF-8) : un document altéré après coup ne
  correspond plus à son empreinte.
- **Un document ne se réécrit pas** : le rôle applicatif n'a ni `UPDATE` ni
  `DELETE` ; une garde arrête aussi le propriétaire (`CA004`).
- **Le PDF n'est qu'une vue** : une page HTML imprimable rendue depuis
  l'instantané, avec sa feuille d'impression. Aucune bibliothèque de génération.

`contracts.offer_id` garde le lien vers l'offre d'origine (ADR 024).

### Droits

`contrats.avenants` (établir et signer un avenant, éditer les documents)
revient à l'exploitant, comme `contrats.activer` : c'est déplacer une
occupation et changer un prix.

## Justification

**Des versions plutôt que des modifications en place.** Une facture émise
reprend un prix ; si ce prix pouvait changer en place, la facture ne
s'expliquerait plus par le contrat. Une version datée garde les deux vrais.

**L'avenant remplace toutes les lignes.** Un avenant qui n'ajouterait qu'un
delta obligerait à rejouer la chaîne des avenants pour connaître le prix d'un
mois. Une version complète se lit seule.

**Un segment par ligne de `bookings`.** C'est ce qui garde la contrainte
d'exclusion comme seul arbitre (décision 3) : chaque segment occupe sa
ressource et lui seule, et les calendriers n'ont rien à apprendre — ils lisent
`bookings` comme avant.

**Le montant tenu par les lignes.** Tout le code existant lit
`amount_cents` (échéancier, écrans, tests) : il reste juste sans réécriture.

**L'empreinte en base.** Recalculer la forme canonique d'un JSONB en
TypeScript serait fragile ; la base la connaît.

## Alternatives écartées

**Réécrire le contrat à chaque changement et journaliser l'ancien** : le
journal devient la vraie source, et chaque lecture doit le rejouer.

**Un nouveau contrat à chaque avenant** (ce que l'ADR 018 imposait en
attendant) : la numérotation, l'historique client et l'engagement se
fragmentent, et la résiliation de l'ancien libère la ressource un jour trop
tôt ou trop tard.

**Une occupation par contrat bornée à la ressource actuelle** : le planning
passé deviendrait faux, et les indicateurs d'occupation (R31) avec lui.

**Générer le PDF par une bibliothèque** : une dépendance de plus (refusée par
la vague) pour ce qu'une feuille d'impression fait.

## Conséquences

- Les écrans qui affichent « la ressource du contrat » doivent lire le segment
  en cours (`contract_segments`), pas `contracts.resource_id`, qui reste la
  ressource de la version initiale. `findContractOccupation` rend le dernier
  segment.
- `selectOccupationConflicts` (nommer un conflit) ne connaît que la période
  entière du contrat : pour un avenant, nommer le conflit sur la nouvelle
  ressource à partir de la date d'effet.
- La facturation (ADR 026) facture chaque version à ses lignes, ou à son
  montant pour une version sans ligne.
- **À valider par le centre** : la forme des documents de contrat et
  d'avenant, et la règle « un avenant remplace toutes les lignes ».
