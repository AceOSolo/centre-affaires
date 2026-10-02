# ADR 032 — Correctifs de la facturation : avenants déjà facturés, avoirs au centime, forfaits sans prorata, motif d'exonération

**Date** : 2026-10-02
**Statut** : accepté — corrige une conséquence de l'ADR 029 et précise les
ADR 026 et 030 ; les choix marqués « à valider » attendent le centre ou
l'expert-comptable

## Contexte

La revue de la vague 2 a trouvé quatre défauts dans la facturation, chacun
reproduit sur le module pur ou en base :

1. **Un avenant signé après la facturation de sa période la fait facturer une
   seconde fois.** Le lot (`lot.ts`) ne retirait d'un morceau de période que
   les jours déjà facturés sous **la même clé** (contrat et ligne de contrat).
   Les lignes d'une nouvelle version ont d'autres clés : un contrat
   trimestriel à échoir dont le premier trimestre est facturé en janvier, puis
   modifié par un avenant à effet du 1er mars signé en février, se voyait
   proposer en mars la nouvelle ligne du 1er au 31 mars, en plus du trimestre
   déjà facturé. La base ne l'empêchait pas : la contrainte d'exclusion porte
   sur la clé, et la signature ne regardait pas ce qui était facturé. L'ADR 029
   affirmait le contraire (« un avenant signé après la facturation de sa
   période ne refacture rien »).
2. **Des avoirs successifs ne retombent pas sur le TTC de leur facture.** La
   TVA de chaque avoir se calculait sur ses seules bases. Facture de deux
   lignes de 33,33 € HT à 20 % : 79,99 € TTC ; un avoir par ligne : 40,00 €
   chacun, 80,00 € au total — le second était refusé comme excédentaire, et la
   facture ne pouvait plus être annulée. Ligne de 100,03 € créditée de 50,01 €
   puis du reliquat : 120,03 € crédités pour 120,04 € TTC, facture restée
   « émise » avec 0,01 € dû.
3. **Sans prorata, un forfait souscrit dont les conditions changent en cours
   de mois est facturé deux mois pleins.** Le changement coupe la souscription
   la veille de la date d'effet (ADR 024) ; le lot facturait chaque morceau
   comme un mois entamé, donc dû en entier. Le correctif fait pour les contrats
   à l'intégration n'avait pas été porté aux souscriptions.
4. **Une facture s'émettait sans le motif d'une exonération.** Le lot classe un
   taux nul en exonération (`E`) ; `issue_invoice()` n'exigeait pas le motif
   (EN 16931, BT-120), mention obligatoire, et la facture se figeait sans lui.

## Décision

### Un avenant de prix ne prend pas effet sur une période déjà facturée

`contract_billed_through(contrat)` rend le dernier jour que tient une facture,
émise ou brouillon : loyers et lignes du contrat (hors forfaits souscrits), ni
retirés d'un brouillon ni libérés par un avoir. La signature d'un avenant qui
change le prix (un montant ou des lignes) est refusée (`CA005`) si sa date
d'effet tombe ce jour-là ou avant. Le message dit jusqu'où le contrat est
facturé, la première date possible, et le chemin : un avoir, ou la ligne
retirée du brouillon. Un avenant de **ressource seule** reste permis : il ne
change pas ce qui est dû.

L'écran fait le même contrôle avant la base (`billedPeriodRefusal`,
`readAmendmentForm`), comme celui d'un changement de conditions d'une
souscription (`planConditionChange`) : la date d'effet proposée suit le
dernier jour facturé, l'aide du champ le rappelle, et la page d'un avenant
brouillon dit qu'il ne pourra pas être signé à sa date.

### Une version ne refacture jamais ce qu'une autre a facturé

Deux garde-fous, en plus du refus à la signature :

- **Le lot** (`takenFor`, `lot.ts`) retire d'un morceau de la version V les
  jours facturés sous sa propre clé **et tous ceux qu'une autre version du
  contrat a facturés**, quelle que soit leur clé. Deux lignes d'une même
  version restent indépendantes : un avoir qui ne crédite que l'une la rend
  seule facturable à nouveau.
- **La base** (`invoice_lines_guard`, migration 0032) refuse (`CA003`) un
  loyer ou un forfait de contrat qui recouvre un jour tenu par une ligne
  vivante d'une autre version. Elle verrouille le contrat en partage pendant
  l'écriture : la signature d'un avenant, qui le verrouille en écriture,
  attend la facturation en cours, et la ligne voit les avenants signés avant
  elle. Ce contrôle ne devrait plus jamais se déclencher ; il tient l'invariant
  pour un état antérieur à cette migration, ou pour un chemin d'écriture à
  venir.

Un loyer global (sans ligne de contrat) se facture quand sa version n'a aucune
ligne **récurrente** : ses lignes ponctuelles (frais de dossier) ne le
remplacent plus. Auparavant, la base refusait ce loyer et le lot le renvoyait
à la main.

### Un avoir qui solde une ligne en crédite exactement la TVA restante

Dans un avoir, une ligne qui **solde** sa ligne d'origine — le net crédité,
avoirs émis compris, égale son net, au même taux et dans la même catégorie —
porte la TVA de la ligne d'origine moins celle que les avoirs émis ont déjà
créditée (`invoice_refresh_amounts`, migration 0032). Les autres lignes de
l'avoir suivent la règle commune : TVA par taux sur la somme des bases (ADR
026).

