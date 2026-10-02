# ADR 023 — Tarification paramétrable, remises, engagement et devis figé

**Date** : 2026-10-01
**Statut** : accepté — amende l'ADR 006 (prorata et unité entamée deviennent
des paramètres du centre) et l'ADR 009 (durée de la demi-journée, choix de
l'unité d'une réservation) ; mise en œuvre du moteur de devis, de
l'échéancier et de la configuration ajoutée ; reconduction tacite mise en
œuvre par l'ADR 033

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
l'engagement est figé comme le prix (ADR 025). *(Mise en œuvre par l'ADR 033 :
la tâche nocturne inscrit la reconduction dès le dernier jour de préavis
passé.)*

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

## Mise en œuvre — moteur de devis, échéancier, configuration (vague 2)

Ajoutée avec la tranche « tarifs » (R08, R10, R11). Elle précise comment les
décisions ci-dessus s'appliquent ; les choix nouveaux sont marqués **à
valider**.

### Un seul moteur de devis

`quote(ressource, créneau, client facultatif, contrat facultatif, remise
facultative)` (`facturation/devis-queries.ts`) lit en base les règles du
centre, la ressource et les grilles candidates, et confie le calcul à
`quoteBooking()` (`facturation/devis.ts`, pur, testé). Il rend l'unité, la
quantité, le prix unitaire HT, la remise, le montant HT, la TVA et le TTC.

- **Back-office** : le formulaire de réservation annonce le devis avant
  l'envoi (`previewBookingQuoteAction`) ; `createBooking` le recalcule et le
  fige dans la transaction qui insère. Le montant affiché n'est qu'une
  annonce : celui de la base fait foi.
- **Page publique** : le montant HT, la TVA et le TTC du créneau s'affichent
  avant la demande (`loadPublicQuoteAction`), et `createBookingRequest` les
  fige sur la demande en attente. La facture reprendra le prix annoncé.
- `billableQuantity` lit les règles du centre ; `priceCents` et
  `MINUTES_PER_HALF_DAY` disparaissent, remplacés par le devis.

### Quelle grille

