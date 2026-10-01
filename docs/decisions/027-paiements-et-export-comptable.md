# ADR 027 — Paiements, mandats SEPA chiffrés et export comptable

**Date** : 2026-10-01
**Statut** : accepté

## Contexte

Le centre se fait payer par virement et par prélèvement, suivis à la main,
sans prestataire de paiement (ADR 016). L'équipe pointe ce qu'elle reçoit ; un
export sert à la banque. L'expert-comptable reçoit les écritures (R16), et le
cahier des charges demande que le format de cet export soit fixé tôt
(roadmap, phase 1).

Un prélèvement SEPA suppose un mandat signé du client : une référence unique
de mandat (RUM), l'IBAN et le BIC du compte débité, la date de signature, le
type (récurrent ou ponctuel). L'IBAN d'un client est une donnée bancaire
personnelle : l'ADR 016 le veut chiffré.

## Décision

### Les paiements : `payments`

Un paiement reçu se pointe sur une facture émise : montant en centimes (négatif
pour un remboursement), devise, date de valeur (jour du centre), mode
(`transfer`, `direct_debit`, `other`), référence bancaire, mandat pour un
prélèvement, membre de l'équipe qui l'a saisi.

- Seulement sur une facture **émise** (pas un brouillon, pas un avoir), dans
  **sa devise** (SQLSTATE `CA006`). Un avoir ne se paie pas : un
  remboursement se pointe sur la facture, en négatif.
- Un paiement **ne se modifie ni ne se supprime** : une erreur de pointage
  s'annule (`cancelled_at`, `cancelled_by`, motif), la ligne reste ; on saisit
  ensuite le bon (`CA006` ; suppression : `42501`).
- Après chaque paiement ou annulation, la base recalcule `invoices.paid_cents`
  et le statut de la facture (ADR 026). Un trop-perçu laisse la facture
  `paid` avec un reste dû négatif (`amountDueCents`), à rembourser.

### Les mandats : `sepa_mandates`

RUM, titulaire du compte, IBAN chiffré, quatre derniers caractères de l'IBAN,
BIC, date de signature, type (`recurrent`, `one_off`), statut (`active`,
`revoked`, `expired`), date de révocation, date du dernier prélèvement.

- **L'IBAN n'est jamais en clair en base.** L'application le chiffre avant
  l'écriture par `sealIban()` (`src/modules/facturation/iban.ts`) : AES-256-GCM
  avec la clé des documents (ADR 020, `DOCUMENTS_ENCRYPTION_KEY`), au format
  autoportant `CAD1` qui porte la version de clé. Les données associées lient
  le chiffré à son mandat — centre et RUM : un chiffré recopié sur le mandat
  d'un autre client ne se déchiffre pas. La base refuse tout contenu qui n'a
  pas l'en-tête du format (`sepa_mandates_iban_sealed`) ; `iban_key_version`
  dit avec quelle clé relire.
- `sealIban` contrôle l'IBAN (format, clé modulo 97) avant de le chiffrer.
  `openIban` le relit, pour l'export bancaire ou un affichage complet demandé ;
  partout ailleurs, l'écran affiche `maskIban(iban_last4)`.
- **La RUM n'est jamais réattribuée** dans un centre, même après révocation
  (unicité sans condition), et ni la RUM ni le client d'un mandat ne changent
  (`CA007`). Un changement de compte réécrit l'IBAN chiffré sous la même RUM,
  comme le permet le règlement SEPA.
- **Un mandat actif au plus par client.** Une facture en prélèvement désigne
  le mandat de son client (clé étrangère composite) ; l'émission exige qu'il
  soit actif et que le centre ait un identifiant créancier SEPA (ADR 026). La
  RUM est figée dans la facture.
- Un mandat inutilisé pendant 36 mois devient caduc (règlement SEPA) : le code
  le passe à `expired` à partir de `last_collected_on`.

### L'IBAN du centre est en clair

`tenants.bank_iban`, `bank_bic` et `sepa_creditor_id` sont les coordonnées du
**vendeur**, imprimées sur chaque facture payable par virement et figées dans
`seller_snapshot`. Ce ne sont pas des données personnelles d'un client, et une
facture doit rester lisible dix ans, indépendamment des rotations de clés. Ils
sont stockés en clair, avec un contrôle de format.

### L'export comptable : au format du FEC

Le fichier remis à l'expert-comptable suit le format du **fichier des
écritures comptables** (art. A47 A-1 du livre des procédures fiscales) : dix-
huit colonnes (`JournalCode`, `JournalLib`, `EcritureNum`, `EcritureDate`,
`CompteNum`, `CompteLib`, `CompAuxNum`, `CompAuxLib`, `PieceRef`, `PieceDate`,
`EcritureLib`, `Debit`, `Credit`, `EcritureLet`, `DateLet`, `ValidDate`,
`Montantdevise`, `Idevise`), séparées par une tabulation, montants à virgule
décimale, dates `AAAAMMJJ`. C'est le format que tout logiciel comptable
importe. Ce n'est pas le FEC légal du centre, que produit sa comptabilité.

