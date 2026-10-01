# ADR 028 — Règlements : pointage, relances, remises de prélèvement, export FEC, représentation EN 16931

**Date** : 2026-10-01
**Statut** : accepté — précise l'ADR 027 (paiements, mandats, export) ; les
choix marqués « à valider » attendent le centre ou son expert-comptable

## Contexte

L'ADR 027 a posé le modèle : paiements pointés à la main, mandats SEPA à IBAN
chiffré, plan de comptes par centre, journal des exports, format FEC. Il
laissait à construire, de la base à l'écran (R16) :

- le pointage d'un paiement sur la facture, partiel ou total, et sa
  correction ;
- le suivi des factures échues non payées et leurs relances ;
- l'enregistrement et la révocation d'un mandat sur la fiche client ;
- le fichier de remise des prélèvements à la banque (`pain.008`), que
  l'ADR 027 renvoyait à « quand le centre prélèvera » ;
- l'export comptable d'une période ;
- la préparation de la facturation électronique : la facture émise décrite
  dans les termes de la norme EN 16931, et la vérification que tout ce que la
  plateforme agréée exigera est là — sans aucun envoi (ADR 016, ADR 026).

Le schéma de la vague est figé (migrations 0029 à 0031) : ces écrans
s'écrivent sans table nouvelle.

## Décision

### Pointer un paiement

Sur la fiche de règlement d'une facture émise (`/paiements/factures/[id]`) :
montant, date de valeur, mode (virement, prélèvement, autre), référence
bancaire, notes. La nature se choisit — paiement reçu ou remboursement au
client — plutôt qu'un signe moins à saisir.

- La date de valeur n'est **jamais future** : un paiement se pointe une fois
  reçu.
- Un paiement qui **dépasse le reste dû** n'est accepté que si « Trop-perçu »
  est coché : une faute de frappe (1 200 pour 120) se voit avant d'être
  enregistrée. Un **remboursement ne dépasse pas** ce qui a été reçu. Le
  contrôle se fait dans la transaction qui écrit, facture verrouillée : deux
  pointages simultanés ne voient pas le même reste.
- Une erreur **s'annule avec un motif** (ADR 027) ; la ligne reste, barrée,
  avec qui l'a annulée et quand. Le statut de la facture suit, tenu par la
  base.

### Relancer

`/paiements` liste les factures échues non payées, la plus ancienne échéance
d'abord, avec leur retard et un **palier** :

| Retard | Palier |
|---|---|
| dès le lendemain de l'échéance | relance amiable |
| 15 jours | seconde relance |
| 30 jours | mise en demeure (règlement sous huit jours) |

**À valider par le centre.** La lettre reprend la facture, le reste dû, la
façon de payer (IBAN du centre et numéro de facture en référence), les
pénalités de retard et l'indemnité forfaitaire de recouvrement figées dans la
facture. Elle s'imprime (vue imprimable, pas de PDF généré) ou part par
courriel (`src/lib/courriel.ts`), aux contacts « destinataire des factures »
du client, à défaut à l'adresse de sa fiche.

**Aucun envoi automatique** : la vague 3 apportera les modèles de messages et
l'historique des envois (R26). D'ici là, une relance part d'un geste de
l'équipe — une facture, ou une sélection.

### Les mandats sur la fiche client

- **RUM générée** : `RUM-AAAAMMJJ-XXXXXX`, date d'enregistrement et six
  caractères tirés au hasard dans un alphabet sans I, O, 0 ni 1 (19 caractères
  sur les 35 permis). L'unicité définitive est tenue par la base ; une
  collision se rejoue.
- L'IBAN saisi est chiffré (`sealIban`, lié à la RUM) puis **n'est plus
  jamais affiché** que masqué (`•••• 0189`). Il n'est ni prérempli après un
  refus, ni renvoyé par le serveur, ni journalisé. Sans clé des documents,
  l'écran refuse l'enregistrement et le dit.
- Un mandat actif au plus : pour changer de compte, on révoque, puis on
  enregistre le nouveau mandat signé. La révocation est datée du jour du
  centre.
- Un mandat inutilisé 36 mois s'affiche **caduc** et ne se prélève plus.

### Remettre les prélèvements à la banque

`/paiements/prelevements` liste les factures émises payables par
prélèvement, **échues à la date de prélèvement choisie** et qui restent dues.
Une facture dont le mandat est révoqué, caduc, ponctuel déjà utilisé, ou qui
n'est pas en euros, se voit avec son motif, sans case à cocher.

**Préparer une remise marque les factures.** Dans une seule transaction,
factures verrouillées :

1. chaque facture est revérifiée, et le fichier est construit une première
   fois — IBAN déchiffrés, données au format SEPA — avant que rien ne soit
   écrit ;
2. chaque facture reçoit un **paiement `direct_debit`** du reste dû, daté du
   jour de prélèvement demandé, dont la référence est l'identifiant de la
   remise (`PRLV-AAAAMMJJ-XXXXXX`) ;
