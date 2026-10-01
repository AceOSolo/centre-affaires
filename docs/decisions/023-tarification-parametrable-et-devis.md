# ADR 023 — Tarification paramétrable, remises, engagement et devis figé

**Date** : 2026-10-01
**Statut** : accepté — amende l'ADR 006 (prorata et unité entamée deviennent
des paramètres du centre) et l'ADR 009 (durée de la demi-journée)

## Contexte

Le cahier des charges demande des tarifs à la journée, à la semaine et au mois
(R08), des remises, un engagement et un prorata **paramétrables** (R10), et un
moteur tarifaire unique dont le prix ne se redemande pas à la facture (R11).

Ce qui existait :

- `rate_unit` connaît l'heure, la demi-journée, la journée, le mois et le
  forfait ; pas la semaine ;
- le prorata (jours réels, ADR 006), l'unité entamée (ADR 006) et la
  demi-journée de quatre heures (ADR 009) sont des conventions **codées** dans
  `echeancier.ts` et `tarifs.ts` ;
- aucune remise, aucun engagement, aucune reconduction ;
- `priceCents()` n'est appelé par aucun écran : une réservation ne porte aucun
  prix, et la facture devrait le recalculer avec la grille du jour, pas celle
  du jour de la réservation.

L'ADR 016 (décision D5) a tranché : des paramètres par centre, en base.

## Décision

### La semaine est une unité à part entière

`rate_unit` gagne `week`, entre `day` et `month` (migration 0030). Comme la
demi-journée (ADR 009), elle ne se déduit d'aucune autre : une semaine se vend
moins de sept journées. Une semaine entamée est due (`billableQuantity`).

Les dates de validité des grilles (`rate_plans.valid_from`, `valid_to`) restent
où elles sont ; les appliquer est du code (le moteur de devis).

### Les règles tarifaires sont des colonnes du centre

| Colonne de `tenants` | Défaut | Ce qu'elle règle |
|---|---|---|
| `prorata_rule` | `calendar_days` | Prorata d'une période partielle, voir plus bas |
| `started_unit_tolerance_minutes` | 0 | Tolérance avant qu'une unité entamée soit due (0 à 59) |
| `half_day_minutes` | 240 | Durée d'une demi-journée vendue (60 à 720) |
| `default_vat_rate_bp` | 2000 | Taux de TVA par défaut, en points de base (20 %) |

Les paramètres de facturation (échéance, mentions, moment de facturation) sont
dans l'ADR 026, ceux du règlement et de la comptabilité dans l'ADR 027. Les
valeurs par défaut reprennent les conventions des ADR 006 et 009 : rien ne
change pour le centre tant qu'il ne les modifie pas. **Toutes sont à valider
par le centre.** Elles se règlent par `centre.configurer`.

**Prorata** (`prorata_rule`), pour les loyers et les forfaits par période :

- `calendar_days` : jours couverts sur jours réels de la période civile, bornes
  comprises (ADR 006). Du 10 au 31 mars : 22/31 ;
- `thirty_day_month` : base 30, convention 30/360. Chaque mois compte 30 jours,
  le 31 n'existe pas et le dernier jour d'un mois compte comme le 30 (fin
  février comprise). Numérateur : somme, par mois, des jours couverts ainsi
  comptés ; dénominateur : 30, 90 ou 360 selon la période. Du 10 au 31 mars :
  21/30 ;
- `none` : pas de prorata, une période entamée est due en entier.

Le prorata est porté sur la ligne de facture (`prorata_numerator`,
`prorata_denominator`), jamais appliqué en amont au prix : la facture dit
d'où vient le montant. Un acte et une réservation ne se proratisent jamais.

**Unité entamée** : quantité due = `max(1, ⌈(durée − tolérance) / durée de
l'unité⌉)`, l'unité valant 60 min (heure), `half_day_minutes` (demi-journée),
24 h (journée), 7 × 24 h (semaine). Avec la tolérance par défaut de 0, c'est la
règle de l'ADR 006 : une réunion d'une heure dix coûte deux heures.

### Une seule règle d'arrondi, en base

`line_net_amount_cents(quantité, prix, remise_pb, remise_centimes,
prorata_num, prorata_dén)` (migration 0029) :

```
(quantité × prix − remise en centimes) × (10000 − remise en points) / 10000
× prorata_num / prorata_dén
```

arrondi **une seule fois**, au centime le plus proche, la moitié s'éloignant de
zéro. Une remise en montant est due par période entière, comme le prix : une
période partielle les proratise ensemble.

Elle calcule, en colonnes générées, le net des lignes de contrat, des
souscriptions, des lignes de facture et du devis d'une réservation. Le devis,
le contrat et la facture tombent donc au même centime. `vat_amount_cents(base,
taux)` arrondit la TVA de la même façon.

