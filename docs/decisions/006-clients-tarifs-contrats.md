# ADR 006 — Clients, grilles tarifaires et contrats

**Date** : 2026-09-18
**Statut** : accepté

## Contexte

Tranche 2 du plan de construction : clients, grilles tarifaires, contrats. Trois
sujets qui se tiennent — un contrat lie un client à un montant récurrent, et
une grille fixe le prix des prestations qui sortent du forfait.

Le `CLAUDE.md` place la facturation hors du périmètre V1 mais demande les
grilles tarifaires dès maintenant, et exige un test pour toute règle de tarif ou
de prorata. Les tables doivent donc porter des montants justes sans qu'aucune
facture ne soit émise.

## Décision

### Les grilles vivent dans `facturation`, pas dans `contrats`

Deux domaines s'en servent : un contrat pour son loyer, une réservation pour le
prix d'une salle à l'heure. Les loger dans `contrats` ferait dépendre
`reservations` de son voisin, et inversement. `facturation` est le domaine de
l'argent et le consommateur naturel à la tranche 3.

### Un contrat porte son propre montant

`contracts.amount_cents` n'est pas une référence vers une ligne de grille. Le
contrat est un engagement signé : son montant ne doit pas bouger parce que le
centre a révisé ses tarifs. La grille désignée par un contrat ne sert qu'aux
prestations hors forfait.

Conséquence : archiver une grille ne change aucun contrat en cours.

### Dates de calendrier en `date`, pas en `timestamptz`

La décision 4 du `CLAUDE.md` vise les instants : un créneau de réservation
existe à la seconde près, et son fuseau compte. Un contrat court « du 1er mars
au 28 février » — une borne de calendrier, la même à Paris et à Singapour. La
stocker en instant obligerait à choisir un minuit, et ce minuit se déplacerait
d'un fuseau à l'autre.

Les deux règles coexistent donc : `timestamptz` pour ce qui arrive à un moment,
`date` pour ce qui vaut pour une journée entière.

### Périodes de facturation alignées sur le calendrier, prorata au jour

Un contrat mensuel est facturé par mois civil, pas par mois anniversaire. Un
contrat qui commence le 10 mars donne une première période du 10 au 31 mars,
due au prorata des jours couverts, bornes comprises. Idem par trimestre et par
année civils.

### Toute unité entamée est due

Une réunion d'une heure et dix minutes coûte deux heures. Une journée entamée
est une journée due.

### L'échéancier est calculé, jamais stocké

`billingSchedule()` lit le contrat et rend les périodes dues. Tant qu'aucune
facture n'est émise, l'échéancier n'est qu'une vue : le figer en base créerait
une seconde vérité à mettre à jour à chaque avenant.

### Rien n'est prérendu dans le back-office

`export const dynamic = 'force-dynamic'` sur la coque `(admin)`.

## Justification

**Le prorata et l'unité entamée sont des conventions de gestion, pas des
évidences.** Elles sont écrites en toutes lettres ici et couvertes par des
tests (`echeancier.test.ts`, `tarifs.test.ts`) pour qu'un désaccord se règle en
changeant une règle nommée, pas en cherchant une division dans un écran. Ce sont
les deux points de cet ADR qui demandent une confirmation métier.

**Montants en centimes de bout en bout.** La saisie se fait en euros et passe
par `parseAmountToCents()`, qui lit la chaîne plutôt que de multiplier par 100 —
`19.99 * 100` vaut `1998.9999999999998` en flottant. Le prorata arrondit au
centime le plus proche, et une période entière rend le montant exact sans passer
par une division.

**Une seule grille par défaut, tenue par un index partiel.** Deux grilles par
défaut rendraient le tarif appliqué dépendant de l'ordre de lecture. La règle
est en base, comme l'anti-double-réservation : une vérification applicative
céderait à la première création simultanée.

**Le tarif nominatif prime sur le tarif de type.** C'est ce qui permet de faire
payer la grande salle plus cher sans dupliquer toute la grille. L'unicité de
chaque niveau est tenue par deux index partiels, donc à précision égale il ne
peut pas y avoir deux candidats.

**Le back-office en rendu dynamique.** Sans cela, une page sans `searchParams` —
`/tarifs` en l'occurrence — est prérendue au build : elle interroge la base à la
compilation et sert ensuite un instantané. Les données d'administration changent
en dehors de l'application, et au multi-centres un instantané serait celui du
mauvais centre.

## Alternatives écartées

**Périodes anniversaires** (du 10 mars au 9 avril) : supprime le prorata, mais
décale chaque contrat par rapport au mois comptable et rend les relances
illisibles. Le prorata est le prix à payer pour que tous les contrats tombent
sur le même calendrier.

**Facturation à la minute** plutôt qu'à l'unité entamée : plus juste pour le
client, mais ce n'est pas l'usage des centres d'affaires, et cela retire toute
incitation à libérer une salle à l'heure.

**Un module `tarifs` dédié** : la liste des six domaines du `CLAUDE.md` est
fixe, en ajouter un septième pour trois tables serait une entorse plus coûteuse
que le rattachement à `facturation`.

**Stocker l'échéancier** : nécessaire à la tranche 3, quand une facture émise
devient un fait immuable. Prématuré tant qu'il n'y a rien à figer.

## Conséquences

Positives : les montants sont justes et les règles de calcul sont nommées et
testées. Les tables de la tranche 3 s'appuieront sur un échéancier déjà éprouvé.
Le multi-centres est tenu de bout en bout — un test vérifie qu'aucune table
publique n'échappe à la RLS, ce qui piégera la prochaine table oubliée.

Négatives : les deux conventions de gestion ci-dessus sont des paris. Les
changer plus tard demandera une reprise des montants déjà facturés, donc autant
les confirmer avant la tranche 3.

Les tests de base partagent une base et se vident les tables entre eux : ils
tournent en série (`--test-concurrency=1`). Le coût est quelques secondes ; les
faire tourner en parallèle demanderait une base par suite.

**Reste à faire** : la TVA n'est nulle part. Les montants sont hors taxes et
`vat_number` est stocké sans être utilisé. Le taux et le calcul TTC relèvent de
la tranche 3, avec la réforme de la facturation électronique.
