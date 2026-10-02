# ADR 029 — Lot de facturation périodique et écrans de facturation

**Date** : 2026-10-01
**Statut** : accepté — précise l'ADR 026 ; les choix marqués « à valider »
attendent le centre ou l'expert-comptable ; deux conséquences corrigées par
l'ADR 032 (avenant signé après la facturation de sa période, loyer d'une
version à frais ponctuels)

## Contexte

L'ADR 026 pose le modèle des factures et ses garanties en base : une facture
naît brouillon, s'émet par `issue_invoice()`, ne change plus une fois émise, se
corrige par un avoir ; une source (contrat, souscription, réservation, pli)
n'est facturée qu'une fois ; la TVA se calcule par taux. Il laisse au code ce
que fait un lot de facturation (R13), comment une facture réunit location,
forfaits et actes (R15), comment les actes du courrier y remontent (R14), et
les écrans de l'équipe.

Ce que le code doit trancher :

- quelles échéances et quelles consommations un lot du mois facture ;
- ce qu'il fait quand on le rejoue, ou quand une partie est déjà facturée ;
- ce qu'il fait de ce qu'il ne sait pas valoriser ;
- comment l'équipe relit, corrige, émet et annule.

## Décision

### Les trois périodes d'un lot

Le lot du mois M (jours civils du centre) :

| Période | Contenu | Par défaut |
|---|---|---|
| Période de la facture (EN 16931, BG-14) | clé « une facture par client et par période » (`invoices_run_period_key`) | le mois M |
| Récurrent | loyers, lignes de contrat, forfaits souscrits | M à échoir (`in_advance`), M − 1 à terme échu (`in_arrears`) |
| Consommations | réservations commencées, plis ouverts | M − 1 |

La facture porte le mois M ; chaque ligne porte sa propre période ou son jour
(BG-26) : un loyer d'octobre et une réservation du 10 septembre se lisent sur la
même facture d'octobre. **À valider par le centre** (déjà annoncé par l'ADR 026).

### Ce qu'un lot facture, source par source (`lot.ts`)

**Contrats engagés** (en cours ou résiliés, non archivés), dans la devise du
centre. Chaque période civile du contrat (mois, trimestre, année) est coupée
aux dates d'effet de ses versions de prix (`contract_price_versions`, ADR 025).
Un morceau est facturé par le lot qui contient :

- son **premier jour** à échoir — le premier mois partiel d'un contrat qui
  commence le 10 octobre est facturé par le lot d'octobre ;
- son **dernier jour** à terme échu — un trimestre est facturé une fois écoulé.

Un trimestre ou une année se facture donc une seule fois, pas dans chaque lot
mensuel qu'il touche. Chaque morceau est facturé aux **lignes de sa version**
(une ligne de facture par ligne de contrat ; `package` si la ligne vise un
service, `rent` sinon), ou à son **montant** pour une version sans ligne, au
taux `contracts.vat_rate_bp`. Une période partielle porte son prorata sur la
ligne (`prorata_numerator`, `prorata_denominator`) selon la règle du centre
(ADR 023) ; la base calcule le montant en un seul arrondi. La fraction est
celle de l'échéancier du contrat (`prorataFraction`, `contrats/echeancier.ts`,
depuis l'intégration de la vague 2) : la facture tombe au centime de
l'échéancier affiché sur la fiche. Sans prorata (`none`), une période entamée
est due en entier au prix de la version en vigueur sur son premier jour, et un
avenant pris en cours de période compte à partir de la suivante. Une **ligne
ponctuelle** (frais de dossier) est facturée une fois, avec le morceau qui
commence au premier jour de sa version. Une souscription rattachée à un
contrat ne se facture qu'une fois ce contrat activé (ni brouillon, ni
archivé). La ressource d'un loyer global est
celle du segment en vigueur au début du morceau (`contract_segments`), pour le
revenu par ressource (R31).

