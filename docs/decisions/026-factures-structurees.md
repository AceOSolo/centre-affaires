# ADR 026 — Factures structurées : modèle EN 16931, émission, avoirs, double facturation

**Date** : 2026-10-01
**Statut** : accepté

## Contexte

La facturation entre dans le périmètre (ADR 016, décision D1) : échéances et
factures sans ressaisie (R13), actes remontés sur la facture (R14), une facture
qui réunit location, forfaits et actes (R15), paiement et export (R16, ADR 027).

Les principes sont posés depuis le début :

- des **données structurées** compatibles EN 16931 dès la création ; le PDF
  n'est qu'une vue ;
- l'émission réglementaire passera par une **plateforme agréée**, jamais par du
  code maison (réception obligatoire depuis septembre 2026, émission au
  1er septembre 2027) ;
- une **numérotation** continue par centre (ADR 021), attribuée à l'émission ;
- une facture émise **ne se modifie plus** : toute correction passe par un avoir.

Le centre facture par virement et prélèvement suivis à la main (ADR 016).

## Décision

### Le modèle

| Table | Contenu |
|---|---|
| `invoices` | Facture ou avoir (`kind`), client, période, numéro, dates, statut, totaux, règlement, instantanés figés |
| `invoice_lines` | Lignes typées, reliées à leur source |
| `invoice_runs` | Lots de facturation périodique |

Un avoir est une ligne de `invoices` de nature `credit_note`, reliée à la
facture qu'il corrige (`credited_invoice_id`, même client par clé étrangère).
Ses montants sont positifs : c'est sa nature qui le fait venir en déduction.

**Correspondance EN 16931** (principaux termes) :

| EN 16931 | Colonne |
|---|---|
| BT-1 numéro | `invoices.number` |
| BT-2 date d'émission | `invoices.issue_date` |
| BT-3 type (380, 381) | `invoices.kind` |
| BT-5 devise | `invoices.currency` |
| BT-9 échéance | `invoices.due_date` |
| BT-10 référence acheteur | `invoices.buyer_reference` |
| BT-25 facture précédente (avoir) | `credited_invoice_id`, `legal_mentions.creditedInvoiceNumber` |
| BG-4 vendeur | `invoices.seller_snapshot` |
| BG-7 acheteur | `invoices.buyer_snapshot` |
| BG-14 période de facturation | `period_start`, `period_end` |
| BG-16 paiement, BT-81 moyen | `expected_payment_method`, IBAN du vendeur, `mandate_reference` |
| BG-22 totaux | `total_excl_tax_cents`, `total_tax_cents`, `total_incl_tax_cents` |
| BG-23 ventilation de TVA | par (`vat_category`, `vat_rate_bp`) sur les lignes |
| BG-25 ligne | `invoice_lines` : `description`, `quantity`, `unit`, `unit_price_cents`, `net_amount_cents` |
| BG-26 période de la ligne | `invoice_lines.period_start`, `period_end` |
| BT-151, BT-152 TVA de la ligne | `vat_category`, `vat_rate_bp` ; BT-120 `vat_exemption_reason` |

La conversion vers le format de la plateforme (Factur-X, UBL ou CII) sera
écrite au raccordement. Le modèle porte déjà tout ce qu'elle lira.

### Le cycle de vie

1. **Brouillon** (`draft`) : sans numéro ni date d'émission. Il se modifie, ses
   lignes aussi. On l'abandonne par `deleted_at` : ses lignes sont retirées
   avec lui et libèrent leurs sources.
2. **Émission** : `select issue_invoice(id, staff_id)` — le seul chemin. La
   fonction, dans la transaction appelante :
   - verrouille le brouillon ;
   - vérifie les **mentions obligatoires** (plus bas) et le moyen de paiement ;
   - recalcule la TVA et les totaux ; refuse une facture vide ou négative ;
     pour un avoir, refuse un montant nul, un avoir qui dépasserait le reste à
     créditer, ou une ligne créditée au-delà de son montant ;
   - prend le numéro (`next_document_number('invoice')` ou `('credit_note')`,
     ADR 021) : sans trou, une transaction annulée le rend ;
   - date la facture du **jour du centre**, calcule l'échéance, fige le vendeur,
     l'acheteur et les mentions ; rend le numéro.
3. **Émise** : plus rien ne change, sauf ce que la base déduit des paiements et
   des avoirs.

Refus : `CA003` (non conforme, le message dit quoi compléter), `CA002` (déjà
émise). Poser `status` ou `number` depuis le code est refusé.

### Le statut se déduit

Hors brouillon, le statut est une fonction des montants
(`invoice_payment_status`), vérifiée par une contrainte :

