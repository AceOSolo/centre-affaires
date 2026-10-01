# ADR 028 — Contrats tirés d'une offre, avenants à l'écran, échéancier versionné et documents archivés

**Date** : 2026-10-01
**Statut** : accepté — met en œuvre les ADR 024 (offres) et 025 (contrats
versionnés) ; les choix marqués « à valider » attendent le centre et son
expert-comptable

## Contexte

Les ADR 024 et 025 ont posé le modèle : lignes de contrat, avenants, segments
d'occupation, documents figés, souscriptions, offres. La base tient les règles
(montant d'une version tenu par ses lignes, avenants qui se succèdent, segments,
empreinte des documents). Restait ce que la base ne décide pas : comment une
offre devient un contrat, ce que l'équipe saisit à l'écran, comment l'échéancier
lit les versions, et ce que contient le document remis au client (R09, R10,
R12 seconde partie).

## Décision

### Un contrat se tire d'une offre en deux temps

`/contrats/nouveau/offre` : l'équipe choisit l'offre, le client et la date de
début (un formulaire en GET), puis ajuste la proposition avant de créer le
brouillon. La création manuelle reste sur `/contrats/nouveau`.

La proposition (`proposeContractFromOffer`, module pur, éprouvé) applique la
correspondance de l'ADR 024 :

| Ligne d'offre | Ligne proposée |
|---|---|
| Ressource ou type de ressource | Ligne de contrat ; prix de l'offre s'il est imposé, sinon celui de la grille par défaut valable au premier jour (la ligne nominative avant celle du type) |
| Service `package` | Ligne de contrat visant le service ; prix de l'offre, sinon du catalogue |
| Service `act`, quantité N | Souscription rattachée au contrat : N actes inclus par mois, au-delà au prix de l'offre ou du catalogue, remise de la ligne |

- **TVA** : celle de la ligne d'offre, sinon du service, sinon le taux par
  défaut du centre (20 %).
- **La quantité d'une ligne d'offre est due par période de facturation**, telle
  que l'écran des offres la saisit et la chiffre (ADR 024, `priceOffer`) : le
  contrat la reprend sans multiplicateur. *Intégration de la vague 2 : la
  tranche contrats multipliait les lignes au mois par 3 ou 12, ce qui aurait
  facturé trois fois l'offre trimestrielle que l'écran des offres annonçait ;
  une seule règle est gardée, celle de l'ADR 024, et un test vérifie que la
  proposition tombe sur le prix de l'offre.* Les actes inclus restent comptés
  par mois : le lot de facturation est mensuel (ADR 026).
- **Aucun prix n'est inventé** (ADR 009) : une ligne sans prix de grille est
  proposée à 0 € et signalée ; un service archivé ou dans une autre devise
  aussi.
- **Une seule ressource occupée** : la première ressource précise des lignes
  est proposée comme ressource du contrat (son occupation, ADR 018) ; les
  autres lignes de ressource sont facturées sans occuper.
- Le type de contrat est suggéré (boîte aux lettres : domiciliation ; bureau :
  bureau privatif ; sinon « autre ») et se corrige.

Le brouillon, ses lignes (`offer_item_id`) et ses souscriptions s'écrivent en
une transaction ; `contracts.offer_id` garde l'offre d'origine. Souscrire les
actes inclus exige en plus `souscriptions.gerer`.

### Les actes inclus suivent leur contrat

Une souscription ne se réécrit pas (`CA004`) ; elle suit le contrat par les
seuls moyens permis :

- le brouillon change de dates : la souscription est archivée et refaite aux
  nouvelles dates, aux mêmes conditions ; une fin seule se corrige en place ;
- le contrat est résilié : elle prend fin au dernier jour effectif ;
- le contrat est archivé : elle l'est au même instant ; le désarchivage la
  rétablit, sauf si une autre souscription l'a remplacée entre-temps ;
- le client d'un brouillon qui porte des souscriptions ne change plus : la clé
  étrangère composite les attache à lui, archivées comprises.

### Les lignes d'un brouillon s'éditent d'un bloc

`/contrats/[id]/lignes` envoie l'état voulu, complet : chaque ligne connue est
mise à jour si elle change, chaque nouvelle insérée, les absentes retirées
(`deleted_at`). La base en déduit le montant du contrat. Sans ligne récurrente,
le montant saisi sur le brouillon fait foi, comme pour les contrats antérieurs ;
avec, le champ « Montant » du brouillon n'est plus qu'un affichage. Un contrat
engagé ne change plus ses lignes : il passe par un avenant.

### Un avenant s'établit, se relit, se signe

`/contrats/[id]/avenants/nouveau`, puis la page de l'avenant :

- **Prix** : inchangé, un nouveau montant sans détail, ou de nouvelles lignes
  qui remplacent toutes les précédentes. Les lignes sont pré-remplies avec
  celles de la version en vigueur à la date d'effet, pour être ajustées ; un
  avenant de prix en lignes porte au moins une ligne récurrente.
- **Ressource** : changée ou retirée à la date d'effet ; si la nouvelle est
  prise à partir de cette date, la signature est refusée et l'écran nomme ce
  qui l'occupe.
- **Date d'effet proposée** : le premier du mois suivant, jamais avant le
  lendemain du début du contrat ni du dernier avenant signé.