Une ligne entièrement créditée l'est donc aussi en TVA, et une facture dont
toutes les lignes sont soldées a reçu exactement son TTC : elle passe
« annulée ». La TVA reversée est celle qui a été facturée, au centime.

Contrepartie : la TVA d'un avoir partiel peut s'écarter d'un centime par
ligne de base × taux (BR-CO-17), puisqu'elle a été arrondie sur la facture
d'origine. Le contrôle EN 16931 (`checkEn16931`) le tolère sur un avoir, pas
sur une facture. **À valider par l'expert-comptable et par la plateforme
agréée** une fois choisie (ADR 016) : les règles de validation de la norme
admettent un écart d'arrondi sur ce terme, il faut confirmer que la
plateforme fait de même.

### Sans prorata, un mois de forfait n'est dû qu'une fois par chaîne

Une **chaîne** de souscriptions : celles d'un même client, au même service,
pour le même contrat (ou sans contrat). La contrainte
`subscribed_services_no_overlap` interdit qu'elles se recouvrent ; un
changement de conditions en ajoute une à la chaîne. Sous la règle « aucun
prorata », un mois entamé est dû une fois par chaîne, au prix de la
souscription en vigueur sur son premier jour couvert ; celle qui prend la
suite en cours de mois compte à partir du mois suivant — la règle des
versions d'un contrat. Sous les autres règles, chaque souscription reste due
pour ses jours.

### Le motif d'exonération est une mention obligatoire de l'émission

`issue_invoice()` refuse (`CA003`) une facture ou un avoir dont une ligne
vivante d'une catégorie qui appelle un motif — `E`, `AE`, `K`, `G`, `O` — n'en
porte pas (BR-E-10 et suivantes). Pas au taux normal `S` ni au taux zéro `Z`,
qui n'en portent pas (BR-S-10, BR-Z-10). La fiche d'un brouillon le dit avant
l'émission (`missingForIssue`), en nommant les lignes ; le motif se saisit sur
la ligne. Le lot ne l'invente pas : c'est un texte de droit propre à chaque
exonération.

### Et un type

Le bilan d'un lot (`InvoiceRunResult`, `invoice_runs.result`) déclare les
brouillons complétés et les lignes écrites, que l'écran lisait déjà.

## Justification

**Refuser à la signature plutôt que corriger après.** Une facture émise ne
change plus (ADR 026) : une période facturée à l'ancien prix ne se refacture
pas au nouveau. Le seul chemin propre est l'avoir, puis l'avenant ; le refus
le dit au moment où on peut encore choisir une autre date. C'est déjà la règle
des souscriptions.

**Trois niveaux pour une même règle.** L'écran pour le message, la signature
pour l'état normal, la garde des lignes pour l'invariant. La contrainte
d'exclusion ne peut pas porter sur « la version » d'une ligne, qui n'est pas
une colonne.

**Créditer la TVA de la ligne, pas la recalculer.** Recalculée sur chaque
avoir, la TVA reversée diffère de la TVA facturée dès que deux arrondis se
cumulent : le client devrait 0,01 €, ou l'avoir serait refusé. Reverser
exactement ce qui a été facturé est la règle comptable ; l'écart d'un centime
sur la ventilation d'un avoir partiel en est le prix.

## Alternatives écartées

**Retirer de chaque morceau tous les jours facturés du contrat, toutes clés
confondues** : une ligne retirée d'un brouillon, ou créditée seule, ne
reviendrait jamais tant qu'une autre ligne de la même version tient le mois.

**Reporter l'écart de TVA sur le dernier avoir, celui qui solde la facture**
(dans `issue_invoice`) : le total retombe juste, mais l'écart va à la ligne la
plus forte, quel que soit son taux ; une facture à deux taux reverserait trop
de TVA à l'un et pas assez à l'autre.

**Remettre à zéro le montant d'une version quand sa dernière ligne récurrente
est retirée** (manque relevé à l'intégration) : écarté. Le montant reste
visible et modifiable sur le brouillon dès qu'il n'a plus de ligne récurrente,
et une remise à zéro silencieuse ferait sortir le contrat du lot sans un mot.

## Conséquences

- Migration 0032 : `contract_billed_through()`, et nouvelles versions de
  `contract_amendment_assert_signable()`, `invoice_lines_guard()`,
  `invoice_refresh_amounts()`, `issue_invoice()`.
- L'ADR 029 est corrigé sur deux points : un avenant de prix ne se signe plus
  sur une période facturée (la phrase « ne refacture rien » devient vraie), et
  une version à frais ponctuels et à montant se facture par le lot.
- Pour revenir sur un prix déjà facturé : avoir sur la période, puis avenant.
- Un brouillon issu d'un taux nul attend son motif avant l'émission.
- **À valider par l'expert-comptable** : la TVA exacte des lignes soldées par
  avoir et sa tolérance d'un centime par ligne sur la ventilation d'un avoir
  partiel ; le motif exigé pour les catégories `E`, `AE`, `K`, `G`, `O`.
- **À valider par le centre** : sous la règle « aucun prorata », le mois d'un
  changement de conditions facturé au prix de la souscription en vigueur sur
  son premier jour.