Deux journaux, codes réglables par centre :

| Journal | Code par défaut | Écritures |
|---|---|---|
| Ventes | `VE` (`accounting_sales_journal`) | Par facture émise : débit client TTC ; crédit ventes HT par nature de ligne ; crédit TVA collectée par taux. Un avoir, à l'inverse. |
| Banque | `BQ` (`accounting_bank_journal`) | Par paiement non annulé : débit banque, crédit client. Un remboursement, à l'inverse. |

Pièce : le numéro de la facture ou de l'avoir ; date d'écriture : sa date
d'émission, ou la date de valeur du paiement. Compte auxiliaire du client :
`clients.accounting_code` (unique parmi les clients vivants), sous le
collectif 411.

### Le plan de comptes : `accounting_accounts`

Une ligne par compte et par centre : collectif clients (`customers`), banque
(`bank`), ventes par nature de ligne (`revenue`, `line_kind`), TVA collectée
par taux (`vat_collected`, `vat_rate_bp`).

La base le pose pour chaque centre — par la migration 0031, puis à la création
de tout nouveau centre (`seed_accounting_accounts`, trigger sur `tenants`) —
avec des comptes du plan comptable général :

| Rôle | Compte |
|---|---|
| Clients | 411000 |
| Banque | 512000 |
| Ventes : loyers et domiciliation, réservations, forfaits, actes, divers | 706100, 706200, 706300, 706400, 706000 |
| Remises | 709000 |
| TVA collectée à 20 %, 10 %, 5,5 %, 2,1 % | 445711, 445712, 445713, 445714 |

C'est un paramétrage : il se corrige en place, sans historique. Un taux de TVA
sans compte fait refuser l'export plutôt que d'improviser. **Tout ce plan est à
valider par l'expert-comptable.**

### Le journal des exports : `accounting_exports`

Chaque fichier remis : période, format (`fec`), nom, empreinte SHA-256, nombre
d'écritures, auteur, date. On y ajoute, on y lit ; le rôle applicatif n'a ni
`UPDATE` ni `DELETE`, et une garde arrête aussi le propriétaire. L'empreinte
permet de dire, plus tard, si un fichier présenté est bien celui qui a été
remis.

### Droits

`paiements.gerer` (pointer, annuler un paiement ; mandats) et
`comptabilite.exporter` (export et plan de comptes) reviennent à l'exploitant ;
`indicateurs.consulter` (occupation, chiffre d'affaires, rentabilité, R31)
aussi. L'accueil consulte les factures et leurs paiements
(`facturation.consulter`).

## Justification

**La clé des documents plutôt que `sealSecret`.** `sealSecret` (ADR 014) n'a
qu'une clé, sans version, réservée aux jetons de tiers. La clé des documents
porte une version par objet, se tourne sans tout rechiffrer d'un coup, et ses
données associées lient le chiffré à son mandat. Un IBAN de client relève des
données du client, comme ses scans.

**Un contrôle en base de l'en-tête chiffré.** Le chiffrement est applicatif :
seul un contrôle en base empêche qu'un chemin oublié, un script de reprise ou
une saisie directe écrive un IBAN en clair.

**Le FEC.** Format public, stable, lu par tous les logiciels comptables ; pas
de dépendance ni de connecteur à maintenir.

**Le statut déduit des paiements.** Voir l'ADR 026 : un statut écrit à la main
finit par contredire les sommes.

## Alternatives écartées

**Un prestataire de paiement** (Stripe, GoCardless) : écarté par le centre
(ADR 016).

**L'IBAN en clair, masqué à l'écran** : une copie de la base, une branche, une
sauvegarde l'exposeraient.

**Supprimer un paiement saisi par erreur** : la trace d'une erreur de pointage
compte autant que le pointage, et l'export bancaire déjà remis la contient
peut-être.

**Un export au format d'un logiciel comptable précis** : il faudrait le
changer avec le cabinet.

## Conséquences

- `infra/chiffrer-documents.ts` (rotation de la clé des documents) ne traite
  que les scans : la rotation devra aussi rechiffrer `sepa_mandates`, sous la
  même RUM, avant de retirer une ancienne clé.
- La clé des documents devient nécessaire pour créer un mandat : sans elle,
  l'écran le dit, comme pour le dépôt d'un scan.
- Le fichier de remise des prélèvements à la banque (pain.008) peut se
  construire depuis le modèle (ICS, RUM, IBAN, BIC, type, date de signature),
  sans dépendance : à faire quand le centre prélèvera.
- **À valider par l'expert-comptable** : le plan de comptes, le traitement de
  la TVA exigible à l'encaissement (régime par défaut des prestations de
  services : écritures de TVA en attente ou non), les codes de journaux, le
  format de l'export.
