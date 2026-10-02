# ADR 021 — Numérotation des documents

**Date** : 2026-10-01
**Statut** : accepté

## Contexte

La référence d'un contrat est saisie à la main (`contracts.reference`). Le
cahier des charges veut un contrat généré, donc numéroté automatiquement (R12).
La vague 2 émettra des factures et des avoirs (D1, ADR 016).

Pour les factures, la loi impose un numéro unique, fondé sur une séquence
chronologique et continue, sans rupture (CGI, art. 242 nonies A). Il ne faut ni
trou ni doublon, y compris quand deux factures sont émises au même instant.

Deux questions restent :

- où tenir les compteurs pour que la garantie vienne de la base ;
- faut-il repartir à 1 chaque année ?

## Décision

### Une table de compteurs, une fonction pour les faire avancer

`document_sequences` (`src/db/numerotation.ts`) contient une ligne par
**centre**, **type de document** (`document_type` : `contract`, `invoice`,
`credit_note`) et **année**, avec le dernier numéro attribué (`last_value`).

Le code ne lit ni n'écrit jamais ces compteurs lui-même. Il appelle :

```sql
SELECT next_document_number('invoice');  -- 'FA-2026-0001'
```

La fonction est en `SECURITY DEFINER` et travaille dans le centre du contexte
(`app.tenant_id`). Elle refuse de numéroter hors contexte.

| Type | Préfixe | Exemple |
|---|---|---|
| `contract` | `CT` | `CT-2026-0001` |
| `invoice` | `FA` | `FA-2026-0001` |
| `credit_note` | `AV` | `AV-2026-0001` |

Le numéro a quatre chiffres au moins. Au-delà de 9999, il en prend davantage
sans être tronqué. Les préfixes sont repris dans `documentPrefixes`.

**Sans trou ni doublon.** L'`INSERT … ON CONFLICT DO UPDATE` verrouille la ligne
du compteur jusqu'à la fin de la transaction appelante :

- une seconde transaction attend, puis lit la valeur validée ;
- une transaction annulée rend son numéro.

Un test le prouve sur vingt numérotations concurrentes (`numerotation.db.test.ts`).

**Compteurs protégés.** Le rôle applicatif lit `document_sequences` mais ne
peut pas l'écrire : `INSERT`, `UPDATE`, `DELETE` et `TRUNCATE` lui sont retirés.
Un compteur que l'application pourrait remettre à zéro ne garantirait plus rien.

### Une série par an, l'année dans le numéro

La numérotation repart à 1 chaque année civile **du centre** (dans son fuseau),
et l'année figure dans le numéro. Chaque série annuelle est elle-même continue.

La doctrine fiscale admet des séries distinctes, y compris par année, dès lors
que chacune est chronologique et continue et que le numéro identifie sa série.
L'année en préfixe joue ce rôle. C'est l'usage courant, et le numéro dit d'un
coup d'œil de quelle année il date. **À faire confirmer par l'expert-comptable
du centre avant la première facture.**

Une contrainte en découle : un document est numéroté dans l'année de sa date
d'émission. La date d'une facture est donc celle du jour où elle reçoit son
numéro, dans la même transaction.

### Les contrats sont numérotés à la création, sauf référence saisie

`contracts.reference` a pour valeur par défaut `next_contract_reference()` :

- **Référence omise** (en TypeScript, `reference` vaut `undefined`) : la base
  attribue le numéro suivant.
- **Référence saisie à la main** : elle reste acceptée. Les contrats repris
  d'avant l'application gardent la leur.
- **Référence vide ou blanche** : refusée (`contracts_reference_not_blank`).

Si une référence saisie à la main porte déjà le numéro suivant, il est passé.
Les contrats archivés comptent aussi. Sans cela, la numérotation automatique
retomberait sur ce numéro à chaque tentative, et resterait bloquée pour
toujours. Un numéro passé ainsi n'est pas un trou : il est porté par ce contrat.

Le numéro est pris dès la création du brouillon. Un brouillon abandonné est
archivé, pas supprimé (décision 6) : son numéro reste porté par sa ligne.

### Les factures (vague 2)

Une facture est numérotée **à son émission**, pas à la création du brouillon,
par `next_document_number('invoice')` :

- dans la transaction qui la fige ;
- avec la date du jour du centre comme date d'émission.

Les avoirs ont leur propre série (`credit_note`).

## Justification

**Pourquoi pas une `SEQUENCE` Postgres.** Une séquence ne revient jamais en
arrière : une transaction annulée y laisse un trou, ce que les factures
interdisent. Une séquence par centre, par type et par an demanderait en plus de
créer des objets à la volée.

**Pourquoi pas `max(numéro) + 1` dans le code.** Deux émissions simultanées
lisent le même maximum et produisent un doublon. Le verrou de ligne règle cela
sans verrou applicatif.

**Pourquoi des préfixes fixes.** Chaque centre a ses propres séries : le
préfixe n'a pas à porter le centre. Un préfixe configurable par centre reste
possible le jour où un centre le demandera.

## Conséquences

- Les numérotations d'un même type se font l'une après l'autre dans un centre.
  C'est sans effet au volume d'un centre, à condition que la transaction qui
  numérote reste courte : aucun appel externe entre la prise du numéro et la
  validation. Par exemple, n'attendre la plateforme agréée qu'après.
- Changer le format ou un préfixe demande une migration (les fonctions) et un
  nouvel ADR.
- Les tests qui vérifient un numéro exact vident `document_sequences`. La table
  n'est pas atteinte par le `TRUNCATE … CASCADE` des clients et des contrats.
- `document_sequences.tenant_id` est en `ON DELETE CASCADE`, par exception :
  un compteur n'existe pas hors de son centre. Les centres ne sont jamais
  supprimés en production, mais les bases de test en créent et en effacent.

## Alternatives écartées

**Une seule série continue, sans remise à zéro.** Elle est conforme aussi, mais
le numéro ne dit plus l'année. Il grossit sans fin, et l'usage des cabinets
comptables est la série annuelle.

**Numéroter les contrats à l'activation.** Le brouillon aurait besoin d'une
référence provisoire, et l'équipe parle d'un contrat dès la négociation. Pour
un contrat, un numéro pris par un brouillon archivé ne pose aucun problème : la
continuité légale ne vise que les factures.

**Une numérotation dans le code avec un verrou consultatif.** La garantie
dépendrait de chaque appelant, et le compteur resterait modifiable par
l'application.
