# ADR 055 — Photos du courrier à chaque étape du back-office

**Date** : 2026-10-22 (§ 5 ajouté le même jour)
**Statut** : accepté — complète les ADR 015 (numérisations), 044 (tournée,
pages comptées, saisie groupée) et 037 (numérisation demandée)

## Contexte

Demande de l'exploitation du 22/10/2026 : dans le parcours de domiciliation,
pouvoir ajouter des photos des courriers **à chaque étape côté back-office**.

Jusqu'ici, chaque étape avait un champ de fichier unique (PDF, JPEG ou PNG de
10 Mo), sans raccourci vers l'appareil photo :

- l'enveloppe ne se déposait qu'à l'enregistrement du pli. Un pli compté en
  saisie groupée (ADR 044), ou enregistré sans photo, n'en avait jamais ;
- le contenu, à l'ouverture ou pour une numérisation demandée, tenait en un
  fichier. Une lettre de trois pages photographiée au téléphone, soit trois
  photos, ne se déposait pas ;
- une photo de téléphone (3 à 12 Mo) frôlait ou dépassait la limite.

## Décision

### 1. Étapes couvertes

| Étape | Écran | Photos |
|---|---|---|
| Enregistrement d'un pli | `/courrier/nouveau` | enveloppe (une) et contenu (plusieurs) |
| Saisie groupée | `/courrier/tournee/saisie` | colonne « Photos » : une photo d'enveloppe par pli, sur la ligne de l'entreprise (§ 5) |
| Tournée | `/courrier/tournee` | colonne « Enveloppe » : « Photo jointe », ou lien « Ajouter la photo » vers la fiche |
| Fiche du pli | `/courrier/[id]` | « Ajouter la photo de l'enveloppe », tant que le pli n'en a pas et n'est pas retiré, quel que soit son état |
| Ouverture | fiche du pli | contenu (plusieurs) |
| Numérisation demandée | fiche du pli | pages demandées (plusieurs) |

La réexpédition et le refus ne reçoivent pas de photo (§ Alternatives).

### 2. Plusieurs photos font un seul PDF, une page par photo

Une étape garde **un seul document**. `readScans` (`fichiers.ts`) garde tel
quel un fichier seul. Plusieurs photos JPEG sont réunies par `photosToPdf`
(`photos-pdf.ts`) en un PDF d'une page par photo, dans l'ordre de l'envoi :

- écrit sans bibliothèque, chaque photo recopiée telle quelle (`DCTDecode`),
  rien n'est décodé côté serveur ;
- chaque page à la taille d'une page A4 sur son grand côté ;
- l'orientation EXIF de l'appareil donne la rotation de la page (`/Rotate`).

Un PDF se joint seul, sans autre fichier. Les limites sont de 30 photos et de
10 Mo à elles toutes, comme un fichier seul : un enregistrement porte encore
au plus deux fois 10 Mo, sous le plafond de 21 Mo (ADR 015, ADR 051).

Le nombre de pages est lu dans ce PDF comme dans tout autre (`pages.ts`,
ADR 044). Une photo compte donc pour une page.

### 3. Dans le navigateur

`PhotosField` (`photos-field.tsx`) remplace le champ de fichier des cinq
écrans :

- **sur écran tactile** (`pointer: coarse`), un bouton « Prendre une
  photo » ouvre directement l'appareil (`capture="environment"`), puis
  devient « Photographier la page suivante » ;
- les pages s'ajoutent une à une, avec un aperçu, un numéro et un bouton
  « Retirer » ;
- chaque photo est compressée avant l'envoi par `compressPhoto` (ADR 039),
  réglée pour qu'une lettre se lise : 2 400 px sur le grand côté, qualité
  0,85. Elle pèse alors quelques centaines de kilo-octets, et ses métadonnées
  EXIF, dont la position GPS, ne partent pas ;
- le formulaire ne part pas tant qu'une photo se prépare (`setCustomValidity`).

Le champ reste un vrai champ du formulaire. Sans JavaScript, il envoie ce qui
y est choisi, et le serveur fait le reste.

### 4. Enveloppe ajoutée après coup

`addEnvelope` (`queries.ts`) dépose d'abord le fichier, puis écrit la ligne
sous verrou du pli : un retrait simultané attend. Une seule enveloppe par pli,
tenue par l'unicité existante `mail_scans_item_side_key`. Deux dépôts
simultanés n'en font pas deux : le second reçoit « Ce courrier a déjà une
photo de l'enveloppe ».