1. Les contrats **en cours ce jour-là** du client (actifs, ou résiliés dont le
   dernier jour n'est pas passé, non archivés) qui désignent une grille : le
   contrat rattaché à la réservation d'abord, puis le plus récent.
2. La grille par défaut du centre.

La première qui est **en vigueur le jour du début de la réservation** (jour du
centre) et qui **tarife la ressource** à une unité de durée l'emporte. Une
grille archivée, ou hors de ses dates de validité, ne tarife rien
(`resolveRate`, `findDefaultRatePlan`, `findApplicableRate` et le devis
l'ignorent). Sans grille, le créneau n'est pas chiffré, et l'écran le dit.

### Quelle unité — **à valider**

Parmi l'heure, la demi-journée, la journée et la semaine que la grille propose
pour la ressource (le tarif nominatif primant sur celui du type), le devis
retient **celle qui donne le montant le plus bas** pour le créneau ; à montant
égal, la plus large. Avec la grille réelle (90 € la demi-journée, 130 € la
journée), une réunion de quatre heures coûte une demi-journée, une de cinq ou
neuf heures une journée. Cela précise l'ADR 009, qui laissait « le choix de
l'unité à la grille » sans dire lequel retenir quand elle en propose
plusieurs. Le mois et le forfait ne chiffrent pas une réservation : ce sont
des tarifs de contrat et de prestation.

### Quelle durée — **à valider**

La durée se compte en **heure murale du centre** : une réservation du samedi
0 h au mardi 0 h vaut trois jours, même si la nuit du changement d'heure en
compte 23 ou 25. La tolérance de l'unité entamée s'applique à toutes les
unités de durée (une journée de 24 h 10 avec 15 minutes de tolérance vaut une
journée).

### TVA, remise, réservation interne

- TVA au taux par défaut du centre (`default_vat_rate_bp`) : les lignes de
  grille n'ont pas de taux propre.
- Remise saisie par l'équipe au back-office, en pourcentage ou en euros ; une
  remise plus grande que le montant est refusée. La page publique n'en accorde
  aucune.
- « Usage interne » : la réservation est écrite sans devis. Un créneau que la
  grille ne tarife pas aussi, après l'avoir annoncé. Les séries posées en
  masse restent non chiffrées.
- **Déplacer une réservation refait son devis** (autres heures, autre
  ressource : autre prix), remise gardée — elle tombe si elle dépasse le
  nouveau montant. Un prix saisi à la main (sans ligne de grille) n'est jamais
  recalculé. Changer le client d'une réservation ne change pas son prix
  annoncé. **À valider.**

### Échéancier

`contractSchedule(contrat, versions, jusqu'au, règle)` (`contrats/echeancier.ts`,
une seule implémentation depuis l'intégration de la vague 2) lit la règle de
prorata du centre et les versions de prix (`contract_price_versions`, ADR 025,
lues par `selectPriceVersions`), lignes et remises comprises. Chaque période
est coupée en morceaux aux dates d'effet ; chaque morceau porte sa fraction
(`prorataFraction`), affichée à l'écran et reprise telle quelle sur la ligne de
facture par le lot de facturation.

- **Base 30** : chaque mois compte 30 jours ; le dernier jour du mois compte
  comme le 30, donc du 1er au 30 mars vaut un mois entier. Un morceau qui
  commence le 31 ne compte rien, pour que les morceaux d'un même mois coupé
  par un avenant s'additionnent toujours à 30 (règle retenue à l'intégration,
  ADR 028). **À valider.**
- **Sans prorata** et avenant en cours de période : la période est due en
  entier au prix de la version en vigueur à son premier jour, l'avenant
  s'applique à la période suivante. **À valider.**
- Une ligne ponctuelle (frais de dossier) est due une fois, dans la période qui
  contient le premier jour de sa version.
- **Engagement** : la fiche du contrat affiche la fin d'engagement et le
  minimum dû sur sa durée (`commitmentSchedule`) ; l'horizon de l'échéancier
  va au moins jusqu'à elle. La résiliation propose le premier dernier jour qui
  respecte préavis et engagement (`earliestEndOn`, jumeau de
  `contract_earliest_end_on`) et signale une date antérieure, sans la refuser.

### Écran de configuration

`/configuration`, réservé à l'exploitant (`centre.configurer`) : règles
tarifaires, facturation (échéance, à échoir ou échu, TVA sur les débits,
mentions), identité légale et coordonnées bancaires du vendeur. Les
identifiants sont contrôlés avant l'écriture : SIREN et SIRET (clé de Luhn, La
Poste comprise), TVA intracommunautaire française (clé et SIREN), IBAN (modulo
97), identifiant créancier SEPA (clé). L'écran dit ce qui manque encore pour
émettre une facture (`missingInvoiceRequirements`, comme `issue_invoice`).

### Jeu de cas tarifaires figé

`facturation/cas-tarifaires.ts`, rejoué par `cas-tarifaires.test.ts` : la
grille réelle du centre, et des cas demi-journée, journée, heure, semaine,
mois, prorata (jours réels, base 30, sans), remises (ligne et devis),
engagement, avenant, chacun avec son montant attendu au centime. **Statut : à
valider par l'exploitation.** Le centre ne publie ni prix à l'heure ni prix à
la semaine : deux prix hypothétiques (25 € l'heure de salle, 150 € la semaine
de poste) éprouvent ces unités, à remplacer ou à retirer.

### Limites connues

- Une seule grille par défaut à la fois (index `rate_plans_tenant_default_key`)
  : la grille de l'année suivante ne peut pas être préparée comme grille par
  défaut aux dates qui suivent ; il faut basculer le drapeau le jour venu.
- Les lignes de grille n'ont pas de taux de TVA : toutes les réservations
  prennent le taux par défaut du centre.
