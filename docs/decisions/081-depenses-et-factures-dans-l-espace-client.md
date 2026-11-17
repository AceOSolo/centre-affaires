# ADR 081 — Dépenses du mois et factures Dolibarr dans l'espace client

**Date** : 2026-11-17
**Statut** : accepté — lot 8 de la recette du 17/11 (`docs/recette/2026-11-17.md`) ;
complète l'ADR 066 (un flux CRM de plus, « Factures ») et l'ADR 046 § 5
(« l'espace client : factures lues depuis ce que Dolibarr transmet ») ; la
facturation du site reste en sommeil

## Contexte

Note de recette : « Espace client : le cumul de ses dépenses, facturation
mensuelle (frais fixes, affranchissement, majorations), espace facturation
relié à Dolibarr ». La page `/compte/factures` lisait les factures du site, en
sommeil et vides depuis l'ADR 046.

**Contradiction à écrire** : `CLAUDE.md` interdit de rouvrir un écran qui
facture depuis le site. Ce lot **n'émet aucune facture** : il montre au
client une estimation de ce qu'il a consommé, et les factures que Dolibarr a
émises, en lecture.

## Décision

### 1. La page « Dépenses et factures » remplace l'ancienne liste

`/compte/factures` (onglet « Factures », adresse inchangée) montre deux
sections :

- **Mes dépenses** : le mois choisi en détail (`?mois=AAAA-MM`), puis un
  tableau mois par mois ; total **estimé, HT**, avec la phrase du centre
  (« Montant estimé, facturé en fin de mois par le centre. » par défaut) ;
- **Mes factures** : les factures et avoirs reçus de Dolibarr, avec état
  (à payer, échue, payée en partie, payée, annulée, avoir), montant HT et TTC,
  échéance, reste à payer, lien vers le PDF ; coordonnées de virement du
  centre quand une facture est à payer.

La lecture des factures du site (`listInvoicesForAccounts`) n'y est plus
appelée ; ses tables et la vue imprimable `(impression)/compte/factures/[id]`
restent en sommeil.

### 2. Les dépenses : les règles du registre, prises à la source

`crm/depenses.ts` (pur), `crm/depenses-queries.ts` :

- **frais fixes** : chaque contrat en cours ou résilié (jamais brouillon ni
  archivé) compte son prix par période (`contract_price_versions`, avenants
  compris) **le mois où la période commence**, entière, sans prorata ;
- **prestations** : les sources et la validité du registre des consommations
  (ADR 066, `sourceValidity`, `consumptionDraft`) — réservations sans devis
  vivant de toute ressource, ouvertures, pages en plus, numérisations,
  réexpéditions et affranchissement — mais **lues à la source** pour le mois en
  cours, sans attendre qu'elles soient « prêtes » ni que le flux soit ouvert.
  Rien ne s'écrit au registre ;
- **montants** : devis figé de la réservation (ADR 023, « majorations »
  comprises) ; pour un acte du courrier, la règle déjà annoncée au client avant
  chaque demande (`priceActs`, ADR 024 : inclus du forfait, prix du forfait,
  sinon catalogue reçu de Dolibarr) ; sans prix, la ligne est comptée
  « chiffrée sur la facture » et hors du total.

### 3. Les réglages, par centre

Table `client_expense_settings` (une ligne par centre, valeurs par défaut sans
ligne), écran **Réglages > « Dépenses dans l'espace client »**
(`/reglages/depenses`, droit `centre.configurer`) : montrer les dépenses
(oui), estimer les actes du courrier (oui), mois passés (12 ; 3, 6, 12, 24),
phrase sous le total.

### 4. Le flux « Factures » (`invoices`)

- `POST /api/dolibarr/factures`, par `serveCrmCall` (jeton, centre, journal) ;
  flux **né coupé**, ouvert dans Réglages > Connexion au CRM ; coupé : 403.
- Format à nous (`docs/integrations/dolibarr.md`) : `dolibarrId`,
  `tiersDolibarrId` (tiers déjà reçu, sinon 409), `numero`, `type`
  (`facture`/`avoir`), `statut` (`a_payer`, `payee`, `abandonnee`,
  `brouillon`), `date`, `echeance`, montants HT et TTC en centimes,
  `resteAPayerCentimes`, `devise`, `pdf` (lien https), `supprime`.
  Rejouable : `cree`, `modifie`, `inchange`, `retire`, `ignore`.
- Table `crm_invoices` : une ligne par facture du CRM (index unique),
  montants positifs (le sens est dans `kind`), `removed_at` pour une facture
  supprimée ou repassée en brouillon. Règles `59-factures-recues.sql`
  (`CA027`) : pas de suppression (décision 6), CRM et identifiant figés, née
  visible.

### 5. Onglet

`espace-rubriques.ts` : « Factures » paraît dès qu'il y a une facture, un
contrat ou du courrier (`invoices || contracts || domiciliated`), libellé
inchangé.

## Choix par défaut, à confirmer en recette

1. **Le PDF reste chez Dolibarr** : le CRM envoie un lien de téléchargement
   (lien public de Dolibarr, `__DIRECTDOWNLOAD_URL_INVOICE__`) ; le site ne
   stocke pas le document. Si Dolibarr n'est pas joignable de l'extérieur, la
   carte dit « Document envoyé par courriel par le centre ».
2. **Estimation des actes du courrier au forfait ou au catalogue** : ce que
   les contrats Dolibarr comprennent n'est pas connu du site ; l'estimation
   peut donc dépasser la facture. Réglable (case à décocher).
3. **Période des frais fixes** comptée le mois où elle commence, sans prorata.
4. **Montants HT** seulement dans les dépenses (la TVA de l'affranchissement
   reste à valider, ADR 066).
5. **Réservations passées par un devis** absentes des dépenses : le devis les
   facture ; elles apparaîtront sur la facture.
6. **Réservations à venir du mois** comptées, marquées « À venir ».
7. **Libellé « Factures »** gardé dans l'onglet ; le titre de la page dit
   « Dépenses et factures ». Un client qui ne fait que réserver des salles
   (ni contrat, ni courrier, ni facture reçue) n'a pas l'onglet ; la page
   reste joignable.
8. Les 60 factures les plus récentes sont montrées.

## Justification

- **À la source plutôt que dans le registre** : le registre ne se remplit
  qu'au passage du CRM, flux ouvert, et le courrier n'y entre qu'au mois clos ;
  le mois en cours serait vide. Mêmes règles, même code : pas de divergence.
- **Un lien plutôt qu'une copie du PDF** : pas de stockage chiffré, de
  rotation de clé ni de durée de conservation à ajouter ; Dolibarr reste la
  référence de la pièce (« le PDF est une vue »).
- **Format à nous plutôt que l'objet du module Webhook** : montants en
  décimales, dates en horodatage et statut selon la version de Dolibarr ; même
  raison que l'ADR 066 pour les contrats.

## Alternatives écartées

- Recopier le PDF dans le stockage européen (base64 dans l'envoi) : plus
  robuste si Dolibarr n'est pas public, mais chiffrement, rotation et
  conservation à ajouter. Possible plus tard.
- Le site interroge Dolibarr pour lire les factures : contraire à l'ADR 046.
- Afficher un total TTC estimé : taux de TVA de l'affranchissement inconnu.

## Conséquences

- **Migration** `factures_et_depenses` (`crm_invoices`,
  `client_expense_settings`, énumération du journal `crm_exchanges.flow`) et
  règles `59-factures-recues.sql` : `docker compose run --rm migrer`.
- Rien ne change pour Dolibarr tant que la direction n'ouvre pas le flux ; les
  dépenses paraissent dès la mise en ligne.
- **Pour le développeur Dolibarr** : appeler `POST /api/dolibarr/factures` sur
  `BILL_VALIDATE`, `BILL_PAYED`, `BILL_UNPAYED`, `BILL_CANCEL`,
  `BILL_MODIFY`/remise en brouillon, `BILL_DELETE` et à chaque paiement, plus un
  balayage de nuit ; activer le lien public de téléchargement des factures.
- RGPD : `crm_invoices` ne porte que des numéros, montants et dates ; le
  journal n'écrit que l'identifiant Dolibarr.

## Tests

`crm/factures.test.ts` (lecture, lien du PDF, état dit au client),
`crm/depenses.test.ts` (mois, périodes, prix, actes inclus et au catalogue,
pages, affranchissement, fuseau, totaux), `crm/depenses-reglages.test.ts`,
`api/dolibarr/factures/factures.db.test.ts` (404, 403, 409, cycle de vie,
isolement des entreprises, `CA027`), `crm/depenses.db.test.ts` (sources du
compte, devis exclu, autre entreprise exclue, registre intact, réglage),
`clients/espace-rubriques.test.ts`, `crm/connecteurs.test.ts`.
