# ADR 009 — Catalogue réel du centre et unité « demi-journée »

**Date** : 2026-09-18
**Statut** : accepté — durée de la demi-journée devenue un paramètre du centre
(ADR 023) ; options facturées modélisables en services (ADR 024) ; unité
retenue par le devis quand la grille en propose plusieurs : ADR 023 (mise en
œuvre)

## Contexte

Jusqu'ici le produit se construisait sur un parc imaginé : trois salles, deux
bureaux, un véhicule, un casier. Le catalogue réel du centre a été relevé sur le
site public. Il diffère du jeu fictif sur des points qui touchent le modèle, pas
seulement les données :

- Deux salles de réunion, vendues **90 € HT la demi-journée et 130 € HT la
  journée**.
- Neuf bureaux, dont une offre FlexOffice facturée **au poste et à la
  demi-journée**, à partir de 7 € HT.
- Une quarantaine de boîtes aux lettres de domiciliation, à partir de 30 € HT
  par mois.
- Ouverture du lundi au samedi, 8h–22h — pas le 9h–18h du lundi au vendredi posé
  par défaut à la migration 0011.
- Des options facturées qui ne sont pas des ressources : écran tactile,
  purificateur d'air, petit-déjeuner, collation.

Ni véhicule ni casier au catalogue.

## Décision

### La demi-journée est une unité de facturation à part entière

`rate_unit` gagne la valeur `half_day`, entre `hour` et `day`.

Elle ne se déduit d'aucune autre : le centre vend la demi-journée 90 € et la
journée 130 €, pas 180 €. Une unité qu'un calcul ne reconstitue pas doit exister
en base, sinon le prix juste devient une exception dans le code.

### Une demi-journée vaut quatre heures

`MINUTES_PER_HALF_DAY` dans `tarifs.ts`. L'amplitude d'ouverture est de quatorze
heures, mais une demi-journée n'en est pas la moitié : c'est le créneau vendu,
matin ou après-midi. Quatre heures est l'usage des centres d'affaires.

C'est une convention de gestion, du même rang que l'unité entamée de l'ADR 006,
et elle demande la même confirmation métier. Elle est nommée une fois pour se
changer à un seul endroit.

Conséquence assumée : une réservation de 9h à 18h facturée à la demi-journée
coûte trois demi-journées. Choisir l'unité reste le travail de la grille — une
ressource vendue à la journée porte une ligne `day`, qui l'emporte parce que le
centre la désigne, pas parce qu'un calcul l'aurait devinée.

### Une ressource = une chose réservable seule

Un bureau à deux postes loué poste par poste est **deux ressources**, pas une.

Ce n'est pas un choix esthétique. `bookings_no_overlap` interdit deux
réservations qui se chevauchent sur un même `resource_id` : un bureau partagé
déclaré comme une seule ressource verrait sa deuxième réservation rejetée par la
base, sans recours applicatif — et c'est précisément ce qu'on attend de cette
contrainte (décision 3 du `CLAUDE.md`).

`infra/catalogue.mjs` porte la règle : un bureau marqué `flex` est développé en
une ressource par poste. Les neuf bureaux y sont déclarés entiers par défaut,
faute de connaître la répartition réelle ; basculer un bureau en flex est une
ligne à changer.

### Le catalogue réel ne vit pas dans le jeu de démonstration

Deux scripts, deux usages. `seed-demo.mjs` pose des données fictives pour le
développement local. `infra/catalogue.mjs` pose la configuration du centre :
parc, horaires, grille publique. Il est idempotent, ne supprime aucune
ressource, et s'exécute sous le rôle applicatif donc sous les politiques
d'isolation par centre.

Mélanger les deux ferait d'une relance du jeu de démonstration une perte de
configuration.

### Les options facturées ne sont pas encore modélisables

`rate_plan_items.resource_type` est non nul : toute ligne de grille se rattache à
un type de ressource. Un écran tactile ou un plateau-repas n'en est pas un. Ces
options restent donc hors grille pour l'instant, et aucun prix n'a été inventé —
le site n'en publie aucun.

## Justification

**Ajouter une valeur d'énumération est une migration sans risque, la déduire est
un piège durable.** `ALTER TYPE ... ADD VALUE` s'applique en transaction sur
Postgres 12 et au-delà tant que la nouvelle valeur n'est pas utilisée dans la
même transaction, ce qui est le cas ici : la migration 0012 ne fait qu'ajouter
l'étiquette. À l'inverse, exprimer la demi-journée comme une demi-`day` aurait
posé un arrondi dans chaque écran qui affiche un prix.

**Les horaires sont remplacés en bloc, pas complétés.** Ajouter le samedi sans
retirer l'ancien jeu laisserait des plages contradictoires ; supprimer puis
réinsérer les lignes du centre entier rend le résultat lisible d'un coup d'œil.
`opening_hours` est de la configuration, pas une entité métier : la décision 6
ne s'y applique pas.

**Le catalogue est écrit par code, pas saisi à la main.** Quarante boîtes aux
lettres saisies une par une à l'écran, c'est quarante occasions de se tromper de
numéro, et rien à rejouer sur une base neuve.

## Alternatives écartées

**Un type de ressource `equipement` pour l'écran tactile et le purificateur**
: justifié seulement si le matériel est en quantité limitée et doit avoir son
propre calendrier — un seul écran pour deux salles se réserve. L'information
manque. Tant qu'elle manque, un nouveau type d'énumération serait une décision
prise à l'aveugle ; une option facturée sans calendrier relève plutôt d'une ligne
de prestation, qui n'existe pas encore.

**Déclarer les neuf bureaux en postes tout de suite** : ferait apparaître au
planning des postes qui ne se louent pas séparément, et découperait un bureau
fermé en lignes qui n'ont pas de sens pour le staff.

**Reprendre le catalogue depuis SimplyBook** : l'outil actuel de réservation.
Une reprise automatisée coûterait plus que la saisie de cinquante lignes, et le
produit a vocation à le remplacer, pas à s'y adosser.

## Conséquences

Positives : les prix affichés par le centre sont exprimables tels quels, sans
arrondi ni ligne de code particulière. La règle « une ressource = une chose
réservable seule » est écrite avant que le flex office n'arrive, donc avant
qu'une réservation rejetée ne la fasse découvrir en production.

Négatives : la durée de la demi-journée est un pari, comme le prorata et l'unité
entamée. La changer après des facturations demandera une reprise.

**Reste à faire** :

- **Les carnets de réservations prépayés** (1, 5, 10, 20, 40, 50 ou 100
  réservations, valables un an) ne sont couverts par aucun des six domaines. Ce
  n'est ni un contrat récurrent ni une facture à l'acte, mais un solde de crédits
  décrémenté à chaque réservation. À cadrer avant la tranche 3.
- **Les options facturées**, voir ci-dessus.
- **Postes et superficies des bureaux**, absents du site, à relever sur le plan
  du centre. `infra/catalogue.mjs` les laisse vides plutôt que de les inventer.
- **Le nombre exact de boîtes aux lettres** : le site annonce « une quarantaine »,
  le script en pose quarante.
- **La TVA**, déjà signalée par l'ADR 006 : tous ces montants sont hors taxes.