Le client voit la photo aussitôt dans son espace, **sans nouveau message** :
il a déjà été prévenu à la fin de la tournée.

### 5. Photos dans la saisie groupée

Précision de l'exploitation, le même jour : la saisie groupée est l'endroit
où joindre les photos. « Entreprise Y : 2 courriers » se saisit avec ses deux
photos d'enveloppe, sur la même ligne.

- **Une photo par pli, jamais plus.** Chaque ligne a sa colonne « Photos »
  (champ `p.<clientId>`). Les photos vont aux plis de la ligne dans l'ordre
  des colonnes (lettres, recommandés, colis, autres), puis dans l'ordre où
  elles ont été jointes (`envelopeSlots`, `pairEnvelopes`). Quand une ligne
  mêle plusieurs types, chaque miniature dit à quel pli elle va
  (« Lettre 2 », « Colis »).
- **Pas de pli créé à partir des photos.** Plus de photos que de plis bloque
  l'envoi, sur la ligne et en pied de formulaire (`checkPhotoCounts`, tenu
  aussi par le serveur). Moins de photos est permis : les plis restants
  attendent la leur, que la tournée signale.
- **Tout ou rien.** Les photos sont déposées d'abord, puis plis et photos
  s'écrivent dans la même transaction. Si l'enregistrement échoue, les
  fichiers déposés sont effacés (`registerMailCountsWithEnvelopes`).
- **20 Mo de photos par envoi**, sous le plafond de 21 Mo. Une photo
  d'enveloppe compressée pèse quelques centaines de kilo-octets. Au-delà de
  20 Mo, l'écran demande d'enregistrer la tournée en deux envois.
- **Un envoi refusé ne perd pas les photos.** Elles sont gardées au-dessus du
  tableau, qui se remonte après un refus.
- **Sur téléphone**, la colonne « Entreprise » reste fixée à gauche pendant
  que le tableau défile jusqu'aux photos.

## Justification

Un document par étape est ce que tout le reste lit :

- le compteur de pages (ADR 044) ;
- le relevé, qui prend le contenu de l'ouverture et celui de chaque demande ;
- l'affichage côté client ;
- le chiffrement, le journal d'accès et la purge (ADR 020).

Réunir les photos en un PDF ne change donc rien en aval : **ni migration, ni
nouvelle dépendance, ni changement du relevé**. Le client, lui, ouvre un seul
document par étape, comme pour un scan.

## Alternatives écartées

- **Plusieurs lignes `mail_scans` par étape.** Il aurait fallu lever
  l'unicité, additionner les pages au relevé et dans le lot de facturation en
  sommeil, et regrouper les fichiers côté client. C'est une migration et une
  reprise de la facturation pour un besoin d'affichage.
- **Une bibliothèque PDF** (`pdf-lib`, `jsPDF`) : une dépendance pour
  l'équivalent d'environ 150 lignes, sans décodage d'image.
- **Assembler le PDF dans le navigateur** : la règle aurait vécu côté client,
  sans effet sans JavaScript, et hors de portée des tests du serveur.
- **Une photo à la réexpédition** (preuve d'envoi, récépissé) : ce n'est ni
  l'enveloppe ni le contenu du pli. Il faudrait une nouvelle nature de
  document, montrée au client. À reprendre si l'exploitation le demande.
- **Ajouter des pages à un contenu déjà déposé** : ce contenu est compté et
  peut être au relevé. Une page oubliée ne se rattrape donc pas sur la fiche.
  À reprendre si le besoin se confirme.

## Conséquences

- L'aide du nombre de pages dit qu'une photo compte pour une page.
- La photo de l'enveloppe reste facultative (R19, « à rendre obligatoire ? »
  reste une question pour l'exploitation).
- La compression du courrier réutilise celle des états des lieux, avec des
  réglages passés en paramètres : `compressPhoto(file, { maxEdge, quality })`.
- Les tests portent sur l'assemblage (`photos-pdf.test.ts` : dimensions,
  orientation, table des références), la lecture des champs
  (`fichiers.test.ts`) et l'enveloppe ajoutée après coup
  (`courrier.db.test.ts`). Un PDF produit a été relu par pdf.js, sans
  avertissement.