**Forfaits souscrits** (`subscribed_services` d'un service `package`), au prix
figé de la souscription : au mois, comme un contrat mensuel, au prorata des
jours souscrits ; à la prestation (`unit`), une fois, dans le lot qui contient
son premier jour. Les autres unités (heure, demi-journée, jour, semaine) ne se
facturent pas par un lot : elles sont signalées.

**Réservations** (`kind = 'booking'`, confirmées, d'un client, commencées dans
la période des consommations) : à leur **devis figé** (R11), jamais au prix du
jour. Une réservation sans devis — antérieure à la vague 2, ou interne — est
signalée, pas facturée.

**Actes du courrier** (R14, ADR 024) : chaque pli ouvert dans la période des
consommations, non retiré, devient une ligne `act` du service de code
`courrier.ouverture`, valorisée par la règle unique des actes (`priceActs`,
ADR 024, partagée avec la fiche client). La souscription du client en vigueur
le jour de l'ouverture inclut ses `included_quantity` premiers actes de la
période, par ordre d'ouverture : ils figurent à 0 €, avec la mention
« inclus » ; les suivants sont dus au prix de la souscription, remise comprise
(une remise en montant, que la saisie refuse sur un acte, se compte par acte et
ne dépasse pas son prix). Deux souscriptions en vigueur le même jour : la plus
avantageuse pour le client (ADR 024). Sans souscription, le prix du
catalogue. Le rang d'un acte se compte sur **tous** les plis de la
période, déjà facturés compris : rejouer le lot ne déplace pas les inclus.
Sans service vivant de ce code, rien n'est valorisé et chaque client concerné
est signalé — le lot ne facture jamais zéro par défaut.

Une facture réunit, dans cet ordre : loyers et lignes des contrats, forfaits
souscrits, réservations, actes (R15).

### Ce qui est déjà facturé n'est pas reproposé

Le lot lit les lignes qui tiennent déjà une source (ni retirées, ni libérées
par un avoir) et ne propose que ce qui reste : les jours non facturés d'une
période (un mois facturé jusqu'au 15 laisse du 16 au 31, au prorata), les
réservations et les plis sans ligne. Les contraintes de la base (ADR 026)
restent le dernier arbitre : deux lots ou un lot et une saisie concurrents ne
facturent pas deux fois.

**Pas de rattrapage automatique des mois passés.** Le lot d'octobre ne
facture pas un loyer de septembre oublié, ni une réservation d'août. Rejouer
le lot du mois concerné le fait. Raison : les contrats repris de l'existant ont
été facturés hors de l'application jusqu'ici, et une ligne retirée d'un
brouillon (un geste) ne doit pas revenir d'elle-même le mois suivant.

### Rejouer un lot

Pour chaque client qui a quelque chose à facturer :

| Facture de lot du client pour la période | Effet |
|---|---|
| Aucune, ou annulée par avoir | Nouveau brouillon |
| Brouillon | Complété de ce qui reste (une instruction, positions à la suite) |
| Émise (non annulée) | Laissée telle quelle ; le reste est signalé, à facturer à part |

Une ligne retirée d'un brouillon, ou un brouillon abandonné, rend sa source
facturable : un lot rejoué sur la même période la reprend.

### Journalisé, un seul à la fois, un client à la fois

- Le lot est inscrit `running` dans sa propre transaction avant tout calcul,
  puis passé `completed` avec son bilan (brouillons créés, complétés, lignes,
  clients sans rien à facturer, avertissements), ou `failed` avec sa cause.
- Un second lancement pendant qu'un lot tourne est refusé (index unique de
  l'ADR 026). Un lot resté `running` plus de trente minutes est réputé
  interrompu et passé `failed` au lancement suivant.
- Les brouillons s'écrivent dans une transaction, **un point de reprise par
  client** : un refus de la base pour un client (source prise entre-temps,
  ligne incohérente) annule ce client seul, que le bilan nomme ; les autres
  sont écrits.
- **Le lot n'émet rien.** L'équipe relit, puis émet — une à une ou en groupe.

### Mode de paiement attendu

Le prélèvement si le client a un mandat actif et non caduc (et ce mandat sur
la facture), sinon le mode par défaut du centre — le virement si ce défaut est
le prélèvement, qu'aucun mandat ne permet (ADR 027). Le lot pose ce mode par
`invoicePaymentSetup` (ADR 030), qui applique la règle pure
`expectedPaymentFor` : un mandat caduc (36 mois sans prélèvement) ne rend plus
une facture prélevable.

### TVA

Par catégorie et par taux sur la somme des bases (ADR 026, BR-CO-17) : c'est
la base qui la calcule ; l'aperçu d'un lot l'annonce par le jumeau TypeScript
(`invoiceAmounts`). Testé : trois lignes de 0,33 € HT à 20 % font 0,20 € de TVA,
pas 0,21 € (arrondi ligne à ligne). Un taux nul est classé en exonération
(`E`) ; son motif (BT-120) se complète sur le brouillon, et l'émission
l'exige (ADR 032).

### Écrans

| Écran | Contenu | Droit |
|---|---|---|
| `/factures` | Liste filtrable (état, nature, client, période) ; émission groupée des brouillons cochés, chacun dans sa transaction | `facturation.consulter`, émission `facturation.gerer` |
| `/factures/preparer` | Mois du centre par défaut : aperçu par client (lignes, HT, TVA, TTC, facture existante), ce qui est à reprendre à la main, lancement, bilan, journal des lots | `facturation.gerer` |
| `/factures/[id]` | Fiche : conditions, lignes, ventilation de TVA, ce qui manque pour émettre, émission, abandon ; avoir partiel (brouillon à réduire) ou total (émis aussitôt) ; avoirs et paiements | `facturation.consulter`, écritures `facturation.gerer` |
| `/factures/[id]/lignes/[ligneId]` | Désignation et quantité ; prix d'une ligne saisie à la main ou d'une ligne d'avoir | `facturation.gerer` |
| `/factures/[id]/document` | Vue imprimable : mentions obligatoires, depuis les instantanés pour une facture émise ; feuille d'impression, « Imprimer ou enregistrer en PDF » | `facturation.consulter` |

Le prix d'une ligne tirée d'une source (loyer, réservation, forfait, acte) ne
se réécrit pas : on retire la ligne. Le relevé des ouvertures (ADR 015) reste,
comme contrôle ; il n'est plus la source de la facturation.

## Justification

**Le premier jour à échoir, le dernier à terme échu.** C'est la seule ancre
qui facture un trimestre une fois sans table d'état, et qui facture le premier
mois partiel d'un contrat dans le mois où il commence.

**Ne proposer que le reste.** Un lot rejoué qui se heurterait aux contraintes
de la base échouerait client par client sur ce qu'il a déjà fait ; lire ce qui
est facturé le rend rejouable à volonté, et laisse aux contraintes leur rôle
de garde-fou.

**Un point de reprise par client.** Un lot tout-ou-rien laisserait cent
clients sans facture pour un seul pli litigieux ; un lot sans transaction
laisserait des brouillons à moitié écrits.

**Le lot inscrit avant de travailler.** Un lot qui échoue laisse une trace et
sa cause ; un lot concurrent est refusé tout de suite.

**Une vue imprimable plutôt qu'une bibliothèque.** Le PDF n'est qu'une vue
(ADR 026), le navigateur sait l'imprimer ; aucune dépendance.

## Alternatives écartées

**Rattraper automatiquement tout ce qui n'est pas facturé** depuis le début de
chaque contrat : le premier lot facturerait des mois déjà facturés hors de
l'application, et un geste retiré d'un brouillon reviendrait.

**Une facture par source** (une pour le loyer, une pour les actes) : contraire
à R15, et autant de numéros, d'échéances et de paiements à suivre.

**Recalculer le prix d'une réservation au lot** : la grille a pu changer ; le
devis figé fait foi (ADR 023).

**Arrondir la TVA ligne à ligne** : écarts d'un centime que la plateforme
agréée refuserait (ADR 026).

## Conséquences

- Le lot se lance depuis l'écran par un membre de l'équipe : il n'y a pas de
  lancement planifié, `invoice_runs.created_by` étant obligatoire.
- ~~Une version de contrat qui n'a que des lignes ponctuelles et un montant
  saisi ne peut pas facturer son loyer (la base refuse un loyer global à côté
  de lignes) : le lot le signale, la facture se complète à la main.~~
  Corrigé par l'ADR 032 : ce loyer se facture par le lot, à côté des frais.
- ~~Un avenant signé après la facturation de sa période ne refacture rien : la
  période est déjà facturée à l'ancien prix ; la différence passe par un avoir
  et une ligne ajoutée à la main.~~ Faux : le lot refacturait la période aux
  lignes de la nouvelle version. Corrigé par l'ADR 032 : un avenant de prix ne
  se signe plus sur une période facturée (avoir d'abord), et ni le lot ni la
  base ne laissent une version refacturer les jours d'une autre.
- **À valider par le centre** : les trois périodes du lot, l'absence de
  rattrapage automatique, l'ordre des lignes, l'inclusion des N premiers actes
  par ordre d'ouverture, la facturation des réservations au jour de leur
  début, le mode de paiement déduit du mandat.
- **À valider par l'expert-comptable** : la TVA à 20 % de la domiciliation et
  des bureaux équipés (taux par défaut des contrats et des services), le
  classement d'un taux nul en exonération, l'échéance de 30 jours, la mention
  « prestations de services » et les mentions de pied de facture.
