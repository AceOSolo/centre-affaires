# ADR 058 — Saisie du courrier : une photo = un pli, et l'expéditeur

**Date** : 2026-11-04
**Statut** : accepté — lot 2 de la recette du 04/11/2026
(`docs/recette/2026-11-04.md`) ; **amende l'ADR 055 § 5** (« Pas de pli créé
à partir des photos » est remplacé) ; complète les ADR 044 (tournée, saisie
groupée) et 057 (repère du pli) ; sans migration ni dépendance

## Contexte

Deux notes de la recette du 04/11/2026 sur la saisie du courrier :

1. « Nombre de photos = nombre de courriers reçus, sans double saisie :
   entreprise > type > photos > valider ». La saisie groupée
   (`/courrier/tournee/saisie`) était une grille entreprises × types où l'on
   tapait des nombres, puis où l'on joignait des photos ligne par ligne,
   contrôlées contre ces nombres (`checkPhotoCounts`, ADR 055 § 5). Compter
   les plis puis les photographier, c'est les saisir deux fois.
2. « Pouvoir préciser les expéditeurs (lecture auto) ». La saisie groupée
   écrivait `mail_items.sender = null` ; l'expéditeur ne se saisissait qu'au
   formulaire pli par pli (`/courrier/nouveau`), en texte libre.

Décisions du responsable produit, le même jour : **une photo = un pli** ; pour
l'expéditeur, **une liste avec suggestions, pas de lecture automatique** (ni
IA ni OCR).

## Décision

### 1. Le parcours : entreprise, type, photos, valider

L'écran de saisie groupée (`MailEntryForm`, `courrier/saisie-groupee-form.tsx`)
devient un parcours en quatre temps, sur une seule page :

1. **Entreprise** : une recherche au clavier (nom ou numéro de boîte), les
   domiciliés d'abord (`listMailRecipients`, inchangé). Six résultats au plus,
   en boutons radio de 44 px ; `Entrée` choisit le premier et passe au type.
2. **Type** : lettre, recommandé, colis, autre, en boutons radio avec leur
   icône et leur libellé.