- **Signature** : après confirmation ; le document de l'avenant est archivé
  dans la même transaction. **Abandon** : `deleted_at`, l'avenant reste lisible.

Avant le début du contrat, sa ressource change toujours sur la fiche (ADR 018) ;
après, la fiche oriente vers l'avenant.

### L'échéancier lit les versions et la règle de prorata

`contractSchedule` (`echeancier.ts`) coupe chaque période civile aux dates
d'effet des versions de prix (`contract_price_versions`) et proratise chaque
morceau selon `tenants.prorata_rule` (`prorataFraction`, exportée pour le lot
de facturation) :

- `calendar_days` : jours couverts sur jours réels de la période ;
- `thirty_day_month` : chaque mois compte 30 jours ; un morceau commence à son
  jour (le 31 seul ne compte rien) et le dernier jour du mois compte comme le
  30. Les morceaux d'un même mois s'additionnent toujours à 30 ;
- `none` : une période commencée est due en entier, au prix de la version en
  vigueur sur son premier jour couvert ; une version qui prend effet en cours
  de période ne compte qu'à la période suivante (fraction 0/1), sans quoi la
  période serait due deux fois.

Le montant d'un morceau est calculé **ligne à ligne** par la règle d'arrondi de
la base (`lineNetAmountCents`), comme le seront les lignes de facture ; une
version sans ligne, sur son montant. Une ligne ponctuelle est due une fois, dans
la période qui contient le premier jour de sa version. La liste des contrats
montre le prix et la ressource de la version en vigueur, pas ceux de la version
initiale.

### Le document remis est un instantané rendu en HTML

À l'activation et à chaque signature d'avenant, l'instantané `contrat/1`
(`instantane.ts`) est archivé dans `contract_documents`, dans la même
transaction ; la base lui donne sa version et son empreinte SHA-256. Il copie
tout ce que le document affiche, libellés compris : les parties (raison sociale,
forme, capital, adresse, SIREN, RCS, TVA du centre ; identité et adresse du
client), l'objet et l'offre, la ressource de la version, la durée,
l'engagement et la reconduction, les lignes et leurs totaux HT, TVA par taux et
TTC, les actes inclus, les conditions de facturation et de règlement du centre
(délai, pénalités, indemnité de 40 €, escompte, prorata, terme à échoir ou
échu). Les notes internes du contrat n'y figurent pas.

`/contrats/[id]/document` rend un instantané : `?version=N` le document archivé,
avec la vérification de son empreinte recalculée par la base ; sans paramètre,
l'aperçu du contrat avec les données actuelles, marqué « Projet » ;
`?avenant=<id>` l'aperçu d'un avenant. La page vit hors de la coque du
back-office (groupe de routes `(impression)`), avec une feuille d'impression
A4 : le PDF est l'impression du navigateur, sans bibliothèque. Un contrat activé
avant cette tranche reçoit son document par « Établir et archiver le document »
(`contrats.avenants`).

### Engagement et préavis à l'écran

Le formulaire de contrat saisit la TVA d'un contrat sans ligne, l'engagement
et la reconduction tacite. La résiliation propose le premier terme possible
(`earliestEndOn`, jumelle de `contract_earliest_end_on`) et signale une fin
avant le terme de l'engagement comme une résiliation anticipée, d'un commun
accord : la base ne la refuse pas.

## Justification

**La proposition en module pur.** La correspondance offre → contrat porte des
règles d'argent (prix du catalogue, quantités par période, remises) : elle
s'éprouve sans base, et l'écran l'ajuste avant toute écriture.

**Des souscriptions créées avec le brouillon.** Le schéma n'a pas d'autre
endroit où garder les actes inclus entre la création et l'activation ; les
créer à l'activation obligerait à relire l'offre, qui a pu changer.

**L'échéancier ligne à ligne.** Proratiser le montant global puis l'arrondir
s'écarterait d'un centime de la facture, qui arrondit chaque ligne.

**Un instantané complet plutôt qu'une référence.** Un document qui relirait le
client ou le centre changerait avec eux ; celui-ci se rend tel qu'il a été
remis, et son empreinte le prouve.

## Alternatives écartées

**Lier le contrat à l'offre** (prix qui suivent l'offre) : contraire à
l'ADR 024 — une offre modifiée changerait des contrats signés.

**Une bibliothèque de PDF** : une dépendance refusée par la vague, pour ce
qu'une feuille d'impression fait.

**Recalculer l'échéancier sur la version en vigueur aujourd'hui** : la période
passée serait fausse dès le premier avenant.

## Conséquences

- **À valider par le centre et son expert-comptable** : la règle `none` face à
  un avenant en cours de période ; le comptage en base 30 ; les inclus comptés
  par mois ; le texte du
  document (articles, absence de conditions générales, mentions de
  signature) ; la date d'effet proposée.
- Le lot de facturation réutilise `contractSchedule` et `prorataFraction` pour
  couper les périodes et porter la fraction sur la ligne de facture.
- Tant que le contrat est brouillon, ses actes inclus sont déjà souscrits : la
  valorisation des actes doit ignorer une souscription rattachée à un contrat
  brouillon ou archivé.
- La reconduction tacite est saisie et imprimée, mais aucune tâche ne
  prolonge encore `ends_on` au terme.
- La signature électronique du document reste hors périmètre : le document
  s'imprime et se signe à la main.
