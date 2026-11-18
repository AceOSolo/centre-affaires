# ADR 073 — Photos et vidéos des annonces, en galerie qui défile

**Date** : 2026-11-13
**Statut** : accepté — solde le « Reste à faire : les photos » de l'ADR 011.
Sans migration.

## Contexte

Les annonces (ADR 011) présentaient un titre, un texte, les tarifs et les
disponibilités, mais aucune image : la colonne `listings.photos` attendait un
téléversement qui n'avait jamais été construit. Les seules photos du site
public étaient celles du catalogue de départ, rangées avec le code
(`public/photos/`, `infra/catalogue.mjs`) : en changer demandait un
développeur et une mise en ligne.

Le centre demande que l'équipe ajoute elle-même des photos **et des vidéos** à
chaque annonce, et que le public les voie défiler.

## Décision

### Depuis la fiche de l'annonce

Sous le formulaire de l'annonce (`/ressources/annonces/<ressource>`, droit
`ressources.gerer`), un bloc « Photos et vidéos » : ajout de plusieurs
fichiers d'un coup, ordre (« Mettre en premier », « Avancer », « Reculer »),
description de chaque média (lue par les lecteurs d'écran ; à défaut, le titre
de l'annonce et le rang) et retrait avec confirmation. Douze médias au plus.
Le bloc n'apparaît qu'une fois l'annonce enregistrée.

- **Photos** : JPEG, PNG ou WebP, réduites dans le navigateur avant de partir
  (2 400 px de grand côté, JPEG 0,85), avec le même code que les états des
  lieux (`compression.ts`). 10 Mo au plus à l'arrivée.
- **Vidéos** : MP4 ou WebM, envoyées telles quelles, **20 Mo au plus** — le
  plafond d'un envoi est de 21 Mo (`next.config.ts`, nginx). Une vidéo
  QuickTime (`.mov` d'iPhone) est refusée avec la marche à suivre : elle ne se
  lit ni dans Chrome ni dans Firefox.
- Un fichier par envoi : une connexion qui flanche ne perd que celui en cours.
- Le type est lu dans les octets (`annonces-medias.ts`), jamais dans ce que
  déclare le navigateur : le fichier est servi au public avec ce type.

### Rangement : la colonne existante, en JSON

`listings.photos` garde son nom en base et devient `media` côté code : une
liste ordonnée d'objets (identifiant, photo ou vidéo, type, clé de stockage,
poids, dimensions, description). Même raisonnement que pour les points forts
(ADR 011) : une liste courte, réordonnée d'un bloc, sans requête dessus. Toute
modification verrouille la ligne de l'annonce (`SELECT … FOR UPDATE`) : deux
ajouts simultanés ne s'effacent pas et ne dépassent pas la limite.

Les fichiers vont dans le stockage S3 européen du centre, sous
`annonces/<centre>/<annonce>/<média>.<ext>`.

### Servis par l'application, publics, sans journal

Route `/medias/annonces/<annonce>/<média>`, hors du filtre `proxy.ts`.

- Une annonce visible du public (les trois conditions de l'ADR 011) : média
  servi à tous, gardé un an en cache (`immutable` : un média ne change jamais
  sous le même identifiant).
- Un brouillon : seule l'équipe qui gère les annonces le voit, sans cache.
- Les vidéos se servent **par plages d'octets** (`Range`, réponse 206) : Safari
  ne lit pas une vidéo autrement. `readObjectStream()` est ajoutée à
  `stockage.ts`, pour ces seuls fichiers publics.

Pas de chiffrement ni de journal de consultation : une photo de vitrine est
faite pour être vue. Pas de `deleted_at` non plus (décision 6) : retirer une
photo de vitrine n'efface aucune trace utile, contrairement à un contrat ou à
un état des lieux. Le média quitte la liste, puis le fichier est effacé du
stockage ; un échec d'effacement laisse un fichier que plus rien n'affiche.

### Une galerie qui défile, à la manière du W3C

En tête de la page publique de l'annonce (`galerie-annonce.tsx`), sans
bibliothèque :

- glissement au doigt par le défilement natif du navigateur (`scroll-snap`),
  flèches précédent / suivant (44 px), compteur « 2 / 5 », vignettes cliquables ;
- **défilement automatique toutes les 6 s**, selon le motif « carrousel » de
  l'APG du W3C (WCAG 2.2.2) : bouton « Pause » visible ; pause au survol, au
  focus clavier, hors de l'écran, onglet caché et tant qu'une vidéo joue ;
  arrêt définitif dès que le visiteur navigue lui-même ; **aucun mouvement**
  si le visiteur a demandé moins d'animations (`prefers-reduced-motion`) ;
- changements annoncés aux lecteurs d'écran seulement quand le défilement est
  arrêté ;
- vidéos avec leurs commandes, jamais lancées d'office, mises en pause quand on
  passe au média suivant.

Dans le catalogue (`/annonces`), la première **photo** sert de couverture de
la carte.

## Justification

**Pourquoi des fichiers hébergés plutôt qu'un lien YouTube.** Une vidéo
intégrée depuis YouTube transmet l'adresse IP de chaque visiteur à Google,
ce que la règle d'hébergement européen écarte déjà pour les polices
(`CLAUDE.md`). Servie par l'application, la vidéo reste dans le stockage du
centre.

**Pourquoi 20 Mo.** C'est le plafond d'un envoi déjà réglé dans l'application
et dans nginx. Le relever pour les seules vidéos voudrait une route d'envoi à
part et une règle nginx de plus en production, pour un besoin qui reste à
mesurer : une visite d'une minute en 720p tient dans 20 Mo.

**Pourquoi un défilement automatique malgré « l'animation n'est pas
décorative ».** Le centre le demande : il montre qu'il y a d'autres photos à
voir. Il reste soumis à la préférence du visiteur, se met en pause dès qu'on
s'y intéresse et s'arrête dès qu'on le pilote.

## Alternatives écartées

**Une table `listing_media`.** Plus « relationnelle », mais une jointure sur
chaque page publique, une migration et des triggers de plus, pour une liste
de douze éléments sans requête dessus. La colonne existait, vide, pour cela.

**Les photos sur la ressource** (`resources.photo_path`). La photo unique de
la ressource reste celle des cartes de la page d'accueil, posée par le
catalogue ; la vitrine, avec sa galerie, est l'annonce (ADR 011).

**Une bibliothèque de carrousel.** Le défilement natif fait le glissement ;
le reste tient en un composant. Pas de dépendance nouvelle.

## Conséquences

Positives : l'équipe illustre ses annonces sans développeur ni mise en ligne ;
le public voit une galerie qui se feuillette au doigt, lisible au clavier et
aux lecteurs d'écran.

Négatives : 20 Mo par vidéo ; pas de vignette d'aperçu calculée pour une
vidéo (le navigateur montre sa première image) ; la photo des cartes de la
page d'accueil vient toujours du catalogue (`resources.photo_path`), pas de
l'annonce.

Essais : `annonces-medias.test.ts` (types lus dans les octets, tailles, ordre,
descriptions, plages d'octets). Parcours vérifié en local de bout en bout
(ajout de quatre photos et d'une vidéo, refus d'un `.mov`, ordre, description,
publication, défilement, arrêt à la main, vidéo servie en 206, 375 px sans
défilement horizontal, animations réduites).