3. le dernier prélèvement des mandats (`last_collected_on`) prend cette date.

La facture passe « réglée ». **Un rejet de la banque s'annule** comme toute
erreur de pointage, avec le code de rejet pour motif : la facture redevient à
régler, et prélevable. Deux remises simultanées ne prélèvent jamais deux fois
la même facture : la seconde la trouve réglée.

**Le fichier** est un message ISO 20022 `pain.008.001.02`, schéma SEPA
**CORE**, construit en chaîne sans dépendance (`sepa-xml.ts`) :

- un lot (`PmtInf`) par type de séquence : **`FRST`** au premier prélèvement
  d'un mandat récurrent, **`RCUR`** ensuite, **`OOFF`** pour un mandat
  ponctuel. Les règles SEPA admettent `RCUR` dès le premier depuis 2016 ;
  `FRST` reste accepté partout et c'est le choix le plus sûr d'une banque à
  l'autre ;
- montants en décimal à point, écrits par arithmétique entière ; sommes de
  contrôle (`CtrlSum`) par lot et pour le fichier ;
- textes transcrits au jeu de caractères SEPA (accents retirés, `&` devenu
  `+`), identifiants contrôlés ; un BIC absent s'écrit `NOTPROVIDED` ;
- `EndToEndId` = numéro de facture, rendu par la banque en cas de rejet ;
  libellé du débiteur « Facture FA-… ».

Il contient les IBAN des débiteurs en clair : **il n'est pas stocké**. Il se
reconstruit à l'identique, à chaque téléchargement, depuis les paiements non
annulés de la remise (même identifiant, même date, même type de séquence, lu
dans les remises antérieures). La banque refuse un second fichier sous le même
identifiant, ce qui protège d'un double dépôt.

La date de prélèvement suit le jour du dépôt (au moins le lendemain) et reste
dans l'année. Le délai exact de remise et l'abonnement au service de
prélèvement sont **à voir avec la banque du centre**.

### L'export comptable

`/comptabilite` génère les écritures d'une période (un an au plus), au format
FEC fixé par l'ADR 027. Précisions :