3. **Photos** : « Prendre une photo » (appareil photo direct, sur écran
   tactile), « Choisir des photos » (plusieurs d'un coup) ou un glisser-déposer
   sur la zone. **Chaque photo crée un pli** de ce type pour cette entreprise.
   « **+ Pli sans photo** » ajoute un pli sans image (appareil absent, pli
   abîmé) ; sa photo s'ajoute ensuite depuis la tournée (ADR 055 § 4).
   « Entreprise suivante » ramène à la recherche ; on recommence pour
   l'entreprise ou le type suivant, dans le même envoi.
4. **Récapitulatif** : une carte par entreprise, « Atelier Durand : 2 lettres
   et 1 colis » (`groupEntry`, phrase de `mailKindsPhrase`, la même que les
   messages de fin de tournée). Chaque pli y montre sa photo (ou « Sans
   photo »), son type, un champ « Expéditeur » facultatif et « Retirer » ;
   « Retirer les N plis » retire ceux d'une entreprise.

Puis **Enregistrer les N plis dans la tournée** (`Ctrl`+`Entrée` au clavier),
dans un pied de page fixé, toujours à portée du pouce.

Ce qui ne change pas :

- **Tout ou rien** (ADR 055) : les photos sont déposées d'abord, chiffrées,
  puis plis et photos s'écrivent dans la même transaction ; si l'écriture
  échoue, les fichiers déposés sont effacés (`registerMailEntryWithEnvelopes`).
- **La compression dans le navigateur** (`preparePhoto`, ADR 055 § 3) :
  2 400 px, qualité 0,85, sans EXIF ni position GPS.
- **Les plafonds** : 500 plis et 20 Mo de photos par envoi, sous les 21 Mo
  d'un envoi.
- **La tournée et ses messages** (ADR 044) : les plis entrent fermés dans la
  tournée ouverte ; à sa fin, chaque entreprise reçoit « courrier reçu » avec
  le nombre et la nature de ses plis, jamais l'expéditeur, et les domiciliés
  sans pli « pas de courrier » (`mail_batch_received`, `mail_none`).
- **Un envoi refusé ne perd rien** : la saisie et ses photos restent à
  l'écran, le résumé d'erreurs mène au champ du pli en cause.

Supprimés : la grille de nombres, `parseMailCounts`, `checkPhotoCounts`,
`envelopeSlots`, `pairEnvelopes` et la colonne de photos par ligne
(`saisie-groupee-photos.tsx`).

**Envoi.** Chaque pli est un groupe de champs `pli.<clé>.client`, `.kind`,
`.sender` et `.photo` (`parseMailEntry`, `saisie-groupee-regles.ts`). Les
photos préparées sont gardées dans l'état de l'écran et ajoutées à l'envoi au
moment de valider : l'écran construit lui-même le `FormData`, dans l'ordre du
récapitulatif. La saisie groupée demande donc JavaScript ; sans lui, un avis
renvoie au formulaire pli par pli, qui s'en passe.

### 2. L'ordre des plis, et le repère du jour

Le repère de l'ADR 057 (« pli 3 sur 5 du 04/11 ») range les plis d'un jour
par heure de réception, puis par identifiant. Tous les plis d'un envoi ont la
même heure de réception : seul l'identifiant les départage.

Or un UUID v7 ne porte que la milliseconde : les identifiants tirés en rafale
dans une même milliseconde sortent **dans un ordre quelconque**. L'ancienne
saisie groupée en était déjà victime (le rang de deux lettres d'une même
saisie était tiré au sort) ; avec une photo par pli, le rang doit
correspondre à la photo.

Désormais :

- les plis sont créés **dans l'ordre du récapitulatif** : entreprise par
  entreprise, dans l'ordre où chacune est apparue, et, dans une entreprise,
  **dans l'ordre des photos** ;
- leurs identifiants sont tirés puis **triés** avant d'être attribués
  (`orderedIds`) : croissants, ils suivent cet ordre. Le pli 2 du
  récapitulatif d'une entreprise est le pli 2 de sa pile du jour, ou le
  suivant si elle avait déjà reçu des plis ce jour-là ;
- le tableau de la tournée lit ses plis dans ce même ordre (entreprise, heure,
  identifiant).

Le formulaire pli par pli n'est pas concerné : un pli par envoi.

### 3. L'expéditeur : saisie libre, suggestions, sans lecture automatique

**Où il se saisit** : sur chaque pli du récapitulatif ; au formulaire pli par
pli ; **après coup**, sur la fiche du pli (« Préciser l'expéditeur ») et dans
le tableau de la tournée (colonne « Expéditeur », champ et bouton sur chaque
ligne, sans quitter la page). Toujours facultatif. Un champ vidé l'efface.

**Les suggestions** sont une `<datalist>` native, filtrée par le navigateur
au fil de la frappe, au clavier comme au doigt. Elles viennent, dans cet
ordre et sans doublon (`senderSuggestions`, `suggestionsFor`,
`courrier/expediteurs.ts`) :

1. les expéditeurs déjà saisis **pour l'entreprise** du pli, les plus
   fréquents d'abord (dix au plus) ;
2. ceux **du centre**, toutes entreprises confondues (soixante au plus) ;
3. une **liste de départ** (`STARTING_SENDERS`) : URSSAF, Impôts / DGFiP, CAF,
   France Travail, Assurance Maladie, La Poste, greffe et tribunaux,
   commissaire de justice, INPI, ANTAI, les banques courantes, les fournisseurs
   d'énergie et de télécoms.

Elles se calculent sur `mail_items.sender` (`findSenderSuggestions`), sans
table à part : les plis des deux dernières années, hors plis retirés ; un
expéditeur anonymisé avec la fiche de son client (ADR 040) n'existe plus.

**Normalisation**, à chaque écriture (`readSender`, `canonicalSender`) :

- espaces de tête et de fin ôtés, espaces intérieurs ramenés à un seul,
  caractères de contrôle retirés ; 120 caractères au plus — au-delà, c'est une
  note, qui a son champ ;
- une saisie qui ne diffère d'un expéditeur connu que par la casse, les
  accents ou la ponctuation prend **son écriture** : celle de la liste de
  départ, sinon la plus employée au centre. « urssaf » s'enregistre
  « URSSAF », « impots - dgfip » « Impôts / DGFiP » : les suggestions ne se
  dédoublent pas.

**Refus** (`updateMailSender`) : un pli retiré garde sa trace telle quelle
(décision 6) ; un expéditeur anonymisé ne se ressaisit pas (la base le
refuserait aussi, `mail_items_sender_anonymized`). Le message le dit en
français.

**Le client** voit l'expéditeur dans son espace dès qu'il est rempli, comme
avant, sans nouveau message. Les suggestions, elles, ne sortent pas du
back-office (`courrier.gerer`).

### 4. Téléphone, tablette, clavier

- vérifié à 375 px : une colonne, rien ne défile de côté (un nom d'entreprise
  long est tronqué dans sa ligne) ; deux colonnes sur ordinateur, le
  récapitulatif à droite ;
- cibles de 44 px : choix d'entreprise et de type, boutons de photo, « + Pli
  sans photo », « Retirer », « Enregistrer » ; champs en 16 px sur téléphone,
  pour que le navigateur n'agrandisse pas la page à la saisie ;
- au clavier : recherche, `Entrée`, flèches sur le type, `Tab` jusqu'aux
  photos, `Ctrl`+`Entrée` ; le focus revient au récapitulatif quand un pli en
  est retiré ; chaque ajout ou retrait est annoncé (`aria-live`) ;
- libellés visibles partout ; dans le tableau de la tournée, le champ est
  nommé par l'en-tête « Expéditeur » et la ligne du pli.

## Justification

**Une photo = un pli** supprime la double saisie : le nombre de plis est le
nombre de photos, il ne se tape plus, et la règle « jamais plus de photos que
de plis » n'a plus d'objet. Le « + Pli sans photo » couvre le seul cas où la
photo manque.

**Trier les identifiants d'un envoi** est le changement minimal qui rend le
repère fidèle à l'ordre des photos : ni colonne de rang, ni migration, ni
modification du générateur d'identifiants commun à toutes les tables.

**Des suggestions plutôt qu'une lecture automatique** : décision du
responsable. Une `<datalist>` est native, accessible, sans dépendance ; les
suggestions viennent de ce que l'accueil a déjà saisi, donc de ce qui arrive
vraiment au centre.

**Construire l'envoi dans l'écran** plutôt que de garder un champ de fichier
par pli : les photos vivent déjà dans l'état de l'écran (compression, aperçu,
retrait) ; les remettre dans des champs cachés à chaque ajout ou retrait
(`DataTransfer`) multipliait les cas, et le formulaire de saisie demandait
déjà JavaScript pour garder les photos.

## Alternatives écartées

- **Lecture automatique de l'expéditeur** (OCR, IA) : écartée par le
  responsable. Elle demanderait un service ou une dépendance, enverrait les
  photos d'enveloppes à un traitement de plus (RGPD), et se tromperait sur
  les enveloppes manuscrites.
- **Une table des expéditeurs** : rien à y stocker que `mail_items.sender` ne
  dise déjà ; elle se désynchroniserait des plis retirés et anonymisés.
- **Une liste déroulante maison** (combobox ARIA) : plus de code et
  d'accessibilité à tenir que la `<datalist>`, pour le même service.
- **Garder la grille de nombres à côté** : deux façons de faire la même
  chose, et la double saisie demandée en moins reste possible.
- **Un générateur d'UUID v7 monotone** (compteur dans la milliseconde,
  RFC 9562 § 6.2) : il réglerait l'ordre partout, mais touche un utilitaire
  transverse utilisé par toutes les insertions. À reprendre si un autre
  écran insère en rafale des lignes dont l'ordre compte.
- **Changer le type d'un pli depuis le récapitulatif** : on le retire et on
  le reprend ; à ajouter si l'exploitation le demande.

## Conséquences

- L'ADR 055 § 5 est amendé : les photos créent les plis ; plus de colonne de
  photos ni de contrôle du nombre de photos.
- Le repère du jour (ADR 057) suit l'ordre des photos d'une saisie.
- L'expéditeur se précise à la saisie, au formulaire pli par pli, sur la
  fiche et dans la tournée, normalisé et ramené à l'écriture connue.
- Aucune migration, aucune variable d'environnement, aucune dépendance.
- Tests :
  - `saisie-groupee-regles.test.ts` : lecture d'un envoi (un pli par photo,
    pli sans photo, champs étrangers, refus d'un pli sans entreprise ou de
    deux photos pour un pli), récapitulatif par entreprise, identifiants
    triés ;
  - `expediteurs.test.ts` : normalisation, écriture connue, ordre et
    dédoublonnage des suggestions, liste de départ ;
  - `saisie-groupee.db.test.ts` : plis, expéditeurs et photos dans la
    tournée, **rang du jour dans l'ordre des photos** (vérifié en défaut sans
    le tri), fin de tournée inchangée, tout ou rien avec un faux stockage
    (entreprise archivée, photo qui ne se dépose pas) ;
  - `expediteurs.db.test.ts` : suggestions de l'entreprise puis du centre,
    plis retirés et anonymisés ignorés, expéditeur précisé, corrigé, effacé,
    refusé sur un pli retiré ou anonymisé.
