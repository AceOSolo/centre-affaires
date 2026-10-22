# ADR 056 — Des PDF avec les photos des états des lieux

**Date** : 2026-10-22
**Statut** : accepté — amende l'ADR 039 (types des pièces d'un état des
lieux, dimensions facultatives) ; migration 0007

## Contexte

Demande de l'exploitation du 22/10/2026 : dans tous les espaces « États des
lieux », pouvoir ajouter des PDF et des images. Le menu en compte deux, sous
Bureaux et sous Camion (ADR 053), qui mènent aux mêmes écrans.

Jusqu'ici, un état des lieux ne recevait que des photos (JPEG, WebP, PNG),
compressées dans le navigateur (ADR 039). Un PDF était refusé à trois
endroits :

- dans le champ de fichier (`accept="image/*"`) ;
- au serveur (`readPhoto`) ;
- en base : CHECK sur le type, et largeur et hauteur obligatoires.

Or un inventaire, un plan, un constat ou un relevé de compteur arrive souvent
en PDF.

## Décision

### 1. Un PDF est une pièce jointe comme une photo

Il prend place dans la même table, `inspection_photos`, pour ne pas dupliquer
ce qu'une photo a déjà :

- le chiffrement et les journaux (ADR 020) ;
- la purge et le rechiffrement (ADR 041) ;
- les gardes de la base : brouillon seulement, figé à la clôture (`CA010`),
  champ du modèle vérifié (`CA011`), jamais supprimé.

Le nom de la table reste, même si elle porte aussi des documents.

Migration 0007 :

- `width` et `height` deviennent facultatives ;
- `inspection_photos_content_type_allowed` admet `application/pdf` ;
- `inspection_photos_dimensions_valid` : une photo a ses dimensions (1 à
  10 000 pixels), un PDF n'en a pas.

La contrainte est écrite en expression booléenne : MySQL refuse un `case`
dans un CHECK, et drizzle-kit l'aurait recopié tel quel.

### 2. Au serveur

`readPhoto` (`photos.ts`) reconnaît un PDF à ses premiers octets (`%PDF-`),
jamais à ce que déclare le navigateur. Il le garde tel quel, 10 Mo au plus
comme une photo. Le fichier est servi comme les autres pièces, par la route
qui journalise, avec son type (`application/pdf`) et un nom en `.pdf`.

### 3. À l'écran

- **Saisie d'un brouillon.** Chaque champ du formulaire et les « Photos et
  documents d'ensemble » ont leur bouton « Ajouter des photos ou des PDF ».
  Une photo est compressée avant l'envoi, un PDF part tel quel. Un PDF a sa
  légende et son retrait comme une photo.
- **Fiche close, espace client.** Un PDF s'affiche comme une carte « Document
  PDF » de la même taille qu'une vignette, qui l'ouvre dans un nouvel
  onglet.
- **Vue imprimable.** Un PDF n'est pas recopié dans l'impression. Il y figure
  par sa légende et la mention « consultable dans l'application ».

## Justification

Une table de documents à part aurait refait les triggers de statut, le
journal d'accès, la purge et le rechiffrement, pour une seule différence :
l'absence de dimensions. Assouplir deux contraintes suffit, et tout le reste
s'applique tel quel aux PDF.

## Alternatives écartées

- **Une table `inspection_documents`** : la même chose en double (voir
  ci-dessus).
- **Convertir le PDF en images** : il faudrait une bibliothèque de rendu, et
  le document d'origine serait perdu.
- **Ajouter des pièces après la clôture** (un exemplaire signé sur papier, par
  exemple) : contraire au principe de l'ADR 039, un état des lieux clos est
  figé et c'est ce qui en fait une preuve. À reprendre si l'exploitation le
  demande, sous la forme d'annexes datées qui ne modifient pas l'état des
  lieux.
- **Laisser le client joindre des pièces depuis son espace** : la base refuse
  toute écriture du client sur un état des lieux. Ses réserves restent du
  texte (ADR 039).

## Conséquences

- La vue imprimable ne reproduit pas le contenu d'un PDF.
- Le libellé « photos » devient « photos et documents » partout où les deux
  peuvent figurer : formulaire, fiche, espace client, conservation.
- La purge au terme de la conservation s'applique aux PDF comme aux photos
  (`tenants.inspection_photo_retention_months`).
- Tests :
  - `photos.test.ts` : un PDF est accepté sans dimensions, un HTML qui se dit
    PDF reste refusé ;
  - `etats-des-lieux.db.test.ts` : un PDF sans dimensions est accepté, une
    photo sans dimensions ou un PDF avec dimensions sont refusés, et un PDF
    est figé à la clôture.
