# ADR 031 — Indicateurs : définitions de l'occupation et du chiffre d'affaires

**Date** : 2026-10-01
**Statut** : accepté — les définitions marquées « à valider » attendent le
centre ou l'expert-comptable

## Contexte

Le cahier des charges demande des indicateurs (R31, slide 12) : taux
d'occupation, revenu par ressource, rentabilité des services. La vague 2 livre
l'écran `/indicateurs` (droit `indicateurs.consulter`, exploitant seul, ADR
019), qui lit les factures et avoirs émis du lot de facturation (ADR 026 et
029) et l'occupation du planning (ADR 017 et 018).

Un chiffre n'a de sens que si sa définition est écrite. La tranche les a posées
dans le code (`src/modules/indicateurs/`) et sur la page (« Comment ces
chiffres sont calculés ») ; cet ADR les consigne, à l'intégration de la
vague 2.

## Décision

**Occupation** — heures occupées sur heures d'ouverture de chaque ressource,
jour par jour, selon ses horaires et ses fermetures (`ouverture.ts`, ADR 010
horaires et 012). **À valider.**

- Comptent les réservations confirmées et les occupations par contrat : une
  ressource sous contrat est occupée toutes ses heures d'ouverture, chaque jour
  du contrat (ADR 018).
- Ne comptent ni les demandes en attente, ni les indisponibilités, ni ce qui
  déborde des horaires.
- Une ressource n'est comptée ouverte qu'à partir de sa création (avancée par
  une réservation importée plus ancienne) et jusqu'à son archivage ; une
  ressource retirée ou archivée et inoccupée sort du parc.
- Un type se calcule sur la somme des minutes de ses ressources, pas en
  moyenne de taux. Un taux s'affiche à une décimale, jamais arrondi à 0 % ou
  100 % s'il ne l'est pas exactement.
- Le calcul jour par jour réutilise celui de la vue mois du planning
  (`dayOccupancy`).

**Chiffre d'affaires** — lignes des factures émises sur la période, à leur
**date d'émission** (comme l'export FEC, ADR 030), moins les avoirs émis sur la
même période. Un brouillon ne compte pas. Un avoir est retiré de la ressource,
du service et de la nature de la ligne qu'il crédite, même si cette ligne a été
facturée avant la période. **À valider** : le revenu par période de prestation
reste possible (les lignes portent leur période), il n'est pas retenu.

- La ressource d'une ligne est `invoice_lines.resource_id`, que le lot pose ;
  à défaut, celle de sa source (réservation, ligne de contrat, segment du
  contrat au premier jour facturé). Le service : `service_id`, sinon celui de
  la ligne de contrat ou de la souscription.
- Les actes comptent en nombre, inclus à 0 € compris, moins ceux crédités.
- Une seule devise, celle du centre : un document, une ligne ou un paiement
  dans une autre devise est compté à part et signalé, jamais converti.

**Encaissé, restant dû, encours** — paiements pointés à leur date de valeur,
annulations exclues, remboursements déduits. Restant dû : ce qui manque
aujourd'hui sur les factures émises dans la période ; un trop-perçu ne vient
pas en déduction. L'encours de toutes périodes et sa part échue sont montrés à
part. **À valider.**

**Tendance** — douze mois, finissant au mois de fin de la période choisie.
Une période est plafonnée à 366 jours.

## Ce qui n'est pas mesuré

- **Rentabilité des services et des ressources** : elle rapporte un revenu à un
  coût, et aucun coût n'est saisi dans l'application. Seul le revenu est
  montré.
- **Heures administratives économisées** : l'application ne connaît pas le
  temps que prenaient les tâches avant elle. Les estimer demande un relevé du
  temps passé, avant et après, tenu par l'équipe.

Ces deux écarts sont dits sur la page ; R31 est couvert pour le reste.

## Justification

**Date d'émission plutôt que période de prestation** : c'est la date que la
comptabilité retient (FEC) ; les deux écrans tombent sur les mêmes totaux.

**Calculs purs et testés** (`occupation.ts`, `revenus.ts`, `tableau.ts`,
`graphique.ts`, `periode.ts`) : la requête ne fait que lire, sous le centre
courant et le rôle applicatif (`indicateurs.db.test.ts`).

## Alternatives écartées

**Une bibliothèque de graphiques** : deux histogrammes SVG suffisent, avec un
tableau mois par mois comme équivalent textuel. Aucune dépendance.

**Lire les brouillons** : un brouillon n'a ni numéro ni date d'émission ; le
compter ferait varier le chiffre d'affaires d'un mois passé à chaque lot.

## Conséquences

- Les choix « à valider » ci-dessus sont à relire avec le centre et son
  expert-comptable.
- Une ligne de facture sans `resource_id` est rattachée par sa source : poser
  la colonne en base (ou l'exiger) rendrait l'attribution exacte pour un loyer
  qui couvre un changement de ressource sans changement de prix.