- **Numéro d'écriture** : le numéro de la facture ou de l'avoir pour le
  journal des ventes ; `BQ-AAAAMMJJ-NNN` pour la banque (par jour de valeur,
  dans l'ordre de pointage). **Date de validation** = date d'écriture.
  Lettrage, `Montantdevise` et `Idevise` vides : tout est en euros. Une
  facture dans une autre devise fait refuser l'export.
- Un **montant négatif change de colonne** : une remise vient au débit du
  compte de remises ; `Debit` et `Credit` ne portent jamais de signe.
- **Compte auxiliaire** : celui de la fiche (`clients.accounting_code`), sinon
  dérivé de la raison sociale (`ATELIERDURAND`, 17 caractères au plus). Deux
  clients sur un même compte font refuser l'export, avec leurs noms. L'écran
  propose de fixer les comptes dérivés, pour qu'un changement de nom ne les
  change pas chez l'expert-comptable.
- Fichier en UTF-8 sans BOM, tabulations, fins de ligne CRLF, extension
  `.txt` (`ecritures-AAAA-MM-JJ-au-AAAA-MM-JJ.txt`). Débit = crédit, par
  écriture et au total, vérifié avant toute écriture au journal.
- Seuls les **paiements non annulés** entrent (ADR 027). Une période sans
  rien à exporter est refusée.
- **Le fichier n'est pas stocké** : le journal garde sa période, son nom, son
  nombre de lignes et son **empreinte SHA-256**. Au téléchargement, le fichier
  est reconstruit et comparé à l'empreinte ; si les données de la période ont
  changé depuis (paiement annulé, compte corrigé), le téléchargement est
  refusé et l'écran demande un nouvel export, à signaler à l'expert-comptable.
- Le plan de comptes se corrige en place depuis le même écran.

### La représentation EN 16931

`toEn16931()` décrit une facture ou un avoir émis par ses termes métier
(`BT-*`) et groupes (`BG-*`) : en-tête (BT-1, 2, 3, 5, 9, 10, 20, 24), notes
(BG-1), facture rectifiée d'un avoir (BG-3), vendeur et acheteur depuis les
instantanés figés (BG-4 à BG-8), période (BG-14), paiement (BG-16 : code 58
virement SEPA avec l'IBAN du centre, 59 prélèvement SEPA avec RUM et ICS, 1
non défini), remises de pied (BG-20), totaux (BG-22), ventilation de TVA
(BG-23), lignes (BG-25). Montants en décimal à point depuis les centimes,
taux en pourcentage depuis les points de base.

- La facture est décrite **telle qu'émise** : acomptes (BT-113) à zéro, net à
  payer = TTC. Les paiements ne la changent pas.
- Une **ligne de remise** (prix négatif) devient une remise de pied (BG-20) :
  la norme interdit un prix net négatif (BR-27). Une **remise ou un prorata**
  de ligne devient une remise de ligne (BG-27), pour que net = quantité × prix
  − remises tienne au centime.
- Unités (recommandation UN/ECE 20) : heure `HUR`, jour `DAY`, semaine `WEE`,
  mois `MON`, prestation `C62` ; la demi-journée, sans code, s'écrit `C62`.
- Mentions en notes codées (norme française) : `PMD` pénalités, `PMT`
  indemnité forfaitaire, `AAB` escompte, `TXD` option pour la TVA d'après les
  débits.
- Les **adresses électroniques** du vendeur et de l'acheteur (BT-34, BT-49)
  sont dérivées du SIREN, schéma `0225` de l'annuaire : **à confirmer** au
  raccordement.

`checkEn16931()` rend la liste des contrôles, chacun avec son terme, son
libellé et quoi faire : identité et adresses du vendeur et de l'acheteur,
**SIREN de l'acheteur exigé pour une entreprise française**, période, échéance
ou conditions (BR-CO-25), coordonnées de paiement, mentions, facture
rectifiée d'un avoir, lignes complètes, motif d'exonération hors taux normal,
et règles arithmétiques BR-CO-10 à BR-CO-17 au centime. La fiche de règlement
affiche le bilan et la liste ; la représentation se télécharge en JSON.
**Rien n'est envoyé.**

### Droits

Aucun droit nouveau : `facturation.consulter` (accueil et exploitant) lit les
règlements, les relances, la représentation EN 16931 et les mandats masqués ;
`paiements.gerer` pointe, annule, relance, enregistre et révoque les mandats,
prépare les remises ; `comptabilite.exporter` exporte et règle le plan de
comptes (ADR 019, ADR 027).

## Justification

**Marquer par un paiement.** Le schéma n'a pas de table de remises, et une
facture émise ne change plus (ADR 026). Un paiement `direct_debit` daté du
jour de prélèvement est ce que la banque créditera ce jour-là ; il fait sortir
la facture des prélevables, se lit dans l'export de banque à sa date, et le
rejet suit le chemin déjà prévu pour toute erreur de pointage.

**Reconstruire plutôt que stocker.** Le fichier de remise porte des IBAN en
clair : le stocker recréerait ce que le chiffrement des mandats évite. Le
fichier comptable, lui, se vérifie par son empreinte : le reconstruire et le
comparer dit si les données ont bougé, ce qu'un fichier stocké ne dirait pas.

**FRST plutôt que RCUR au premier prélèvement.** Les deux sont admis ; `FRST`
n'est refusé par aucune banque.

**Une représentation par termes de la norme.** Elle ne préjuge pas du format
de la plateforme (Factur-X, UBL, CII) : la conversion s'écrira au
raccordement, depuis un objet déjà contrôlé.

## Alternatives écartées

**Relances automatiques** : sans modèles éditables ni historique des envois
(R26, vague 3), un message parti seul ne se retrouverait pas.

**Stocker le fichier de remise** : IBAN en clair au repos.

**Marquer les factures exportées sans paiement** : rien dans le schéma figé
ne le permet, et la facture resterait « à régler » jusqu'au pointage manuel
de chaque prélèvement — avec le risque d'une seconde remise.

**Un export « tableur » (point-virgule)** : l'ADR 027 a retenu le FEC, que
tout logiciel comptable importe.

**Produire dès maintenant du Factur-X ou de l'UBL** : le choix appartient à la
plateforme agréée, pas encore choisie.

## Conséquences

- **Ce que le schéma ne porte pas encore** (à ajouter par une migration) :
  - un **journal des relances** (facture, palier, date, destinataires, texte,
    auteur) : aujourd'hui une relance n'est pas tracée, l'écran ne peut pas
    dire « relancée le … » ;
  - une **table des remises** de prélèvement (identifiant, date, statut,
    auteur), et le lien des paiements vers elle : aujourd'hui la remise
    n'existe que par la référence de ses paiements ;
  - la **date d'envoi à la plateforme** et son retour, au raccordement.
- `infra/chiffrer-documents.ts` doit rechiffrer `sepa_mandates` lors d'une
  rotation de clé (ADR 027) : sans elle, un mandat chiffré avec une clé
  retirée bloque la remise (message explicite, rien n'est marqué).
- **À valider par le centre** : les paliers et le ton des relances, le délai
  entre dépôt et prélèvement, le choix de marquer réglée à la remise.
- **À valider par l'expert-comptable** : la numérotation des écritures, les
  comptes auxiliaires dérivés, l'encodage UTF-8, l'export des seuls paiements
  non annulés (une annulation postérieure à un export demande un nouvel
  export), le traitement des remises en banque à la date de prélèvement.