| Statut | Condition |
|---|---|
| `cancelled` (annulée par avoir) | avoirs émis ≥ total TTC |
| `paid` | total − avoirs − paiements ≤ 0 (une facture à 0 € l'est) |
| `partially_paid` | reste dû, et des paiements |
| `issued` | sinon |

`paid_cents` et `credited_cents` sont tenus par la base, après chaque paiement
et chaque avoir émis (ADR 027). Un avoir n'a que `draft` et `issued`.

### Une facture émise est immuable

- Un trigger refuse toute écriture d'une facture émise et de ses lignes
  (`CA002`), sauf le règlement déduit par la base.
- Le rôle applicatif n'a pas le droit `DELETE` sur `invoices` et
  `invoice_lines` (`42501`) ; une garde arrête aussi le propriétaire.
- Le vendeur, l'acheteur et les mentions sont **copiés** dans la facture :
  changer l'adresse du centre ou d'un client ne change aucune facture émise.

### Les montants sont tenus par la base

- Le net de chaque ligne est une colonne générée (`line_net_amount_cents`,
  ADR 023) : quantité × prix, moins la remise, au prorata.
- La TVA se calcule **par catégorie et par taux sur la somme des bases**
  (EN 16931, BR-CO-17), puis se répartit sur les lignes : chacune reçoit sa
  TVA arrondie, l'écart d'arrondi va à la ligne de plus forte valeur absolue.
  La somme des TVA des lignes égale celle de la ventilation, au centime.
- Après chaque instruction qui écrit des lignes d'un brouillon, la base
  recalcule la TVA des lignes et les totaux (`invoice_refresh_amounts`). Les
  totaux écrits par le code sont ignorés.

`invoiceAmounts()` (`montants.ts`) en est le jumeau, pour un aperçu.

### Les lignes et leurs sources

| Nature (`kind`) | Source exigée |
|---|---|
| `rent` (loyer) | `contract_id`, période ; `contract_line_id` si la version a des lignes |
| `package` (forfait) | `subscribed_service_id` ou `contract_line_id`, période |
| `booking` (réservation) | `booking_id` (une réservation, `kind = 'booking'`) |
| `act` (acte) | `service_id` ; `mail_item_id` pour un pli |
| `discount` (remise) | aucune ; prix unitaire négatif ou nul |
| `other` | aucune |

Règles vérifiées à l'écriture de la ligne (refus : `CA003`) :

- chaque source est celle du client facturé (contrat, réservation,
  souscription, pli) ;
- un loyer ou un forfait de contrat vise un contrat engagé (en cours ou
  résilié, non archivé) et la **version de prix en vigueur sur toute sa
  période** (ADR 025) : une période à cheval sur une date d'effet se coupe en
  deux lignes ; une version qui a des lignes se facture ligne à ligne, jamais
  par un loyer global à côté ; la période ne dépasse pas le dernier jour du
  contrat ;
- une ligne ponctuelle de contrat prend pour période le premier jour de sa
  version : elle n'est facturée qu'une fois ;
- un forfait souscrit reste dans les dates de sa souscription ;
- un acte de courrier vise un pli ouvert et non retiré.

`resource_id` et `service_id` sur la ligne servent aux indicateurs (revenu par
ressource, rentabilité des services, R31).

### Une source n'est facturée qu'une fois, hors avoir

Tant qu'une ligne tient sa source (ni retirée, ni libérée par un avoir) :

| Source | Garantie | Refus |
|---|---|---|
| Une réservation | index unique partiel | `23505` |
| Un pli | index unique partiel | `23505` |
| Une ligne de contrat (ou le loyer d'un contrat sans ligne), sur une période | contrainte d'exclusion sur les jours | `23P01` |
| Une souscription, sur une période | contrainte d'exclusion sur les jours | `23P01` |

Deux périodes qui se suivent (septembre, puis octobre) passent ; deux qui se
recouvrent d'un jour sont refusées. Un brouillon en cours tient déjà ses
sources : deux lots simultanés ne facturent pas deux fois.

Une ligne **entièrement créditée** par un avoir émis (une ou plusieurs lignes
d'avoir qui la désignent, pour son montant net exact) est libérée
(`released_at`) : sa source peut être refacturée, sur la facture corrigée. Un
avoir partiel ne libère rien.

### Les avoirs

`draft_credit_note(facture, motif)` prépare un avoir qui reprend ce qui reste
de la facture : chaque ligne pas encore entièrement créditée, à l'identique si
rien n'en a été crédité, pour son reliquat sinon. Le code peut le réduire
(avoir partiel, geste commercial) avant de l'émettre par `issue_invoice`.

Une ligne d'avoir ne porte pas de source : elle désigne la ligne créditée
(`credited_line_id`), qui doit appartenir à la facture corrigée.

### Une facture par client et par période

Un lot (`invoice_runs`) génère des brouillons pour une période. Un seul lot
`running` à la fois par centre. Une facture de lot est unique par client et
par période (`invoices_run_period_key`) ; une facture annulée par avoir ou un
brouillon abandonné laisse la place à la facture corrigée. Le lot n'émet rien :
l'équipe relit, puis émet.

Une facture réunit (R15) les loyers des contrats, les forfaits souscrits, les
réservations ponctuelles et les actes du client. **Par défaut** (à valider) :
la facture du mois M porte le récurrent du mois M (à échoir,
`tenants.recurring_billing_timing = 'in_advance'`, ou du mois M − 1 en
`in_arrears`) et les consommations du mois M − 1 — réservations commencées et
plis ouverts ce mois-là, jour du centre.

### Mentions obligatoires

Vérifiées à l'émission (`CA003`), figées dans la facture :

- **vendeur** (`tenants`) : raison sociale, adresse, SIREN, numéro de TVA
  intracommunautaire — exigés ; forme juridique, capital, SIRET, RCS — repris
  quand ils sont renseignés ;
- **acheteur** (`clients`) : nom et adresse exigés ; SIRET, SIREN (les neuf
  premiers chiffres), TVA intracommunautaire repris ;
- numéro, date d'émission, période (date des prestations), désignation,
  quantité, prix unitaire HT, taux et montant de TVA, totaux HT, TVA, TTC ;
- **échéance** : 30 jours après l'émission par défaut
  (`tenants.invoice_payment_terms_days`, 60 au plus, art. L. 441-10 du Code de
  commerce), ou le délai propre du brouillon ;
- **pénalités de retard** (`late_payment_penalty_text`), **indemnité
  forfaitaire de recouvrement** de 40 € (`recovery_indemnity_cents`),
  **escompte** (`early_payment_discount_text`) ;
- option pour la TVA d'après les débits (`vat_on_debits`), catégorie de
  l'opération (prestations de services), mentions libres de pied de page ;
- **paiement** : l'IBAN du centre pour un virement ; pour un prélèvement, un
  mandat actif du client et l'identifiant créancier SEPA du centre (ADR 027).

### TVA

Un taux par service, par ligne de contrat et par ligne de facture, en points
de base ; 20 % par défaut (`tenants.default_vat_rate_bp`). La domiciliation et
la location de bureaux équipés sont à 20 %. Une catégorie autre que `S` (taux
normal ou réduit) a un taux nul et appelle un motif d'exonération.

### Côté client

Sous portée client (ADR 019), un client ne voit que ses factures et avoirs
**émis**, leurs lignes et leurs paiements — jamais un brouillon, même par une
requête sans filtre. Les lots ne sont visibles que du back-office.

### Droits

`facturation.consulter` : l'accueil et l'exploitant (répondre à un client sur
sa facture). `facturation.gerer` (brouillons, lots, émission, avoirs) :
l'exploitant.

## Justification

**L'émission en base.** Le numéro, la date et le figement doivent se faire
ensemble ou pas du tout. Une fonction dans la transaction de l'appelant le
garantit quel que soit le chemin (écran, lot, reprise), comme
`next_document_number` garantit la continuité.

**Le statut déduit.** Un statut écrit par le code finit par contredire les
paiements. Une fonction des montants, vérifiée par une contrainte, ne le peut
pas.

**La double facturation refusée par la base.** Deux lots lancés au même
instant, ou un lot rejoué après un échec, liraient chacun « pas encore
facturé ». Un index ou une contrainte d'exclusion tranche, comme pour les
réservations (décision 3).

**La TVA par taux.** C'est la règle d'EN 16931 et ce que la plateforme
vérifiera. La calculer ligne à ligne donne des écarts d'un centime sur le
total, que la plateforme refuserait.

**Les avoirs dans la même table.** Mêmes lignes, même ventilation, même export,
même passage par la plateforme ; seule la série de numéros diffère.

## Alternatives écartées

**Un PDF généré comme source de vérité** : contraire à `CLAUDE.md` et à la
réforme ; illisible par la plateforme.

**Corriger une facture émise en place, en gardant un journal** : interdit
(numéro, date et contenu font foi), et la plateforme aura reçu l'original.

**Numéroter les brouillons** : un brouillon abandonné laisserait un trou.

**Marquer les sources « facturées » sur la source elle-même** (une colonne sur
la réservation, le pli) : chaque module devrait connaître la facturation, et
la libération par avoir deviendrait une écriture croisée.

## Conséquences

- Le code n'écrit jamais `number`, `status`, `issue_date`, `due_date`, les
  instantanés, les totaux, `vat_amount_cents`, `total_amount_cents`,
  `paid_cents`, `credited_cents` ni `released_at` : la base les tient.
- Une ligne s'écrit de préférence en une instruction pour plusieurs lignes : le
  recalcul se fait une fois par instruction.
- La transaction qui émet reste courte : aucun appel externe entre la prise du
  numéro et la validation (ADR 021). L'envoi à la plateforme se fera après.
- Le relevé des ouvertures (ADR 015) reste un contrôle ; la facture est la
  source.
- **À valider par l'expert-comptable** : l'échéance de 30 jours, le texte des
  pénalités, l'escompte, la TVA à 20 % de la domiciliation et des bureaux
  équipés, le régime de TVA (encaissements par défaut), la série annuelle
  (ADR 021), le moment de facturation du récurrent.