`src/modules/facturation/montants.ts` en est le jumeau TypeScript, pour
annoncer un montant à l'écran avant l'écriture ; `montants.db.test.ts`
l'éprouve contre la base sur 1 400 cas (moitiés exactes, négatifs, prorata,
remises).

### Les remises : un pourcentage ou un montant, jamais les deux

Partout où une remise se pose — ligne d'offre, ligne de contrat, souscription,
ligne de facture, devis d'une réservation — elle prend l'une de deux formes :

- `discount_bp` : points de base, 1000 = 10 % ;
- `discount_amount_cents` : centimes par période.

Une contrainte refuse les deux à la fois. Une remise ne rend jamais négative
une ligne de contrat ou une souscription : ce serait un avoir déguisé. Une
remise portée en ligne de facture (geste commercial, remise d'offre) est une
ligne de nature `discount`, à prix unitaire négatif.

### L'engagement et la reconduction sont des données du contrat

| Colonne de `contracts` | Sens |
|---|---|
| `commitment_months` | Durée d'engagement, 1 à 120 mois ; nulle : sans engagement |
| `commitment_ends_on` | Calculée par la base : de date à date, premier jour + durée − 1 jour |
| `tacit_renewal`, `renewal_months` | Reconduction tacite au terme, par périodes de N mois |
| `notice_days` | Préavis, déjà présent (ADR 006) |

`contract_earliest_end_on(contrat, jour du préavis)` rend le dernier jour
possible si le préavis est donné ce jour-là : le plus tardif du terme du
préavis (jour de la demande compris, comme `noticeEndsOn`) et de la fin
d'engagement. La base ne refuse pas une résiliation anticipée : c'est un
accord entre le centre et son client, que l'écran doit signaler.

La reconduction tacite est une règle, pas une tâche : au terme, le code
prolonge `ends_on` de `renewal_months` faute de préavis. Hors brouillon,
l'engagement est figé comme le prix (ADR 025).

### Le devis d'une réservation est figé sur elle

Colonnes `quote_*` de `bookings` : unité, quantité, prix unitaire HT, remise,
taux de TVA, devise, ligne de grille appliquée (`quote_rate_plan_item_id`,
nulle pour un prix saisi), date du devis (`quoted_at`), et le montant HT
`quote_amount_cents`, **calculé par la base** par la règle commune.

Des contraintes tiennent le devis complet ou absent, cohérent, et réservé aux
réservations : nul pour une indisponibilité, une occupation de contrat, ou une
réservation non chiffrée (les réservations antérieures à la vague 2, les
réservations internes). La facture reprend ce devis ; elle ne relit pas la
grille.

## Justification

**Des colonnes de `tenants` plutôt qu'une table de paramètres.** Chaque centre
a ses valeurs dès sa création, sans ligne à créer ni jointure à oublier. C'est
déjà là que vivent les délais de réservation et les durées de conservation.

**Une règle d'arrondi en base plutôt que dans le code.** Le montant d'une ligne
est écrit par plusieurs chemins : le portail, le back-office, le lot de
facturation, demain un import. Une colonne générée ne peut pas diverger de la
règle ; un calcul dans chaque écran le peut. Le jumeau TypeScript ne fait
qu'annoncer, et un test le tient aligné.

**Un seul arrondi.** Arrondir le prorata, puis la remise, puis le total produit
des écarts d'un centime selon l'ordre des opérations. La formule unique rend le
montant exact à la fraction près, puis arrondit.

**Des quantités entières, le prorata à part.** EN 16931 admet une quantité
décimale, mais « 0,548387 mois » n'est ni lisible ni exact. Quantité entière et
fraction de prorata explicite donnent un montant exact et une ligne lisible.

## Alternatives écartées

**Une table `tenant_settings` en JSONB** : aucune contrainte sur les valeurs,
et un paramètre mal orthographié passe inaperçu.

**Garder les conventions dans le code** : contraire à D5, et un second centre
ne pourrait pas facturer autrement.

**Des quantités décimales** (`numeric`) : les montants deviennent des produits
de décimaux, le pilote les rend en chaînes, et chaque écran doit arrondir.

**Recalculer le prix d'une réservation à la facturation** : la grille a pu
changer entre-temps, et le client paierait un autre prix que celui annoncé.

## Conséquences

- `billableQuantity` (`tarifs.ts`) connaît la semaine. Le moteur de devis
  (vague 2) doit lire `half_day_minutes` et `started_unit_tolerance_minutes`
  au lieu de `MINUTES_PER_HALF_DAY`, et appliquer les dates de validité des
  grilles.
- L'échéancier (`echeancier.ts`) doit lire `prorata_rule` ; `calendar_days`
  reste le comportement actuel.
- Changer la règle d'arrondi demande une nouvelle fonction, une migration des
  colonnes générées et un nouvel ADR.
- **À valider par le centre** : les quatre paramètres ci-dessus, le principe de
  la remise en montant proratisée avec le prix, la date à date de
  l'engagement.
